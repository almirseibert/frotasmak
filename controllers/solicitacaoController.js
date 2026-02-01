// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- CONFIGURAÇÃO MULTER (Uploads Otimizados) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Limite 5MB
});

// --- HELPERS ---
const safeNum = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// HELPER: Normaliza o tipo de combustível para o padrão do sistema (camelCase)
const normalizeFuelType = (val) => {
    if (!val) return null;
    const v = val.toString().trim().toUpperCase();
    
    // Mapeamento: Display Name -> System Value
    const map = {
        'DIESEL S10': 'dieselS10',
        'DIESEL S500': 'dieselS500',
        'GASOLINA COMUM': 'gasolinaComum',
        'GASOLINA ADITIVADA': 'gasolinaAditivada',
        'ETANOL': 'etanol',
        'ARLA 32': 'arla32'
    };

    return map[v] || val;
};

// --- CORE: CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        
        const { 
            veiculo_id, 
            obra_id, 
            posto_id, 
            funcionario_id, 
            tipo_combustivel, 
            litragem, 
            flag_tanque_cheio, 
            flag_outros, 
            descricao_outros, 
            horimetro, 
            odometro, 
            latitude, 
            longitude,
            observacao 
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;

        // Normalização do Combustível
        const tipoCombustivelNormalizado = normalizeFuelType(tipo_combustivel);

        // 1. Validar Veículo
        if (!veiculo_id) throw new Error("ID do veículo não informado.");
        
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculo_id]);
        if (vehicles.length === 0) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Veículo não encontrado.' });
        }
        const veiculo = vehicles[0];

        // 2. Validar Bloqueio Usuário
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        if (!users.length || users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO. Contate o administrador.' });
        }

        // 3. Validação Leitura
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        const antHorimetro = safeNum(veiculo.horimetro || veiculo.horimetroDigital);

        if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) erroValidacao = `Odômetro menor que o anterior (${antOdometro} Km).`;
            else if ((novoOdometro - antOdometro) > 2000) erroValidacao = `Salto de Odômetro excessivo.`;
        }
        if (novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) erroValidacao = `Horímetro menor que o anterior (${antHorimetro} h).`;
            else if ((novoHorimetro - antHorimetro) > 100) erroValidacao = `Salto de Horímetro excessivo.`;
        }

        if (erroValidacao) {
            const novasTentativas = users[0].tentativas_falhas_abastecimento + 1;
            const bloquear = novasTentativas >= 3 ? 1 : 0;
            
            await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = ?, bloqueado_abastecimento = ? WHERE id = ?', [novasTentativas, bloquear, usuarioId]);
            await connection.commit();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: `Erro de Leitura: ${erroValidacao} (Tentativa ${novasTentativas}/3).` });
        }

        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

        // 4. Trava Orçamentária
        const [obras] = await connection.execute('SELECT * FROM obras WHERE id = ?', [obra_id]);
        if (obras.length > 0) {
            const valorContrato = parseFloat(obras[0].valorContrato || 0);
            if (valorContrato > 0) {
                 const [expenses] = await connection.execute("SELECT SUM(amount) as total FROM expenses WHERE obraId = ? AND category = 'Combustível'", [obra_id]);
                 const totalGasto = safeNum(expenses[0].total);
                 const custoEst = (flag_tanque_cheio ? 200 : safeNum(litragem)) * 6.50;
                 if ((totalGasto + custoEst) > (valorContrato * 0.20)) {
                    await connection.rollback();
                    if (req.file) fs.unlinkSync(req.file.path);
                    return res.status(400).json({ error: 'Limite orçamentário (20%) excedido.' });
                 }
            }
        }

        // 5. Preparar Dados
        let obsFinal = observacao || '';
        const isOutros = (flag_outros === '1' || flag_outros === 'true' || flag_outros === true);
        if (isOutros && descricao_outros) {
            obsFinal = `[Item: ${descricao_outros}] ${obsFinal}`;
        }
        
        // 6. Inserir (FIX: Adicionado o ? para longitude que faltava)
        // 18 colunas no INSERT -> 15 placeholers (?) + 3 valores fixos ('PENDENTE', 0, NOW()) = 18 valores.
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, 
            geo_latitude, geo_longitude, status, alerta_media_consumo, data_solicitacao, observacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', 0, NOW(), ?)`,
            [
                usuarioId, 
                veiculo_id, 
                obra_id, 
                posto_id || null, 
                funcionario_id || null, 
                tipoCombustivelNormalizado, 
                safeNum(litragem), 
                (flag_tanque_cheio === '1' || flag_tanque_cheio === 'true' || flag_tanque_cheio === true) ? 1 : 0, 
                isOutros ? 1 : 0,
                novoHorimetro || null, 
                novoOdometro || null, 
                fotoPainel,
                latitude || null, 
                longitude || null, // Este campo estava sem o '?' correspondente
                obsFinal
            ]
        );

        await connection.commit();
        
        if (req.io) {
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            req.io.emit('admin:notificacao', { tipo: 'nova_solicitacao', id: result.insertId });
        }

        res.status(201).json({ message: 'Solicitação enviada!', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Criar Solicitacao:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro no servidor: ' + error.message });
    } finally {
        connection.release();
    }
};

// --- LISTAR ---
const listarSolicitacoes = async (req, res) => {
    try {
        const usuarioId = req.user.id;
        const userRole = req.user.role; 

        let query = `
            SELECT s.*, 
                   v.placa, v.registroInterno as veiculo_nome, 
                   o.nome as obra_nome, 
                   p.razaoSocial as posto_nome,
                   u.name as solicitante_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            LEFT JOIN users u ON s.usuario_id = u.id
        `;

        const params = [];
        const isGestor = userRole === 'admin' || userRole === 'gestor' || req.user.canAccessRefueling;

        if (!isGestor) {
            query += ' WHERE s.usuario_id = ?';
            params.push(usuarioId);
        }

        query += ` ORDER BY s.data_solicitacao DESC LIMIT 100`;
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar.' });
    }
};

// --- AVALIAR (GESTOR) ---
const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivoNegativa } = req.body; 
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [solicitacao] = await connection.execute('SELECT * FROM solicitacoes_abastecimento WHERE id = ? FOR UPDATE', [id]);
        if (!solicitacao.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const sol = solicitacao[0];

        if (status === 'NEGADO') {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['NEGADO', motivoNegativa, req.user.id, id]
            );
            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
            return res.json({ message: 'Solicitação negada.' });
        }

        if (status === 'LIBERADO') {
            const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
            const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
            const newRefuelingId = crypto.randomUUID();

            let partnerName = 'Posto Externo';
            if (sol.posto_id) {
                const [p] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [sol.posto_id]);
                if (p.length > 0) partnerName = p[0].razaoSocial;
            }

            let employeeId = sol.funcionario_id; 
            const combustivelFinal = normalizeFuelType(sol.tipo_combustivel);

            await connection.execute(
                `INSERT INTO refuelings (
                    id, authNumber, vehicleId, partnerId, partnerName, 
                    employeeId, obraId, fuelType, data, status, 
                    isFillUp, needsArla, isFillUpArla, outrosGeraValor,
                    litrosLiberados, litrosLiberadosArla, 
                    odometro, horimetro, 
                    outros, outrosValor,
                    createdBy
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'Aberta', ?, 0, 0, 0, ?, 0, ?, ?, ?, 0, ?)`,
                [
                    newRefuelingId, 
                    newAuthNumber, 
                    sol.veiculo_id, 
                    sol.posto_id || null, 
                    partnerName,
                    employeeId, 
                    sol.obra_id, 
                    combustivelFinal, 
                    sol.flag_tanque_cheio, 
                    safeNum(sol.litragem_solicitada),
                    safeNum(sol.odometro_informado), 
                    safeNum(sol.horimetro_informado),
                    sol.observacao || null, 
                    JSON.stringify({ id: req.user.id, name: req.user.name || 'Gestor' })
                ]
            );

            await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['LIBERADO', req.user.id, id]
            );

            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
            return res.json({ message: 'Solicitação liberada! Ordem gerada.', authNumber: newAuthNumber });
        }

    } catch (error) {
        await connection.rollback();
        console.error("Erro Avaliar:", error);
        res.status(500).json({ error: 'Erro ao avaliar: ' + error.message });
    } finally {
        connection.release();
    }
};

const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto obrigatória.' });
        const fotoPath = `/uploads/solicitacoes/${req.file.filename}`;
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "AGUARDANDO_BAIXA", foto_cupom_path = ? WHERE id = ?', [fotoPath, id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante enviado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar.' });
    }
};

const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: 'Usuário não encontrado' });
    } catch (e) {
        res.status(500).json({ error: 'Erro interno' });
    }
};

module.exports = {
    criarSolicitacao,
    listarSolicitacoes,
    avaliarSolicitacao,
    enviarComprovante,
    confirmarBaixa,
    rejeitarComprovante,
    verificarStatusUsuario,
    upload
};