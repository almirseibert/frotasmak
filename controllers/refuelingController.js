// controllers/refuelingController.js
const db = require('../database');
const crypto = require('crypto');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { recalcFuelAverage } = require('../utils/recalcFuelAverage');
// Travas soberanas de emissão de ordem. Vivem em utils/ para que o aceite
// automático por IA avalie exatamente as MESMAS regras deste controller,
// em vez de reimplementá-las e divergir no primeiro ajuste.
const {
    checkLeituraBloqueada,
    checkOrcamentoBloqueado,
    checkOrdemAbertaDuplicada,
    checkOperadorPlaceholder,
} = require('../utils/regrasAbastecimento');
const { ymdBRT } = require('../utils/dateBRT');
const { notifyComboioEntrada } = require('../services/orderNotifier');
const fuelCredits = require('../utils/partnerFuelCredits');
const { dispatchAsync, insertLog } = require('../services/notificationDispatcher');
const { sendEmail } = require('../services/emailService');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');

// ─── Auto-envio da ordem ao posto (WhatsApp/E-mail) ─────────────────────────
// Reusa o orderNotifier (mesmo pipeline da entrada de comboio): gera o PDF
// uma vez, anexa por e-mail e manda link pelo WhatsApp — respeitando os
// checkboxes envia_por_whatsapp / envia_por_email do partner. Fire-and-forget.
const dispatchOrderToPartner = async (refuelingId, opts = {}) => {
    try {
        const [[r]] = await db.execute(
            `SELECT r.id, r.authNumber, r.data, r.partnerId, r.partnerName,
                    r.fuelType, r.litrosLiberados, r.isFillUp, r.pricePerLiter, r.invoiceNumber,
                    r.needsArla, r.isFillUpArla, r.litrosLiberadosArla,
                    r.outros, r.outrosValor,
                    r.odometro, r.horimetro, r.createdBy,
                    v.registroInterno, v.placa, v.marca, v.modelo, v.tipo,
                    e.nome AS employeeName,
                    o.nome AS obraName
             FROM refuelings r
             LEFT JOIN vehicles  v ON v.id = r.vehicleId
             LEFT JOIN employees e ON e.id = r.employeeId
             LEFT JOIN obras     o ON o.id = r.obraId
             WHERE r.id = ?`, [refuelingId]
        );
        if (!r) return;

        const isKm = r.odometro && parseFloat(r.odometro) > 0;
        const readingLabel = isKm ? 'Odômetro' : (r.horimetro ? 'Horímetro' : 'Leitura');
        const readingValue = isKm ? `${r.odometro} Km` : (r.horimetro ? `${r.horimetro} h` : 'N/A');

        let issuer = 'Sistema MAK Frotas';
        try {
            const cb = typeof r.createdBy === 'string' ? JSON.parse(r.createdBy) : r.createdBy;
            issuer = cb?.userEmail || cb?.name || cb?.email || issuer;
        } catch (_) {}

        notifyComboioEntrada({
            partnerId: r.partnerId,
            comboioVehicleId: null,
            order: {
                tipo: 'abastecimento',
                authNumber: r.authNumber,
                date: r.data,
                fuelType: r.fuelType,
                liters: r.litrosLiberados,
                isFillUp: !!r.isFillUp,
                pricePerLiter: r.pricePerLiter,
                invoiceNumber: r.invoiceNumber,
                partnerName: r.partnerName,
                registroInterno: r.registroInterno || '',
                vehicleLabel: `${r.registroInterno || ''} - ${r.placa || ''}`.trim(),
                vehicleModelo: `${r.marca || ''} ${r.modelo || ''}`.trim(),
                employeeName: r.employeeName || '',
                obraName: r.obraName || '',
                readingLabel,
                readingValue,
                needsArla: !!r.needsArla,
                isFillUpArla: !!r.isFillUpArla,
                litrosLiberadosArla: r.litrosLiberadosArla,
                outros: r.outros,
                outrosValor: r.outrosValor,
                issuer,
                isAlteracao: !!opts.isAlteracao,
            },
        }).then(result => {
            console.log(`[orderNotifier] ordem #${r.authNumber}:`, JSON.stringify(result));
        }).catch(err => {
            console.warn(`[orderNotifier] ordem #${r.authNumber} falha geral:`, err.message);
        });
    } catch (e) {
        console.warn('[dispatchOrderToPartner] erro:', e.message);
    }
};

// --- CONFIGURAÇÃO NODEMAILER (lazy — criado apenas quando necessário) ---
let _transporter = null;
const getTransporter = () => {
    if (!_transporter) {
        _transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST || 'smtp.gmail.com',
            port: process.env.EMAIL_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
            tls: { rejectUnauthorized: false }
        });
    }
    return _transporter;
};

// --- CONFIGURAÇÃO MULTER ---

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '../public/uploads/orders');
        if (!fs.existsSync(uploadPath)){
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Nome único e seguro para o arquivo
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'order-' + uniqueSuffix + '.pdf');
    }
});

const upload = multer({ storage: storage });

// --- HELPERS ---
const safeNum = (val, returnZero = false) => {
    if (val === null || typeof val === 'undefined' || val === '') {
        return returnZero ? 0 : null;
    }
    const num = parseFloat(val);
    return isNaN(num) ? (returnZero ? 0 : null) : num;
};

const parseJsonSafe = (field) => {
    if (!field) return null;
    if (typeof field === 'object') return field;
    try {
        return JSON.parse(field);
    } catch (e) {
        return null;
    }
};

const parseRefuelingRows = (rows) => {
    return rows.map(row => ({
        ...row,
        createdBy: parseJsonSafe(row.createdBy),
        confirmedBy: parseJsonSafe(row.confirmedBy),
        editedBy: parseJsonSafe(row.editedBy),
        litrosAbastecidos: row.litrosAbastecidos ? parseFloat(row.litrosAbastecidos) : 0,
        litrosAbastecidosArla: row.litrosAbastecidosArla ? parseFloat(row.litrosAbastecidosArla) : 0,
        pricePerLiter: row.pricePerLiter ? parseFloat(row.pricePerLiter) : 0,
        pricePerLiterArla: row.pricePerLiterArla ? parseFloat(row.pricePerLiterArla) : 0,
        outrosValor: row.outrosValor ? parseFloat(row.outrosValor) : 0,
        outrosGeraValor: !!row.outrosGeraValor,
        invoiceNumber: row.invoiceNumber || null,
        // Ordem reservada — só chega até aqui para o próprio emissor (ver getAllRefuelings)
        isHidden: !!row.is_hidden,
        hiddenByUserId: row.hidden_by_user_id || null,
        revealAt: row.reveal_at || null
    }));
};

// --- ATUALIZAÇÃO DE DESPESAS MENSAIS ---
const updateMonthlyExpense = async (connection, obraId, partnerId, fuelType, dateInput) => {
    if (!obraId || !partnerId || !fuelType || !dateInput) return;

    const [obraCheck] = await connection.execute('SELECT id FROM obras WHERE id = ?', [obraId]);
    if (obraCheck.length === 0) return; 

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59);

    const [partners] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';

    const querySum = `
        SELECT SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) +
            (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
            COALESCE(outrosValor, 0)
        ) as total
        FROM refuelings
        WHERE obraId = ?
          AND partnerId = ?
          AND fuelType = ?
          AND data BETWEEN ? AND ?
          AND status = 'Concluída' -- Importante: Somar apenas concluídas para não duplicar valores pendentes
    `;

    const [rows] = await connection.execute(querySum, [obraId, partnerId, fuelType, startDate, endDate]);
    const totalAmount = rows[0]?.total || 0;

    const monthName = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const description = `Combustível: ${fuelType} - ${partnerName} (${monthName})`;

    const [existingExpense] = await connection.execute(
        'SELECT id FROM expenses WHERE obraId = ? AND description = ?',
        [obraId, description]
    );

    if (totalAmount > 0) {
        if (existingExpense.length > 0) {
            await connection.execute(
                'UPDATE expenses SET amount = ?, weekStartDate = ? WHERE id = ?',
                [totalAmount, startDate, existingExpense[0].id]
            );
        } else {
            const newId = crypto.randomUUID();
            await connection.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, partnerName, fuelType)
                 VALUES (?, ?, ?, ?, 'Combustível', NOW(), ?, ?, ?)`,
                [newId, obraId, description, totalAmount, startDate, partnerName, fuelType]
            );
        }
    } else {
        if (existingExpense.length > 0) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense[0].id]);
        }
    }
};

// --- CONTROLLER DE UPLOAD ---
const uploadOrderPdf = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }
        const fileUrl = `/uploads/orders/${req.file.filename}`;
        // Retorna também o filename para facilitar o envio de email (localizar no disco)
        res.json({ url: fileUrl, filename: req.file.filename });
    } catch (error) {
        console.error('Erro no upload do PDF:', error);
        res.status(500).json({ error: 'Falha ao salvar PDF no servidor.' });
    }
};

// --- NOVO: CONTROLLER DE ENVIO DE EMAIL ---
const sendOrderEmail = async (req, res) => {
    const { orderData, partnerEmail, pdfFilename, pdfUrl } = req.body;

    if (!partnerEmail) {
        return res.status(400).json({ error: 'Email do destinatário não informado.' });
    }

    try {
        // Tenta localizar o arquivo físico para anexo
        // O pdfFilename vem do retorno do uploadOrderPdf
        let filenameToUse = pdfFilename;
        if (!filenameToUse && pdfUrl) {
            filenameToUse = path.basename(pdfUrl);
        }

        const filePath = path.join(__dirname, '../public/uploads/orders', filenameToUse);
        
        let attachments = [];
        if (fs.existsSync(filePath)) {
            attachments.push({
                filename: `Autorizacao_${orderData.authNumber}.pdf`,
                path: filePath
            });
        } else {
            console.warn(`Arquivo PDF não encontrado no disco para anexo: ${filePath}`);
            // Se não achar o arquivo, enviaremos apenas o link no corpo do email
        }

        const mailOptions = {
            from: `"Frotas MAK" <${process.env.EMAIL_USER}>`,
            to: partnerEmail,
            subject: `Autorização de Abastecimento #${orderData.authNumber} - ${orderData.partnerName || 'Frotas MAK'}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2>Autorização de Abastecimento</h2>
                    <p>Olá,</p>
                    <p>Segue em anexo a autorização de abastecimento emitida pelo sistema Frotas MAK.</p>
                    
                    <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <p><strong>Número:</strong> #${orderData.authNumber}</p>
                        <p><strong>Veículo:</strong> ${orderData.vehicleInfo || 'N/A'}</p>
                        <p><strong>Combustível:</strong> ${orderData.fuelType}</p>
                        <p><strong>Quantidade:</strong> ${orderData.isFillUp ? 'COMPLETAR TANQUE' : (orderData.litrosLiberados + ' Litros')}</p>
                        ${orderData.outros ? `<p><strong>Outros/Obs:</strong> ${orderData.outros}</p>` : ''}
                    </div>

                    <p>Por favor, realize o abastecimento conforme autorizado.</p>
                    
                    ${attachments.length === 0 ? `<p><strong>Link para Download:</strong> <a href="${pdfUrl}">${pdfUrl}</a></p>` : ''}
                    
                    <hr/>
                    <small>Este é um e-mail automático. Não responda.</small>
                </div>
            `,
            attachments: attachments
        };

        await getTransporter().sendMail(mailOptions);
        res.json({ message: 'Email enviado com sucesso!' });

    } catch (error) {
        console.error("Erro ao enviar email:", error);
        res.status(500).json({ error: 'Falha ao enviar e-mail: ' + error.message });
    }
};

// --- CRUD ---

// Ordens reservadas só aparecem para quem as emitiu. Este é o ÚNICO ponto de
// ocultação do sistema: o endpoint alimenta praticamente todas as telas do
// frontend, então filtrar aqui cobre listas, relatórios, dashboard e histórico
// de uma vez — e, ao contrário de um filtro no cliente, também não vaza o
// registro na aba Network. Agregações de valor (despesa da obra, saldo no
// posto, média de consumo) rodam por SQL próprio e continuam contando a ordem.
const HIDDEN_VISIBILITY_CLAUSE =
    '(is_hidden = 0 OR (hidden_by_user_id IS NOT NULL AND hidden_by_user_id = ?))';

// Filtro de período e paginação são OPCIONAIS e sem default: sem query params
// o retorno segue sendo a tabela inteira, como antes.
//
// Não impomos uma janela padrão de propósito. Os relatórios do frontend
// (AveragesReport, SupplyOrdersReport, FuelConsumptionReport) iniciam com o
// filtro de data VAZIO, o que significa "todo o histórico" — um default de N
// dias no servidor truncaria esses relatórios em silêncio, sem que o usuário
// visse qualquer indicação de que faltam dados.
//
// Query params aceitos:
//   startDate / endDate → 'YYYY-MM-DD' (inclusivos)
//   page / limit        → paginação; a resposta vira { data, total, page, limit }
const getAllRefuelings = async (req, res) => {
    try {
        const { startDate, endDate, page, limit, scope } = req.query;

        let where = HIDDEN_VISIBILITY_CLAUSE;
        const params = [req.user?.id || null];

        // `scope` serve a tela de Abastecimento, que exibe três listas distintas
        // e não precisa da tabela inteira para montá-las.
        if (scope === 'pendentes') {
            where += " AND is_hidden = 0 AND status IN ('Aberta', 'BloqueadoLeitura', 'BloqueadoOrcamento')";
        } else if (scope === 'ocultas') {
            where += ' AND is_hidden = 1';
        } else if (scope === 'historico') {
            where += " AND is_hidden = 0 AND status IN ('Concluída', 'Cancelada')";
            // A busca da tela cobre número da ordem, registro interno e placa.
            // O JOIN em `vehicles` mantém o mesmo alcance de antes (todo o
            // histórico) agora que a tela não carrega mais a tabela inteira —
            // filtrar só as 20 linhas já paginadas reduziria a busca.
            const termo = (req.query.search || '').trim();
            if (termo) {
                where += ` AND (
                    CAST(authNumber AS CHAR) LIKE ?
                    OR vehicleId IN (
                        SELECT id FROM vehicles
                         WHERE registroInterno LIKE ? OR placa LIKE ?
                    )
                )`;
                const like = `%${termo}%`;
                params.push(like, like, like);
            }
        }

        // Só aplica o intervalo quando AMBOS vierem — evita binds com undefined
        // (mesmo cuidado de getAllDiarioDeBordo).
        if (startDate && endDate) {
            where += ' AND data >= ? AND data < DATE_ADD(?, INTERVAL 1 DAY)';
            params.push(startDate, endDate);
        }

        const base = `FROM refuelings WHERE ${where}`;

        // O histórico da tela de Abastecimento é ordenado por data (e o número da
        // ordem desempata), não por id — ordenar por id aqui devolveria um
        // conjunto diferente das 20 linhas que a tela mostrava antes.
        const orderBy = scope === 'historico'
            ? 'ORDER BY data DESC, authNumber DESC'
            : 'ORDER BY id DESC';

        // Sem page/limit o formato da resposta continua sendo um array puro,
        // que é o que todos os consumidores atuais esperam.
        if (!page && !limit) {
            const [rows] = await db.query(`SELECT * ${base} ${orderBy}`, params);
            return res.json(parseRefuelingRows(rows));
        }

        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${base}`, params);
        const [rows] = await db.query(
            `SELECT * ${base} ${orderBy} LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );
        res.json({ data: parseRefuelingRows(rows), total, page: pageNum, limit: limitNum });
    } catch (error) {
        console.error('Erro GET refuelings:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// Abastecimentos de UM veículo (aba "Abastecimento" no histórico do veículo).
// Escopado por vehicleId para não trafegar a tabela inteira no modal.
const getRefuelingsByVehicle = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT * FROM refuelings WHERE vehicleId = ? AND ${HIDDEN_VISIBILITY_CLAUSE} ORDER BY id DESC`,
            [req.params.vehicleId, req.user?.id || null]
        );
        res.json(parseRefuelingRows(rows));
    } catch (error) {
        console.error('Erro GET refuelings por veículo:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimentos do veículo.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Regras que antes rodavam no cliente sobre a tabela inteira de refuelings.
//
// A tela de Abastecimento baixava os ~23 mil registros só para responder duas
// perguntas pontuais: "este veículo já tem ordem aberta?" e "quanto esta obra
// já gastou de combustível?". Ambas viraram consulta pontual ao banco — além
// de tirar o payload, a validação passa a ser feita no servidor, onde o
// cliente não tem como divergir.
// ─────────────────────────────────────────────────────────────────────────────

// Status que NÃO contam como ordem aberta. Espelha o closedStatuses que estava
// no RefuelingOrderModal (inclui as duas grafias de "Concluída").
const CLOSED_STATUSES = ['Concluída', 'Concluida', 'Cancelada', 'Negada', 'Baixada'];

// GET /refuelings/open?vehicleId=X&excludeId=Y
// Devolve a ordem em aberto do veículo (ou null). `excludeId` cobre a edição,
// em que a própria ordem sendo editada não deve contar.
const getOpenRefuelingByVehicle = async (req, res) => {
    try {
        const { vehicleId, excludeId } = req.query;
        if (!vehicleId) return res.status(400).json({ error: 'vehicleId é obrigatório.' });

        const params = [vehicleId, ...CLOSED_STATUSES];
        let sql = `SELECT * FROM refuelings
                    WHERE vehicleId = ?
                      AND status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`;
        if (excludeId) {
            sql += ' AND id != ?';
            params.push(excludeId);
        }
        // Mantém o filtro de ordens reservadas: o array que alimentava esta regra
        // no cliente já vinha filtrado por ele, então preservamos o comportamento.
        sql += ` AND ${HIDDEN_VISIBILITY_CLAUSE} LIMIT 1`;
        params.push(req.user?.id || null);

        const [rows] = await db.query(sql, params);
        res.json(rows.length ? parseRefuelingRows(rows)[0] : null);
    } catch (error) {
        console.error('Erro GET refuelings/open:', error);
        res.status(500).json({ error: 'Erro ao verificar ordem aberta.' });
    }
};

// GET /refuelings/obra-status/:obraId
// Replica exatamente a regra que estava no RefuelingOrderModal: o gasto é o
// MAIOR entre o somatório de `expenses` de combustível e o dos abastecimentos
// concluídos — `expenses` não tem categoria 'Combustível' em todos os casos, e
// sozinha zeraria o cálculo.
const getObraFuelStatus = async (req, res) => {
    try {
        const { obraId } = req.params;
        const [[obra]] = await db.query(
            'SELECT valorTotalContrato FROM obras WHERE id = ?',
            [obraId]
        );
        if (!obra) return res.json(null);

        const valorContrato = parseFloat(obra.valorTotalContrato) || 0;
        if (valorContrato <= 0) return res.json(null);

        const [[expRow]] = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total
               FROM expenses
              WHERE obraId = ? AND (category = 'Combustível' OR fuelType IS NOT NULL)`,
            [obraId]
        );
        // 'Confirmada' entra junto de 'Concluída' para não divergir do que a tela
        // exibia antes desta mudança.
        const [[refRow]] = await db.query(
            `SELECT COALESCE(SUM(
                    (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) +
                    (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
                    COALESCE(outrosValor, 0)
                 ), 0) AS total
               FROM refuelings
              WHERE obraId = ? AND status IN ('Concluída', 'Confirmada')`,
            [obraId]
        );

        const totalGasto = Math.max(
            parseFloat(expRow.total) || 0,
            parseFloat(refRow.total) || 0
        );
        res.json({
            totalGasto,
            valorContrato,
            percentual: (totalGasto / valorContrato) * 100,
        });
    } catch (error) {
        console.error('Erro GET refuelings/obra-status:', error);
        res.status(500).json({ error: 'Erro ao calcular gasto da obra.' });
    }
};

const getRefuelingById = async (req, res) => {
    try {
        // 404 (e não 403) quando a ordem é reservada de outro usuário: um 403
        // confirmaria a existência do registro para quem chutasse o id.
        const [rows] = await db.execute(
            `SELECT * FROM refuelings WHERE id = ? AND ${HIDDEN_VISIBILITY_CLAUSE}`,
            [req.params.id, req.user?.id || null]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
        res.json(parseRefuelingRows(rows)[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO DE EMISSÃO DE ORDEM
//
// `criarOrdem` é o miolo do POST /api/refuelings, separado do handler HTTP para
// que o aceite automático por IA (services/abastecimentoAutoService) emita
// ordens pelo MESMO caminho do gestor humano, com as mesmas travas, o mesmo
// empenho de saldo e o mesmo envio ao posto.
//
// Se a automação tivesse seu próprio INSERT, qualquer regra adicionada aqui
// deixaria de valer para ela em silêncio — foi exatamente o que aconteceu com
// solicitacaoAdminController.avaliarSolicitacao, que fazia INSERT cru e pulava
// ordem-aberta, operador placeholder, leitura, orçamento e o envio ao posto.
//
// Fica neste arquivo, e não num services/ próprio, porque depende de três
// helpers privados daqui (dispatchOrderToPartner, updateMonthlyExpense,
// safeNum) com 11 pontos de uso. Movê-los renderia um import mais bonito e
// nenhum ganho funcional, com risco real de regressão.
//
// Devolve { ok, status, body } em vez de escrever na resposta: quem chama
// decide se vira HTTP ou log.
// ─────────────────────────────────────────────────────────────────────────────

const respostaErro = (status, body) => ({ ok: false, status, body });

const criarOrdem = async (data, { actor = {}, io = null } = {}) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // ─── Ordem reservada: valida a permissão no servidor ───
        // Nunca confiar no frontend. E falhar em vez de criar visível: quem pediu
        // ordem reservada acredita que ela ficará oculta — criar visível em silêncio
        // seria o pior desfecho possível.
        const querOcultar = !!data.isHidden;
        if (querOcultar && actor?.can_create_hidden_orders !== true) {
            await connection.rollback();
            return respostaErro(403, { error: 'Sem permissão para emitir ordem reservada.' });
        }

        const id = crypto.randomUUID();
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;

        let dataAbastecimento = new Date();
        if (data.date) {
            const dateStr = data.date.toString();
            if (dateStr.includes('T')) {
                dataAbastecimento = new Date(dateStr);
            } else {
                // Data sem horário — usa o horário real atual em BRT (GMT-3)
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
                dataAbastecimento = new Date(`${dateStr}T${pad(brt.getHours())}:${pad(brt.getMinutes())}:${pad(brt.getSeconds())}-03:00`);
            }
        }

        // ─── Agendamento de liberação da ordem reservada ───
        // Vem de um <input type="datetime-local">, que não carrega fuso — interpreta
        // em BRT, mesmo tratamento dado a `data.date` acima. Data inválida ou no
        // passado: ignora o agendamento e mantém a ordem reservada com liberação
        // manual (nunca criar visível quem pediu reservada).
        let revealAtDate = null;
        let revealAtIgnorado = false;
        if (querOcultar && data.revealAt) {
            const raw = String(data.revealAt).trim();
            const temFuso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
            const comSegundos = /T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
            const parsed = new Date(temFuso ? comSegundos : `${comSegundos}-03:00`);
            if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
                revealAtDate = parsed;
            } else {
                revealAtIgnorado = true;
            }
        }

        // ─── Travas soberanas (utils/regrasAbastecimento) ────────────────────
        // Anti-duplicidade: bloqueia 2ª ordem aberta para o mesmo veículo.
        // Exceções tratadas dentro do predicado: fim-de-semana/feriado fixo,
        // veículo fictício (permiteMultiplosAbastecimentos) e terceirizado.
        // travar=true usa FOR UPDATE, serializando contra criações concorrentes.
        let isOutsourcedVehicle = false;
        let allowMultiple = false;
        if (data.vehicleId) {
            const [vehicleRows] = await connection.execute(
                'SELECT permiteMultiplosAbastecimentos, isOutsourced FROM vehicles WHERE id = ?',
                [data.vehicleId]
            );
            allowMultiple = vehicleRows.length > 0
                && (vehicleRows[0].permiteMultiplosAbastecimentos == 1 || vehicleRows[0].permiteMultiplosAbastecimentos === true);
            // Veículos terceirizados não estão sob nossas regras de gestão de frota
            // (leitura, orçamento, operador placeholder, ordem em aberto): a operação
            // pertence ao terceiro e só registramos o consumo para faturamento.
            isOutsourcedVehicle = vehicleRows.length > 0
                && (vehicleRows[0].isOutsourced == 1 || vehicleRows[0].isOutsourced === true);

            // ymdBRT: dia calculado no fuso de Brasília, senão ordens do fim da
            // tarde caíam no dia seguinte.
            const duplicada = await checkOrdemAbertaDuplicada(
                connection, data.vehicleId, ymdBRT(dataAbastecimento),
                { travar: true, usuarioId: actor?.id }
            );
            if (duplicada) {
                await connection.rollback();
                if (duplicada.ocultaDeTerceiro) {
                    return respostaErro(409, {
                        error: 'Este veículo está temporariamente indisponível para emissão de nova ordem. Verifique com a administração.',
                        code: 'VEHICLE_TEMPORARILY_BLOCKED'
                    });
                }
                const bloqueia = duplicada.ordem;
                return respostaErro(409, {
                    error: `Já existe ordem em aberto Nº ${bloqueia.authNumber} (${bloqueia.status}) para este veículo. Conclua ou cancele antes de emitir outra.`,
                    code: 'DUPLICATE_OPEN_ORDER',
                    openOrderId: bloqueia.id,
                    openOrderAuthNumber: bloqueia.authNumber,
                    openOrderStatus: bloqueia.status
                });
            }

            // ─── Bloqueio: veículo a >7 dias em obra com operador placeholder ───
            // Quando um veículo é alocado a uma obra sem o operador real definido,
            // entra um placeholder (COLABORADOR, TESTE, MAK SERVIÇOS etc.). Se o
            // operador real não for trocado em até 7 dias, suspende emissão de
            // ordens até que alguém atualize o operador na tela de alocação.
            const placeholder = await checkOperadorPlaceholder(connection, data.vehicleId);
            if (placeholder) {
                await connection.rollback();
                return respostaErro(409, {
                    error: `Bloqueado: veículo está há ${placeholder.diasNaObra} dias na obra com operador fictício "${placeholder.employeeName}". Atualize o operador real antes de emitir ordens.`,
                    code: 'PLACEHOLDER_OPERATOR_BLOCK',
                    placeholderName: placeholder.employeeName,
                    diasNaObra: placeholder.diasNaObra,
                });
            }
        }

        let finalPartnerName = data.partnerName;
        if (!finalPartnerName && data.partnerId) {
            const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [data.partnerId]);
            if (pRows.length > 0) {
                finalPartnerName = pRows[0].razaoSocial;
            }
        }

        const createdByData = data.createdBy || {};
        if (data.solicitacaoId) {
            createdByData.linkedSolicitacaoId = data.solicitacaoId;
        }

        // Terceirizados pulam validações de leitura e orçamento (frota não gerida por nós).
        // Veículos fictícios (permiteMultiplosAbastecimentos=1: ajuda de custo, gerador,
        // lava-jato etc.) também pulam o bloqueio de leitura — eles aceitam qualquer
        // valor de km/Hr e a ordem nunca deve cair na fila de liberação da Administração.
        const skipLeituraCheck = isOutsourcedVehicle || allowMultiple;
        const motivoLeitura = skipLeituraCheck ? null : await checkLeituraBloqueada(
            connection, data.vehicleId,
            data.odometro != null ? parseFloat(data.odometro) : null,
            data.horimetro != null ? parseFloat(data.horimetro) : null
        );
        const bloqueadoOrcamento = !isOutsourcedVehicle && !motivoLeitura && await checkOrcamentoBloqueado(connection, data.obraId);

        let initialStatus = data.status || 'Aberta';
        if (motivoLeitura) initialStatus = 'BloqueadoLeitura';
        else if (bloqueadoOrcamento) initialStatus = 'BloqueadoOrcamento';

        const refuelingData = {
            id: id,
            authNumber: newAuthNumber,
            vehicleId: data.vehicleId,
            partnerId: data.partnerId || null,
            partnerName: finalPartnerName || null,
            employeeId: data.employeeId || null,
            obraId: data.obraId || null,
            fuelType: data.fuelType || null,
            data: dataAbastecimento,
            status: initialStatus,
            isFillUp: data.isFillUp ? 1 : 0,
            needsArla: data.needsArla ? 1 : 0,
            isFillUpArla: data.isFillUpArla ? 1 : 0,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0,
            litrosLiberados: safeNum(data.litrosLiberados, true),
            litrosLiberadosArla: safeNum(data.litrosLiberadosArla, true),
            odometro: safeNum(data.odometro),
            horimetro: safeNum(data.horimetro), 
            outrosValor: safeNum(data.outrosValor, true),
            outros: data.outros || null,
            createdBy: JSON.stringify(createdByData),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: motivoLeitura
                ? JSON.stringify({ motivoBloqueio: motivoLeitura })
                : (data.editedBy ? JSON.stringify(data.editedBy) : null),
            invoiceNumber: data.invoiceNumber || null
        };

        // Vínculo ordem -> solicitação em coluna própria. A coluna já era LIDA na
        // baixa e na exclusão (order.createdFromSolicitacaoId) mas nunca existia
        // no schema, então só o fallback pelo JSON createdBy funcionava. Ambos
        // seguem gravados: o JSON mantém compatibilidade com as ordens antigas.
        if (data.solicitacaoId) {
            refuelingData.createdFromSolicitacaoId = String(data.solicitacaoId);
        }

        // Só acrescenta as colunas de reserva quando a ordem é reservada — assim o
        // INSERT do caminho normal permanece exatamente como era.
        if (querOcultar) {
            refuelingData.is_hidden = 1;
            refuelingData.hidden_by_user_id = actor.id;
            refuelingData.hidden_at = new Date();
            refuelingData.reveal_at = revealAtDate; // null = liberação apenas manual
        }

        const fields = Object.keys(refuelingData);
        // mysql2 recusa `undefined` nos binds ("Bind parameters must not contain
        // undefined"). Isso derrubava a criação com 500 sempre que o chamador
        // omitia um campo em vez de mandar null — tolerável quando só o
        // frontend chamava e sempre enviava tudo, mas não agora que a emissão
        // automática também usa esta função. undefined vira NULL.
        const values = Object.values(refuelingData).map((v) => (v === undefined ? null : v));
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO refuelings (${fields.join(', ')}) VALUES (${placeholders})`, values);
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        if (data.solicitacaoId) {
            const userId = data.createdBy && data.createdBy.id ? data.createdBy.id : null;
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "LIBERADO", data_aprovacao = NOW(), aprovado_por_usuario_id = ? WHERE id = ?',
                [userId, data.solicitacaoId]
            );
        }

        // Busca tipo do veículo para aplicar regra odômetro/horímetro
        const [[vehicleRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [data.vehicleId]);
        if (vehicleRow) {
            const readingVal = safeNum(data.odometro) || safeNum(data.horimetro);
            if (readingVal) {
                await updateVehicleReading(connection, data.vehicleId, vehicleRow.tipo, readingVal, 'auto');
            }
        }

        if (refuelingData.status === 'Concluída' && refuelingData.obraId && refuelingData.partnerId && refuelingData.fuelType) {
            await updateMonthlyExpense(connection, refuelingData.obraId, refuelingData.partnerId, refuelingData.fuelType, refuelingData.data);
        }

        // Saldo pré-pago: empenhar valor da ordem ao criar (apenas se ordem efetivamente liberada).
        if (initialStatus === 'Aberta' || initialStatus === 'Concluída') {
            try {
                await fuelCredits.applyOrderReservation(connection, {
                    id,
                    authNumber: newAuthNumber,
                    partnerId: refuelingData.partnerId,
                    obraId: refuelingData.obraId,
                    fuelType: refuelingData.fuelType,
                    isFillUp: refuelingData.isFillUp,
                    needsArla: refuelingData.needsArla,
                    litrosLiberados: refuelingData.litrosLiberados,
                    litrosLiberadosArla: refuelingData.litrosLiberadosArla,
                    outrosValor: refuelingData.outrosValor,
                }, { createdBy: actor?.id || null });
            } catch (e) {
                console.warn('[partnerFuelCredits] applyOrderReservation falhou:', e.message);
            }
        }

        await connection.commit();
        global.emitSync(['refuelings', 'vehicles', 'expenses', 'solicitacoes', 'partner_fuel_credits']);

        // Ordem salva bloqueada (leitura ou orçamento) → alerta admins (pop-up + som).
        // Ordem reservada não dispara o alerta: o texto carrega o número da ordem e
        // faria broadcast dela para todos os admins. Quem libera é o próprio emissor,
        // pelo painel "Ordens Reservadas".
        if ((motivoLeitura || bloqueadoOrcamento) && !querOcultar) {
            if (io) io.emit('admin:notificacao', {
                tipo: 'ordem_bloqueada',
                mensagem: motivoLeitura
                    ? `Ordem Nº ${newAuthNumber} bloqueada por leitura aguardando liberação.`
                    : `Ordem Nº ${newAuthNumber} bloqueada por orçamento aguardando liberação.`,
            });
        }

        // Dispara envio automático ao posto APENAS se a ordem foi efetivamente liberada.
        // Bloqueios (leitura/orçamento) aguardam ação do admin — o envio acontece no liberar.
        if (initialStatus === 'Aberta' || initialStatus === 'Concluída') {
            dispatchOrderToPartner(id);
        }

        let mensagemRetorno = 'Ordem emitida.';
        if (motivoLeitura) {
            mensagemRetorno = `Ordem Nº ${newAuthNumber} salva com bloqueio de leitura: ${motivoLeitura} Aguarde liberação do Administrador ou corrija os dados.`;
        } else if (bloqueadoOrcamento) {
            mensagemRetorno = `Ordem Nº ${newAuthNumber} salva, mas bloqueada por orçamento (≥20% do contrato). Aguarde liberação do Administrador.`;
        }
        if (querOcultar && revealAtIgnorado) {
            mensagemRetorno += ' A data de liberação informada é inválida ou já passou — a ordem ficará reservada até você liberá-la manualmente.';
        }

        return {
            ok: true,
            status: 201,
            body: {
                id,
                authNumber: newAuthNumber,
                bloqueadoOrcamento: !!bloqueadoOrcamento,
                bloqueadoLeitura: !!motivoLeitura,
                motivoBloqueioLeitura: motivoLeitura || null,
                isHidden: querOcultar,
                revealAt: revealAtDate,
                revealAtIgnorado,
                message: mensagemRetorno,
            },
        };
    } catch (error) {
        await connection.rollback();
        console.error('[refuelingOrderService] falha ao criar ordem:', error);
        return respostaErro(500, { error: error.message });
    } finally {
        connection.release();
    }
};

// Wrapper HTTP fino sobre criarOrdem.
const createRefuelingOrder = async (req, res) => {
    const resultado = await criarOrdem(req.body, { actor: req.user, io: req.io });
    return res.status(resultado.status).json(resultado.body);
};

const updateRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [oldData] = await connection.execute('SELECT * FROM refuelings WHERE id = ?', [id]);
        if (oldData.length === 0) throw new Error('Ordem não encontrada');
        const oldRefueling = oldData[0];

        const updateData = {};
        if (data.date) {
            const dateStr = data.date.toString().replace(' ', 'T');
            updateData.data = new Date(dateStr);
        }
        // Registra quem editou (o frontend envia o usuário em createdBy).
        const editorInfo = data.editedBy || data.createdBy;
        if (editorInfo) updateData.editedBy = JSON.stringify(editorInfo);
        if (data.status) updateData.status = data.status;

        if (data.vehicleId !== undefined) updateData.vehicleId = data.vehicleId;
        if (data.employeeId !== undefined) updateData.employeeId = data.employeeId || null;
        if (data.isFillUp !== undefined) updateData.isFillUp = data.isFillUp ? 1 : 0;
        if (data.needsArla !== undefined) updateData.needsArla = data.needsArla ? 1 : 0;
        if (data.isFillUpArla !== undefined) updateData.isFillUpArla = data.isFillUpArla ? 1 : 0;

        if (data.litrosLiberados !== undefined) updateData.litrosLiberados = safeNum(data.litrosLiberados, true);
        if (data.litrosAbastecidos !== undefined) updateData.litrosAbastecidos = safeNum(data.litrosAbastecidos, true);
        if (data.litrosAbastecidosArla !== undefined) updateData.litrosAbastecidosArla = safeNum(data.litrosAbastecidosArla, true);

        if (data.odometro !== undefined) updateData.odometro = safeNum(data.odometro);
        if (data.horimetro !== undefined) updateData.horimetro = safeNum(data.horimetro);

        if (data.outrosValor !== undefined) updateData.outrosValor = safeNum(data.outrosValor, true);
        
        if (data.partnerId !== undefined) {
            updateData.partnerId = data.partnerId;
             const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [data.partnerId]);
             if (pRows.length > 0) updateData.partnerName = pRows[0].razaoSocial;
        }

        if (data.obraId !== undefined) updateData.obraId = data.obraId || null;
        if (data.fuelType !== undefined) updateData.fuelType = data.fuelType || null;
        if (data.outrosGeraValor !== undefined) updateData.outrosGeraValor = data.outrosGeraValor ? 1 : 0;
        if (data.outros !== undefined) updateData.outros = data.outros || null;

        if (data.invoiceNumber !== undefined) {
            const newInvoiceNumber = data.invoiceNumber ? data.invoiceNumber.toString().trim() : null;
            if (newInvoiceNumber) {
                const partnerIdToCheck = updateData.partnerId || oldRefueling.partnerId;
                const [duplicateCheck] = await connection.execute(
                    'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? AND id != ?',
                    [partnerIdToCheck, newInvoiceNumber, id]
                );
                if (duplicateCheck.length > 0) {
                    throw new Error(`A Nota Fiscal ${newInvoiceNumber} já está cadastrada para este posto.`);
                }
                updateData.invoiceNumber = newInvoiceNumber;
            } else {
                updateData.invoiceNumber = null;
            }
        }

        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        if (Object.keys(updateData).length > 0) {
            const setClause = Object.keys(updateData).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE refuelings SET ${setClause} WHERE id = ?`, [...Object.values(updateData), id]);
        }

        const readingValUpdate = (updateData.odometro > 0 ? updateData.odometro : null) || (updateData.horimetro > 0 ? updateData.horimetro : null);
        if (readingValUpdate) {
            const [[vRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [oldRefueling.vehicleId]);
            if (vRow) {
                await updateVehicleReading(connection, oldRefueling.vehicleId, vRow.tipo, readingValUpdate, 'auto');
            }
        }

        const currentObra = updateData.obraId || oldRefueling.obraId;
        const currentPartner = updateData.partnerId || oldRefueling.partnerId;
        const currentFuel = updateData.fuelType || oldRefueling.fuelType;
        const currentDate = updateData.data || oldRefueling.data;

        if (currentObra && currentPartner && currentFuel) {
            await updateMonthlyExpense(connection, currentObra, currentPartner, currentFuel, currentDate);
        }

        if (
            (updateData.obraId && updateData.obraId !== oldRefueling.obraId) ||
            (updateData.partnerId && updateData.partnerId !== oldRefueling.partnerId) ||
            (updateData.fuelType && updateData.fuelType !== oldRefueling.fuelType)
        ) {
            if (oldRefueling.obraId && oldRefueling.partnerId && oldRefueling.fuelType) {
                await updateMonthlyExpense(connection, oldRefueling.obraId, oldRefueling.partnerId, oldRefueling.fuelType, oldRefueling.data);
            }
        }

        // Saldo pré-pago: se a ordem ainda está em aberto e algum campo de valor
        // mudou, libera o empenho antigo e refaz com base nos valores atuais.
        try {
            const merged = {
                ...oldRefueling,
                ...updateData,
                id,
                isFillUp: updateData.isFillUp !== undefined ? updateData.isFillUp : oldRefueling.isFillUp,
            };
            const isOpen = ['Aberta', 'BloqueadoOrcamento', 'BloqueadoLeitura'].includes(merged.status);
            const volumeOrPriceChanged =
                updateData.litrosLiberados !== undefined ||
                updateData.litrosLiberadosArla !== undefined ||
                updateData.outrosValor !== undefined ||
                updateData.partnerId !== undefined ||
                updateData.fuelType !== undefined;
            if (isOpen && volumeOrPriceChanged) {
                await fuelCredits.releaseOrderReservation(connection, oldRefueling, {
                    createdBy: req.user?.id || null,
                    reason: 'Edição',
                });
                if (merged.status === 'Aberta') {
                    await fuelCredits.applyOrderReservation(connection, merged, {
                        createdBy: req.user?.id || null,
                    });
                }
            }
        } catch (e) {
            console.warn('[partnerFuelCredits] re-empenho na edição falhou:', e.message);
        }

        await connection.commit();
        global.emitSync(['refuelings', 'expenses', 'vehicles', 'partner_fuel_credits']);

        // Reenvia a ordem ao posto (WhatsApp/e-mail conforme configurado) com um
        // alerta de "ORDEM ALTERADA — desconsiderar a anterior". Só reenvia se a
        // ordem estiver em estado enviável (não bloqueada e não terminal); ordens
        // bloqueadas aguardam a liberação do admin, que dispara o envio.
        const finalStatus = updateData.status || oldRefueling.status;
        const sendableStatuses = ['Aberta', 'Concluída', 'Concluida', 'Confirmada'];
        if (sendableStatuses.includes(finalStatus)) {
            dispatchOrderToPartner(id, { isAlteracao: true });
        }

        res.json({ message: 'Ordem atualizada.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// Limiares de alerta de combustível (%). Só notifica na primeira vez que cruza cada limiar.
const FUEL_PCT_THRESHOLDS = [50, 75, 90, 100];

const checkObraFuelPercent = async (obraId) => {
    const [[obra]] = await db.query(
        'SELECT nome, valorTotalContrato, responsavel, responsavel_email, responsavel_whatsapp FROM obras WHERE id = ?',
        [obraId]
    );
    if (!obra) return;

    const contrato = parseFloat(obra.valorTotalContrato) || 0;
    if (contrato <= 0) return;

    // Soma o custo total dos abastecimentos concluídos vinculados a esta obra
    const [[gastoRow]] = await db.query(
        `SELECT COALESCE(SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) +
            (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
            COALESCE(outrosValor, 0)
         ), 0) AS totalGasto
         FROM refuelings
         WHERE obraId = ? AND status = 'Concluída'`,
        [obraId]
    );
    const totalGasto = parseFloat(gastoRow.totalGasto) || 0;
    const pctAtual = (totalGasto / contrato) * 100;

    for (const limiar of FUEL_PCT_THRESHOLDS) {
        if (pctAtual < limiar) break; // limiares em ordem crescente, para de verificar

        // Checa se já enviamos notificação para este limiar nesta obra
        const [[logRow]] = await db.query(
            `SELECT id FROM notification_log
             WHERE event_type = 'combustivel_obra_20pct'
               AND obra_id = ?
               AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.pct')) = ?
             LIMIT 1`,
            [obraId, String(limiar)]
        );
        if (logRow) continue; // já notificado

        const payload = {
            obra: obra.nome,
            pct: limiar,
            gastoAtual: totalGasto.toFixed(2),
            orcamento: contrato.toFixed(2),
            obraId,
        };

        // Disparo via notification_targets configurados no admin,
        // mais o responsável da obra por WhatsApp (contato interno).
        const extraContacts = [];
        if (obra.responsavel_whatsapp) {
            extraContacts.push({ channel: 'whatsapp', contact: obra.responsavel_whatsapp, name: obra.responsavel || 'Responsável da Obra' });
        }
        dispatchAsync('combustivel_obra_20pct', payload, { obraId, extraContacts });

        // Envio direto ao responsável da obra (se tiver email configurado)
        if (obra.responsavel_email) {
            const subject = `Combustível da obra ${obra.nome} a ${limiar}% do orçamento`;
            const body = `⚠️ A obra *${obra.nome}* atingiu ${limiar}% do orçamento de combustível.\n\nGasto atual: R$ ${totalGasto.toFixed(2)} / R$ ${contrato.toFixed(2)}`;
            try {
                await sendEmail({
                    to: obra.responsavel_email,
                    subject,
                    text: body,
                    html: body.replace(/\n/g, '<br/>'),
                });
                insertLog({ event_type: 'combustivel_obra_20pct', channel: 'email', contact: obra.responsavel_email, obra_id: obraId, status: 'sent', payload_json: payload });
            } catch (e) {
                insertLog({ event_type: 'combustivel_obra_20pct', channel: 'email', contact: obra.responsavel_email, obra_id: obraId, status: 'failed', error_msg: e.message, payload_json: payload });
            }
        }
    }
};

const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const {
        litrosAbastecidos,
        litrosAbastecidosArla,
        pricePerLiter,
        pricePerLiterArla,
        confirmedReading,
        confirmedBy,
        outrosValor,
        invoiceNumber,
        updatePartnerPrice
    } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orders] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (orders.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        const order = orders[0];

        if (invoiceNumber) {
            const nfStr = invoiceNumber.toString().trim();
            if (nfStr) {
                // FOR UPDATE: sem ele, duas baixas simultâneas com a mesma NF
                // passavam as duas pela checagem antes de qualquer uma gravar.
                // Com o índice idx_partner_invoice, o InnoDB aplica gap lock em
                // REPEATABLE READ e serializa as duas transações.
                //
                // Não usamos constraint UNIQUE porque uma nota legitimamente cobre
                // mais de uma ordem (diesel + arla, ou dois veículos na mesma nota):
                // o banco já tem 8 pares (posto, NF) repetidos que são válidos.
                const [duplicates] = await connection.execute(
                    'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? AND id != ? FOR UPDATE',
                    [order.partnerId, nfStr, id]
                );
                if (duplicates.length > 0) {
                    throw new Error(`A Nota Fiscal ${nfStr} já consta lançada para este posto.`);
                }
            }
        }

        const [[vehicle]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [order.vehicleId]);

        const vehicleUpdate = {};
        const readingVal = safeNum(confirmedReading);

        if (readingVal && vehicle) {
            const updatedField = await updateVehicleReading(connection, order.vehicleId, vehicle.tipo, readingVal, 'auto');
            if (updatedField) vehicleUpdate[updatedField] = readingVal;
        }

        const safePrice = safeNum(pricePerLiter, true);
        const safePriceArla = safeNum(pricePerLiterArla, true);

        if (order.partnerId && safePrice > 0 && order.fuelType && updatePartnerPrice === true) {
            const priceQuery = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            await connection.execute(priceQuery, [order.partnerId, order.fuelType, safePrice]);

            // Atualiza também o preço do Arla cadastrado para o posto, se informado
            if (order.needsArla && safePriceArla > 0) {
                await connection.execute(priceQuery, [order.partnerId, 'Arla', safePriceArla]);
            }
        }

        const orderUpdate = {
            status: 'Concluída',
            litrosAbastecidos: safeNum(litrosAbastecidos, true),
            litrosAbastecidosArla: safeNum(litrosAbastecidosArla, true),
            pricePerLiter: safePrice,
            pricePerLiterArla: safePriceArla,
            confirmedBy: JSON.stringify(confirmedBy),
            outrosValor: safeNum(outrosValor, true),
            invoiceNumber: invoiceNumber ? invoiceNumber.toString().trim() : null,
            ...(vehicleUpdate.odometro ? { odometro: vehicleUpdate.odometro } : {}),
            ...(vehicleUpdate.horimetro ? { horimetro: vehicleUpdate.horimetro } : {}),
        };

        const oFields = Object.keys(orderUpdate).map(k => `${k} = ?`).join(', ');
        await connection.execute(`UPDATE refuelings SET ${oFields} WHERE id = ?`, [...Object.values(orderUpdate), id]);

        let linkedSolicitacaoId = null;
        if (order.createdFromSolicitacaoId) linkedSolicitacaoId = order.createdFromSolicitacaoId;
        if (!linkedSolicitacaoId && order.createdBy) {
            try {
                const cbObj = JSON.parse(order.createdBy);
                if (cbObj.linkedSolicitacaoId) linkedSolicitacaoId = cbObj.linkedSolicitacaoId;
            } catch (e) {}
        }

        if (linkedSolicitacaoId) {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?',
                [linkedSolicitacaoId]
            );
        }

        if (order.obraId && order.partnerId && order.fuelType) {
            await updateMonthlyExpense(connection, order.obraId, order.partnerId, order.fuelType, order.data);
        }

        // Saldo pré-pago: libera empenho (se havia) e lança baixa definitiva com valor real.
        try {
            await fuelCredits.releaseOrderReservation(connection, order, {
                createdBy: req.user?.id || null,
                reason: 'Baixa',
            });
            await fuelCredits.settleOrder(connection, {
                id: order.id,
                authNumber: order.authNumber,
                partnerId: order.partnerId,
                obraId: order.obraId,
                litrosAbastecidos: orderUpdate.litrosAbastecidos,
                litrosAbastecidosArla: orderUpdate.litrosAbastecidosArla,
                pricePerLiter: orderUpdate.pricePerLiter,
                pricePerLiterArla: orderUpdate.pricePerLiterArla,
                outrosValor: orderUpdate.outrosValor,
            }, { createdBy: req.user?.id || null });
            await connection.execute('UPDATE refuelings SET is_full_tank = 0 WHERE id = ?', [id]);
        } catch (e) {
            console.warn('[partnerFuelCredits] settle/release na baixa falhou:', e.message);
        }

        // Recalcula médias de consumo após confirmar abastecimento
        try {
            await recalcFuelAverage(connection, order.vehicleId);
        } catch (e) {
            console.warn('[recalcFuelAverage] Falha ao recalcular média:', e.message);
        }

        await connection.commit();
        global.emitSync(['refuelings', 'vehicles', 'expenses', 'partners', 'solicitacoes', 'partner_fuel_credits']);
        res.json({ message: 'Abastecimento confirmado com sucesso.' });

        // Verifica percentual de combustível da obra após confirmar (fire-and-forget)
        if (order.obraId) {
            setImmediate(() => checkObraFuelPercent(order.obraId).catch(e =>
                console.warn('[fuelPct] erro:', e.message)
            ));
        }

    } catch (error) {
        await connection.rollback();
        console.error('Erro CONFIRM:', error);
        res.status(500).json({ error: 'Erro ao confirmar: ' + error.message });
    } finally {
        connection.release();
    }
};

const deleteRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [rows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (rows.length === 0) {
             await connection.rollback();
             return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        const ref = rows[0];

        // Saldo pré-pago: estorna empenho ou baixa antes de excluir a ordem.
        try {
            if (ref.status === 'Concluída' || ref.status === 'Concluida') {
                const settled = fuelCredits.computeSettlementAmount(ref);
                if (settled > 0 && ref.partnerId) {
                    await fuelCredits.insertEntry(connection, {
                        partnerId: ref.partnerId,
                        entryType: 'adjustment',
                        amount: settled, // positivo: devolve ao disponível
                        orderId: ref.id,
                        obraId: ref.obraId,
                        description: `Estorno exclusão ordem #${ref.authNumber || ''}`.trim(),
                        createdBy: req.user?.id || null,
                    });
                }
            } else {
                await fuelCredits.releaseOrderReservation(connection, ref, {
                    createdBy: req.user?.id || null,
                    reason: 'Exclusão',
                });
            }
        } catch (e) {
            console.warn('[partnerFuelCredits] release na exclusão falhou:', e.message);
        }

        await connection.execute('DELETE FROM refuelings WHERE id = ?', [id]);

        let linkedSolicitacaoId = null;
        if (ref.createdFromSolicitacaoId) linkedSolicitacaoId = ref.createdFromSolicitacaoId;
        if (!linkedSolicitacaoId && ref.createdBy) {
            try {
                const cbObj = JSON.parse(ref.createdBy);
                if (cbObj.linkedSolicitacaoId) linkedSolicitacaoId = cbObj.linkedSolicitacaoId;
            } catch (e) {}
        }

        if (linkedSolicitacaoId) {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "NEGADO", motivo_negativa = "Ordem Excluída Manualmente pelo Gestor (Estorno)" WHERE id = ?',
                [linkedSolicitacaoId]
            );
        }

        if (ref.obraId && ref.partnerId && ref.fuelType) {
            await updateMonthlyExpense(connection, ref.obraId, ref.partnerId, ref.fuelType, ref.data);
        }

        await connection.commit();
        global.emitSync(['refuelings', 'expenses', 'solicitacoes', 'partner_fuel_credits']);
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro DELETE:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem.' });
    } finally {
        connection.release();
    }
};

const negarOrdemBloqueada = async (req, res) => {
    const { id } = req.params;
    try {
        const [[ordem]] = await db.execute('SELECT id, status FROM refuelings WHERE id = ?', [id]);
        if (!ordem) return res.status(404).json({ error: 'Ordem não encontrada.' });
        if (!['BloqueadoOrcamento', 'BloqueadoLeitura'].includes(ordem.status)) {
            return res.status(400).json({ error: 'Ordem não está bloqueada.' });
        }
        await db.execute('DELETE FROM refuelings WHERE id = ?', [id]);
        global.emitSync(['refuelings']);
        res.json({ message: 'Ordem negada e excluída.' });
    } catch (error) {
        console.error('Erro ao negar ordem:', error);
        res.status(500).json({ error: 'Erro ao negar ordem.' });
    }
};

const liberarOrdemBloqueada = async (req, res) => {
    const { id } = req.params;
    const liberadoPor = req.body.liberadoPor || req.user || null;
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [[ordem]] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (!ordem) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        if (!['BloqueadoOrcamento', 'BloqueadoLeitura'].includes(ordem.status)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Ordem não está bloqueada.' });
        }
        await connection.execute(
            'UPDATE refuelings SET status = "Aberta", editedBy = ? WHERE id = ?',
            [JSON.stringify({ acao: 'liberacao_orcamento', por: liberadoPor }), id]
        );

        // Saldo pré-pago: agora a ordem efetivamente sai — empenha valor.
        try {
            await fuelCredits.applyOrderReservation(connection, ordem, { createdBy: req.user?.id || null });
        } catch (e) {
            console.warn('[partnerFuelCredits] applyOrderReservation (liberar) falhou:', e.message);
        }

        await connection.commit();
        global.emitSync(['refuelings', 'partner_fuel_credits']);
        // Após o admin liberar, a ordem agora vai ao posto — dispara envio automático
        dispatchOrderToPartner(id);
        res.json({ message: 'Ordem liberada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao liberar ordem:', error);
        res.status(500).json({ error: 'Erro ao liberar ordem.' });
    } finally {
        connection.release();
    }
};

// ─── Ordem reservada: liberar (ou reagendar a liberação) ───
// Só o próprio emissor pode chamar. Não estender para admins: a ordem é reservada
// justamente em relação aos demais usuários, admins inclusive.
const revelarOrdemOculta = async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id || null;

    // 404 genérico em qualquer falha de dono/estado — um 403 confirmaria a
    // existência da ordem para quem chutasse o id.
    const naoEncontrado = () => res.status(404).json({ error: 'Não encontrado' });

    try {
        const [[ordem]] = await db.execute(
            'SELECT id, authNumber, is_hidden, hidden_by_user_id FROM refuelings WHERE id = ?',
            [id]
        );
        if (!ordem || ordem.is_hidden != 1 || !userId || ordem.hidden_by_user_id !== userId) {
            return naoEncontrado();
        }

        // Body opcional { revealAt }: data futura reagenda em vez de liberar agora.
        const raw = req.body?.revealAt ? String(req.body.revealAt).trim() : '';
        if (raw) {
            const temFuso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
            const comSegundos = /T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
            const parsed = new Date(temFuso ? comSegundos : `${comSegundos}-03:00`);
            if (isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                return res.status(400).json({ error: 'Data de liberação inválida ou no passado.' });
            }
            await db.execute('UPDATE refuelings SET reveal_at = ? WHERE id = ? AND hidden_by_user_id = ?', [parsed, id, userId]);
            return res.json({
                message: `Liberação da ordem Nº ${ordem.authNumber} agendada.`,
                authNumber: ordem.authNumber,
                revealAt: parsed
            });
        }

        const [result] = await db.execute(
            `UPDATE refuelings
                SET is_hidden = 0, revealed_at = ?, reveal_at = NULL
              WHERE id = ? AND is_hidden = 1 AND hidden_by_user_id = ?`,
            [new Date(), id, userId]
        );
        if (result.affectedRows === 0) return naoEncontrado();

        global.emitSync(['refuelings']);
        res.json({
            message: `Ordem Nº ${ordem.authNumber} liberada — agora visível para todos os usuários.`,
            authNumber: ordem.authNumber
        });
    } catch (error) {
        console.error('Erro ao liberar ordem reservada:', error);
        res.status(500).json({ error: 'Erro ao liberar ordem reservada.' });
    }
};

module.exports = {
    criarOrdem,
    getAllRefuelings,
    getOpenRefuelingByVehicle,
    getObraFuelStatus,
    getRefuelingsByVehicle,
    getRefuelingById,
    createRefuelingOrder,
    updateRefuelingOrder,
    confirmRefuelingOrder,
    deleteRefuelingOrder,
    liberarOrdemBloqueada,
    negarOrdemBloqueada,
    revelarOrdemOculta,
    upload,
    uploadOrderPdf,
    sendOrderEmail
};