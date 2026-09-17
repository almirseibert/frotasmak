// controllers/comboioTransactionController.js
//
// Movimentações do comboio (veículo-tanque).
//
//   entrada  → o comboio enche no posto. Desde a revisão de 2026-09 é uma ORDEM
//              AO POSTO (refuelings.comboioEntrada = 1) emitida e baixada pelo
//              mesmo pipeline do Abastecimento; o espelho em comboio_transactions
//              e o tanque são mantidos por services/comboioEstoqueService.
//   saida    → o comboio abastece uma máquina. Registro direto. Leitura fora da
//              regra ou obra acima do orçamento NÃO recusam mais: a saída é salva
//              bloqueada (o diesel já saiu do tanque) e um admin libera.
//   drenagem → combustível retirado de uma máquina (volta ao comboio, vai para
//              outra máquina ou é descartado).
const db = require('../database');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { ensureComboioPartner } = require('../utils/ensureComboioPartner');
const { getActivePeriodId } = require('../utils/comboioPeriodo');
const { recalcFuelAverage } = require('../utils/recalcFuelAverage');
const { checkLeituraBloqueada, checkOrcamentoBloqueado } = require('../utils/regrasAbastecimento');
const consumo = require('../utils/consumo');
const { COMBOIO_TANK_KEYS, toComboioTankKey, tankKeyToOrderKey, fuelLabel, priceKeysFor } = require('../utils/fuelTypes');
const estoque = require('../services/comboioEstoqueService');

const {
    TOLERANCIA_SALDO_L,
    STATUS_BLOQUEADOS,
    isConcluida,
    lockComboio,
    getSaldoTanque,
    ajustarTanque,
    getCustoUnitarioComboio,
} = estoque;

// --- HELPERS DE SANITIZAÇÃO ---
const sanitize = (value) => (value === undefined || value === 'undefined' || value === '' ? null : value);

const sanitizeNumber = (value) => {
    if (value === undefined || value === null || value === '' || isNaN(value)) return null;
    return parseFloat(value);
};

// Leitura só conta se for positiva. O app do operador manda '0' para campo vazio.
const leituraPositiva = (value) => {
    const n = sanitizeNumber(value);
    return n && n > 0 ? n : null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const isAdmin = (req) => String(req.user?.role || req.user?.user_type || '').toLowerCase() === 'admin';

// Converte data enviada pelo frontend para Date no horário real BRT (GMT-3).
// Com 'T' (horário incluso) usa direto; só a data combina com o horário atual
// em BRT — sem isso, 'YYYY-MM-DD' virava 00:00 UTC = 21:00 do dia anterior.
const parseDateBRT = (d) => {
    if (!d) return new Date();
    const s = String(d);
    if (s.includes('T')) {
        const parsed = new Date(s);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
    }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const parsed = new Date(`${s}T${pad(brt.getHours())}:${pad(brt.getMinutes())}:${pad(brt.getSeconds())}-03:00`);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
};

// Autor do lançamento vem SEMPRE do token. O corpo da requisição mandava
// `createdBy` e qualquer um podia gravar outro e-mail como responsável.
const actorFromReq = (req) => {
    let bodyActor = req.body?.createdBy;
    if (typeof bodyActor === 'string') {
        try { bodyActor = JSON.parse(bodyActor); } catch { bodyActor = null; }
    }
    const email = req.user?.email || null;
    return {
        id: req.user?.id ?? null,
        email,
        userEmail: email,
        // Nome é só exibição; aceito do corpo apenas quando o e-mail confere.
        name: bodyActor && bodyActor.userEmail === email ? (bodyActor.name || bodyActor.nome || null) : null,
    };
};

const createdByJson = (actor, extra = {}) => JSON.stringify({
    id: actor.id, userEmail: actor.email, name: actor.name, ...extra,
});

// Notifica telas abertas. Gestores recebem o server:sync (sala 'gestores');
// o operador do comboio fica na sala 'operadores', que só recebe
// 'solicitacoes' — por isso o evento próprio com o id do comboio.
const emitComboioSync = (req, comboioVehicleIds = []) => {
    const targets = ['comboio', 'vehicles', 'refuelings', 'expenses'];
    if (typeof global.emitSync === 'function') global.emitSync(targets);
    else req.io?.emit('server:sync', { targets });

    const io = global.io || req.io;
    if (!io) return;
    for (const id of new Set(comboioVehicleIds.filter(Boolean))) {
        io.to('operadores').emit('comboio:saldo', { comboioVehicleId: id });
    }
};

const notificarBloqueio = (req, authNumber, status) => {
    const io = global.io || req.io;
    if (!io) return;
    const motivo = status === 'BloqueadoOrcamento' ? 'orçamento da obra' : 'leitura';
    io.to('gestores').emit('admin:notificacao', {
        tipo: 'ordem_bloqueada',
        mensagem: `Saída de comboio Nº ${authNumber} bloqueada por ${motivo}, aguardando liberação.`,
    });
};

// --- UPLOAD DE FOTOS DA DISTRIBUIÇÃO (operador do comboio) ---
// As distribuições feitas pelo operador direto na obra exigem fotos
// (horímetro, RE/placa, medidor zerado e medidor com litragem). Guardamos
// os arquivos em disco e o caminho relativo na coluna JSON `fotos`.
const COMBOIO_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'comboio');
if (!fs.existsSync(COMBOIO_UPLOAD_DIR)) {
    fs.mkdirSync(COMBOIO_UPLOAD_DIR, { recursive: true });
}
const comboioStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, COMBOIO_UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '.jpg').toLowerCase() || '.jpg';
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `${file.fieldname}-${unique}${ext}`);
    },
});
// `uploadSaidaFotos` é usado como middleware na rota POST /saida.
// O multer ignora requisições que não sejam multipart/form-data, então a
// distribuição feita pelo desktop (JSON puro, sem fotos) continua funcionando.
const uploadSaidaFotos = multer({
    storage: comboioStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB por foto
    fileFilter: (req, file, cb) => {
        const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp'];
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ext || ALLOWED.includes(ext)) return cb(null, true);
        cb(new Error(`Tipo de imagem não permitido: ${ext}`));
    },
}).fields([
    { name: 'foto_horimetro', maxCount: 1 },
    { name: 'foto_re', maxCount: 1 },
    { name: 'foto_medidor_zerado', maxCount: 1 },
    { name: 'foto_litragem', maxCount: 1 },
]);

// Monta o objeto JSON de fotos a partir de req.files (multer .fields()).
const buildFotosFromReq = (req) => {
    if (!req.files) return null;
    const map = {
        foto_horimetro: 'horimetro',
        foto_re: 're',
        foto_medidor_zerado: 'medidorZerado',
        foto_litragem: 'litragem',
    };
    const fotos = {};
    for (const [field, key] of Object.entries(map)) {
        const f = req.files[field]?.[0];
        if (f) fotos[key] = `/uploads/comboio/${f.filename}`;
    }
    return Object.keys(fotos).length > 0 ? JSON.stringify(fotos) : null;
};

// Fotos gravadas pelo multer antes de a distribuição ser recusada ficavam
// órfãs no disco. Qualquer saída que não seja 201 passa por aqui.
const removeUploadedFiles = (req) => {
    if (!req.files) return;
    for (const lista of Object.values(req.files)) {
        for (const f of lista || []) {
            fs.promises.unlink(f.path).catch(() => {});
        }
    }
};

const removeFotoFiles = (fotos) => {
    if (!fotos) return;
    let obj = fotos;
    if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch { return; }
    }
    for (const rel of Object.values(obj || {})) {
        if (typeof rel !== 'string' || !rel.startsWith('/uploads/comboio/')) continue;
        const arquivo = path.join(COMBOIO_UPLOAD_DIR, path.basename(rel));
        fs.promises.unlink(arquivo).catch(() => {});
    }
};

// --- HELPER: preço médio cadastrado (só para estornar registros antigos) ---
// Saídas gravadas antes da coluna valorTotal lançaram custo = litros × AVG de
// todos os postos. O estorno desses registros usa a mesma fórmula.
const getLegacyAverageFuelPrice = async (connection, fuelType) => {
    const [rows] = await connection.execute(
        'SELECT AVG(price) as avgPrice FROM partner_fuel_prices WHERE fuelType = ? AND price > 0',
        [fuelType]
    );
    return rows[0].avgPrice ? parseFloat(rows[0].avgPrice) : 0;
};

// --- HELPER: Gerenciar Despesa na Saída (Custo interno para Obra) ---
const manageSaidaExpense = async ({ connection, obraId, date, fuelType, valueChange }) => {
    if (!obraId || !fuelType || !valueChange) return;

    const expenseDate = new Date(date);
    const month = expenseDate.getMonth() + 1;
    const year = expenseDate.getFullYear();
    const referenceDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);

    const mesExtenso = expenseDate.toLocaleString('pt-BR', { month: 'long' });
    const capitalizedMonth = mesExtenso.charAt(0).toUpperCase() + mesExtenso.slice(1);
    const description = `Combustível: ${fuelLabel(fuelType)} - #Comboio (${capitalizedMonth}/${year})`;

    const [existingExpenses] = await connection.execute(
        `SELECT id, amount FROM expenses
         WHERE obraId = ?
         AND description = ?
         AND category = 'Combustível'
         LIMIT 1`,
        [obraId, description]
    );

    if (existingExpenses.length > 0) {
        const expense = existingExpenses[0];
        const newAmount = parseFloat(expense.amount) + valueChange;

        if (Math.abs(newAmount) < 0.01) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [expense.id]);
        } else {
            await connection.execute('UPDATE expenses SET amount = ? WHERE id = ?', [newAmount, expense.id]);
        }
    } else if (valueChange > 0) {
        await connection.execute(
            `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, fuelType, partnerName)
             VALUES (?, ?, ?, ?, 'Combustível', ?, ?, ?, 'Comboio Interno')`,
            [crypto.randomUUID(), obraId, description, valueChange, new Date(), referenceDate, fuelType]
        );
    }
};

// --- HELPER: Perda por drenagem eliminada (combustível contaminado/descartado) ---
// Lança (ou reverte, com valueChange negativo) o custo do combustível descartado
// como despesa da obra do veículo de origem. Agregado por mês, com descrição
// própria para não se confundir com o custo interno do comboio.
const manageDrenagemDescarteExpense = async ({ connection, obraId, date, fuelType, valueChange }) => {
    if (!obraId || !fuelType || !valueChange) return;

    const expenseDate = new Date(date);
    const month = expenseDate.getMonth() + 1;
    const year = expenseDate.getFullYear();
    const referenceDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);

    const mesExtenso = expenseDate.toLocaleString('pt-BR', { month: 'long' });
    const capitalizedMonth = mesExtenso.charAt(0).toUpperCase() + mesExtenso.slice(1);
    const description = `Combustível descartado (drenagem): ${fuelLabel(fuelType)} (${capitalizedMonth}/${year})`;

    const [existing] = await connection.execute(
        `SELECT id, amount FROM expenses
         WHERE obraId = ? AND description = ? AND category = 'Combustível'
         LIMIT 1`,
        [obraId, description]
    );

    if (existing.length > 0) {
        const newAmount = parseFloat(existing[0].amount) + valueChange;
        if (Math.abs(newAmount) < 0.01) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existing[0].id]);
        } else {
            await connection.execute('UPDATE expenses SET amount = ? WHERE id = ?', [newAmount, existing[0].id]);
        }
    } else if (valueChange > 0) {
        await connection.execute(
            `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, fuelType, partnerName)
             VALUES (?, ?, ?, ?, 'Combustível', ?, ?, ?, 'Drenagem/Descarte')`,
            [crypto.randomUUID(), obraId, description, valueChange, new Date(), referenceDate, fuelType]
        );
    }
};

// --- HELPER: Atualizar Odômetro/Horímetro do Veículo (usando utility compartilhada) ---
const updateVehicleReadingLocal = async (connection, vehicleId, readings) => {
    if (!vehicleId) return;
    const [[vRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [vehicleId]);
    if (!vRow) return;

    const readingVal = leituraPositiva(readings.odometro) || leituraPositiva(readings.horimetro);
    if (readingVal) {
        await updateVehicleReading(connection, vehicleId, vRow.tipo, readingVal, 'auto');
    }
};

// ─── REGRAS DA SAÍDA ────────────────────────────────────────────────────────
// Mesmas travas da ordem de abastecimento (utils/regrasAbastecimento), com as
// mesmas isenções: terceirizado e veículo fictício não passam pela leitura;
// terceirizado não passa pelo orçamento.
//
// Só a leitura do GRUPO do veículo entra na checagem. O app manda os dois
// campos, e antes o campo "errado" atualizava o veículo sem validação nenhuma.
const avaliarSaida = async (conn, recebedor, obraId, readings, { checarLeitura = true, checarOrcamento = true } = {}) => {
    const campo = await consumo.getCampoLeitura(recebedor.tipo, conn);
    const valor = leituraPositiva(campo === 'odometro' ? readings.odometro : readings.horimetro);
    const leituras = {
        odometro: campo === 'odometro' ? valor : null,
        horimetro: campo === 'horimetro' ? valor : null,
    };

    const terceirizado = recebedor.isOutsourced == 1;
    const ficticio = recebedor.permiteMultiplosAbastecimentos == 1;

    let motivo = null;
    let status = 'Concluída';
    if (checarLeitura && valor && !terceirizado && !ficticio) {
        motivo = await checkLeituraBloqueada(conn, recebedor.id, leituras.odometro, leituras.horimetro);
        if (motivo) status = 'BloqueadoLeitura';
    }
    if (!motivo && checarOrcamento && !terceirizado && obraId && await checkOrcamentoBloqueado(conn, obraId)) {
        status = 'BloqueadoOrcamento';
        motivo = 'Obra atingiu 20% ou mais do valor de contrato em combustível.';
    }
    return { status, motivo, ...leituras };
};

// Efeitos de uma saída CONCLUÍDA (na criação ou na liberação pelo admin):
// cópia em refuelings para o histórico/média do veículo, leitura, média e
// custo na obra. Saídas bloqueadas só descontam o tanque.
const applySaidaEffects = async (conn, ct, actor) => {
    const refuelingId = crypto.randomUUID();
    await conn.execute(
        `INSERT INTO refuelings
            (id, authNumber, vehicleId, partnerId, partnerName, employeeId, obraId, fuelType, data,
             status, isFillUp, litrosLiberados, litrosAbastecidos, pricePerLiter, odometro, horimetro, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Concluída', 0, ?, ?, 0, ?, ?, ?)`,
        [
            refuelingId, ct.authNumber, ct.receivingVehicleId, ct.partnerId || null, ct.partnerName || 'Comboio',
            ct.employeeId || null, ct.obraId || null, ct.fuelType, ct.date,
            ct.liters, ct.liters, ct.odometro || null, ct.horimetro || null,
            createdByJson(actor, { origem: 'comboio', comboioTransactionId: ct.id }),
        ]
    );
    await conn.execute('UPDATE comboio_transactions SET refuelingId = ? WHERE id = ?', [refuelingId, ct.id]);

    await updateVehicleReadingLocal(conn, ct.receivingVehicleId, { odometro: ct.odometro, horimetro: ct.horimetro });
    try {
        await recalcFuelAverage(conn, ct.receivingVehicleId);
    } catch (e) {
        console.warn('⚠️ [recalcFuelAverage saída comboio]', e.message);
    }

    const valor = parseFloat(ct.valorTotal) || 0;
    if (valor > 0) {
        await manageSaidaExpense({ connection: conn, obraId: ct.obraId, date: ct.date, fuelType: ct.fuelType, valueChange: valor });
    }
    return refuelingId;
};

// Desfaz applySaidaEffects. A leitura do veículo não volta (updateVehicleReading
// só avança), o resto sim. Registros antigos sem refuelingId são casados pelo
// número da ordem + veículo — só quando o par é único.
const revertSaidaEffects = async (conn, ct) => {
    let copyId = ct.refuelingId || null;
    if (!copyId && ct.authNumber && ct.receivingVehicleId) {
        const [copias] = await conn.execute(
            `SELECT id FROM refuelings
              WHERE authNumber = ? AND vehicleId = ? AND drenagemTransactionId IS NULL
                AND COALESCE(comboioEntrada, 0) = 0
              LIMIT 2`,
            [ct.authNumber, ct.receivingVehicleId]
        );
        if (copias.length === 1) copyId = copias[0].id;
    }
    if (copyId) {
        await conn.execute('UPDATE expenses SET refuelingId = NULL WHERE refuelingId = ?', [copyId]);
        await conn.execute('DELETE FROM refuelings WHERE id = ?', [copyId]);
    }
    if (ct.receivingVehicleId) {
        try {
            await recalcFuelAverage(conn, ct.receivingVehicleId);
        } catch (e) {
            console.warn('⚠️ [recalcFuelAverage estorno saída comboio]', e.message);
        }
    }

    let valor = sanitizeNumber(ct.valorTotal);
    if (valor === null) {
        valor = (parseFloat(ct.liters) || 0) * await getLegacyAverageFuelPrice(conn, ct.fuelType);
    }
    if (valor > 0) {
        await manageSaidaExpense({ connection: conn, obraId: ct.obraId, date: ct.date, fuelType: ct.fuelType, valueChange: -valor });
    }
    await conn.execute('UPDATE comboio_transactions SET refuelingId = NULL WHERE id = ?', [ct.id]);
};

const getMirrorPartner = async (conn, comboioVehicleId, registroInterno) => {
    try {
        const partner = await ensureComboioPartner(conn, comboioVehicleId);
        if (partner) return { id: partner.id, name: partner.razaoSocial };
    } catch (e) {
        // Sem o partner-espelho a saída continua; partnerId nulo não viola FK.
        console.warn('⚠️ [ensureComboioPartner]', e.message);
    }
    return { id: null, name: registroInterno ? `Comboio ${registroInterno}` : 'Comboio' };
};

const nextAuthNumber = async (conn) => {
    const [counterRows] = await conn.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
    const n = (counterRows[0]?.lastNumber || 0) + 1;
    await conn.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [n]);
    return n;
};

const getObraName = async (conn, obraId) => {
    if (!obraId) return null;
    const [rows] = await conn.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
    return rows[0]?.nome || obraId;
};

// ─── LISTAGENS ──────────────────────────────────────────────────────────────

// GET /comboioTransactions
//   Sem scope/page: array puro (terceirizados e app antigo).
//   Com scope ('historico' | 'pendentes') ou page: { data, total, page, limit }.
//   Filtros: comboioVehicleId, type, obraId, status, startDate, endDate, search.
const getAllComboioTransactions = async (req, res) => {
    try {
        const q = req.query;
        const escopado = !!(q.scope || q.page || q.limit);

        if (!escopado) {
            let sql = 'SELECT * FROM comboio_transactions';
            const params = [];
            if (q.startDate && q.endDate) {
                sql += ' WHERE date >= ? AND date < DATE_ADD(?, INTERVAL 1 DAY)';
                params.push(q.startDate, q.endDate);
            }
            sql += ' ORDER BY date DESC';
            const [rows] = await db.query(sql, params);
            return res.json(rows);
        }

        const where = ['1 = 1'];
        const params = [];
        if (q.scope === 'pendentes') {
            where.push(`ct.status IN (${STATUS_BLOQUEADOS.map(() => '?').join(',')})`);
            params.push(...STATUS_BLOQUEADOS);
        } else if (q.status) {
            where.push('ct.status = ?');
            params.push(q.status);
        }
        if (q.comboioVehicleId) {
            where.push('ct.comboioVehicleId = ?');
            params.push(q.comboioVehicleId);
        }
        if (['entrada', 'saida', 'drenagem'].includes(q.type)) {
            where.push('ct.type = ?');
            params.push(q.type);
        }
        if (q.obraId) {
            where.push('ct.obraId = ?');
            params.push(q.obraId);
        }
        if (q.receivingVehicleId) {
            where.push('ct.receivingVehicleId = ?');
            params.push(q.receivingVehicleId);
        }
        if (q.startDate) {
            where.push('ct.date >= ?');
            params.push(q.startDate);
        }
        if (q.endDate) {
            where.push('ct.date < DATE_ADD(?, INTERVAL 1 DAY)');
            params.push(q.endDate);
        }
        const termo = String(q.search || '').trim();
        if (termo) {
            const like = `%${termo}%`;
            where.push(`(
                CAST(ct.authNumber AS CHAR) LIKE ?
                OR ct.receivingVehicleName LIKE ? OR ct.drainingVehicleName LIKE ?
                OR ct.partnerName LIKE ? OR ct.invoiceNumber LIKE ? OR ct.obraName LIKE ?
                OR rv.placa LIKE ?
            )`);
            params.push(like, like, like, like, like, like, like);
        }

        const base = `
            FROM comboio_transactions ct
            LEFT JOIN vehicles rv ON rv.id = ct.receivingVehicleId
            LEFT JOIN vehicles cv ON cv.id = ct.comboioVehicleId
           WHERE ${where.join(' AND ')}`;

        const limitNum = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 200);
        const pageNum = Math.max(parseInt(q.page, 10) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${base}`, params);
        const [rows] = await db.query(
            `SELECT ct.*, rv.placa AS receivingVehiclePlaca, rv.modelo AS receivingVehicleModelo,
                    cv.registroInterno AS comboioRegistroInterno, cv.placa AS comboioPlaca
             ${base}
             ORDER BY ct.date DESC, ct.authNumber DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );
        res.json({ data: rows, total: Number(total), page: pageNum, limit: limitNum });
    } catch (error) {
        console.error('❌ Erro GET comboio transactions:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// GET /comboioTransactions/pendencias
// Ordens de entrada aguardando baixa + saídas bloqueadas aguardando admin.
const getComboioPendencias = async (req, res) => {
    try {
        const { comboioVehicleId } = req.query;
        const filtroEntrada = comboioVehicleId ? ' AND r.vehicleId = ?' : '';
        const filtroSaida = comboioVehicleId ? ' AND ct.comboioVehicleId = ?' : '';
        const paramComboio = comboioVehicleId ? [comboioVehicleId] : [];

        const [entradas] = await db.query(
            `SELECT r.*, v.registroInterno AS comboioRegistroInterno, v.placa AS comboioPlaca,
                    v.fuelLevels AS comboioFuelLevels, v.fuelCapacity AS comboioFuelCapacity
               FROM refuelings r
               JOIN vehicles v ON v.id = r.vehicleId
              WHERE r.comboioEntrada = 1
                AND r.status IN ('Aberta', 'BloqueadoLeitura', 'BloqueadoOrcamento')${filtroEntrada}
              ORDER BY r.authNumber DESC`,
            paramComboio
        );
        const [saidas] = await db.query(
            `SELECT ct.*, rv.placa AS receivingVehiclePlaca, cv.registroInterno AS comboioRegistroInterno
               FROM comboio_transactions ct
               LEFT JOIN vehicles rv ON rv.id = ct.receivingVehicleId
               LEFT JOIN vehicles cv ON cv.id = ct.comboioVehicleId
              WHERE ct.status IN (${STATUS_BLOQUEADOS.map(() => '?').join(',')})${filtroSaida}
              ORDER BY ct.date DESC`,
            [...STATUS_BLOQUEADOS, ...paramComboio]
        );

        const parse = (v) => {
            if (!v || typeof v !== 'string') return v;
            try { return JSON.parse(v); } catch { return v; }
        };
        res.json({
            entradas: entradas.map(r => ({
                ...r,
                createdBy: parse(r.createdBy),
                confirmedBy: parse(r.confirmedBy),
                comboioFuelLevels: parse(r.comboioFuelLevels),
            })),
            saidas,
        });
    } catch (error) {
        console.error('❌ Erro GET pendências do comboio:', error);
        res.status(500).json({ error: 'Erro ao buscar pendências do comboio.' });
    }
};

// GET /comboioTransactions/resumo?comboioVehicleId&startDate&endDate
// Painel "Análise Detalhada por Comboio" — tudo agregado no banco.
const getComboioResumo = async (req, res) => {
    try {
        const { comboioVehicleId } = req.query;
        if (!comboioVehicleId) return res.status(400).json({ error: 'comboioVehicleId é obrigatório.' });

        const hoje = new Date();
        const endDate = req.query.endDate || hoje.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        const startDate = req.query.startDate || new Date(hoje.getTime() - 29 * 86400000)
            .toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        const periodo = [comboioVehicleId, startDate, endDate];
        const wherePeriodo = 'comboioVehicleId = ? AND date >= ? AND date < DATE_ADD(?, INTERVAL 1 DAY)';

        const [[vehicle]] = await db.query(
            'SELECT id, registroInterno, placa, modelo, fuelLevels, fuelCapacity, obraAtualId FROM vehicles WHERE id = ?',
            [comboioVehicleId]
        );
        if (!vehicle) return res.status(404).json({ error: 'Comboio não encontrado.' });

        const [[totais]] = await db.query(
            `SELECT
                COALESCE(SUM(CASE WHEN type = 'entrada' THEN liters END), 0)      AS entradaLitros,
                COUNT(CASE WHEN type = 'entrada' THEN 1 END)                      AS entradaQtd,
                COALESCE(SUM(CASE WHEN type = 'entrada' THEN valorTotal END), 0)  AS entradaValor,
                COALESCE(SUM(CASE WHEN type = 'saida' THEN liters END), 0)        AS saidaLitros,
                COUNT(CASE WHEN type = 'saida' THEN 1 END)                        AS saidaQtd,
                COALESCE(SUM(CASE WHEN type = 'saida' THEN valorTotal END), 0)    AS saidaValor,
                COALESCE(SUM(CASE WHEN type = 'drenagem' THEN liters END), 0)     AS drenagemLitros,
                COUNT(CASE WHEN type = 'drenagem' THEN 1 END)                     AS drenagemQtd,
                COUNT(DISTINCT CASE WHEN type = 'saida' THEN receivingVehicleId END) AS veiculosAtendidos,
                COUNT(DISTINCT CASE WHEN type = 'saida' THEN obraId END)          AS obrasAtendidas,
                COUNT(CASE WHEN status IN ('BloqueadoLeitura', 'BloqueadoOrcamento') THEN 1 END) AS bloqueadas
             FROM comboio_transactions
             WHERE ${wherePeriodo}`,
            periodo
        );

        const [porObra] = await db.query(
            `SELECT obraId, MAX(obraName) AS obraName, SUM(liters) AS litros, COUNT(*) AS qtd,
                    COALESCE(SUM(valorTotal), 0) AS valor
               FROM comboio_transactions
              WHERE type = 'saida' AND ${wherePeriodo}
              GROUP BY obraId
              ORDER BY litros DESC
              LIMIT 10`,
            periodo
        );

        const [porVeiculo] = await db.query(
            `SELECT ct.receivingVehicleId AS vehicleId, MAX(ct.receivingVehicleName) AS registroInterno,
                    MAX(v.placa) AS placa, MAX(v.modelo) AS modelo, SUM(ct.liters) AS litros, COUNT(*) AS qtd
               FROM comboio_transactions ct
               LEFT JOIN vehicles v ON v.id = ct.receivingVehicleId
              WHERE ct.type = 'saida' AND ct.comboioVehicleId = ?
                AND ct.date >= ? AND ct.date < DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY ct.receivingVehicleId
              ORDER BY litros DESC
              LIMIT 10`,
            periodo
        );

        const [serie] = await db.query(
            `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS dia,
                    COALESCE(SUM(CASE WHEN type = 'entrada' THEN liters END), 0) AS entradas,
                    COALESCE(SUM(CASE WHEN type = 'saida' THEN liters END), 0) AS saidas,
                    COALESCE(SUM(CASE WHEN type = 'drenagem' AND COALESCE(destino, 'comboio') = 'comboio' THEN liters END), 0) AS drenagens
               FROM comboio_transactions
              WHERE ${wherePeriodo}
              GROUP BY dia
              ORDER BY dia`,
            periodo
        );

        // Saldo teórico por tanque (histórico todo): o que ENTROU menos o que SAIU.
        // A diferença para o nível físico (fuelLevels) revela lançamentos faltando
        // ou edição manual do nível no cadastro do veículo.
        const [teorico] = await db.query(
            `SELECT fuelType,
                    SUM(CASE
                        WHEN type = 'entrada' AND status = 'Concluída' THEN liters
                        WHEN type = 'drenagem' AND COALESCE(destino, 'comboio') = 'comboio' THEN liters
                        WHEN type = 'saida' THEN -liters
                        ELSE 0 END) AS saldo
               FROM comboio_transactions
              WHERE comboioVehicleId = ?
              GROUP BY fuelType`,
            [comboioVehicleId]
        );

        const [[ultimaEntrada]] = await db.query(
            `SELECT date, fuelType, liters, pricePerLiter, valorTotal, partnerName, authNumber
               FROM comboio_transactions
              WHERE comboioVehicleId = ? AND type = 'entrada' AND status = 'Concluída'
              ORDER BY date DESC LIMIT 1`,
            [comboioVehicleId]
        );

        const [[{ entradasAbertas }]] = await db.query(
            `SELECT COUNT(*) AS entradasAbertas FROM refuelings
              WHERE comboioEntrada = 1 AND vehicleId = ? AND status IN ('Aberta', 'BloqueadoLeitura', 'BloqueadoOrcamento')`,
            [comboioVehicleId]
        );

        const num = (v) => Number(v) || 0;
        const saldoTeorico = {};
        for (const t of teorico) {
            const key = toComboioTankKey(t.fuelType) || t.fuelType;
            saldoTeorico[key] = (saldoTeorico[key] || 0) + num(t.saldo);
        }

        res.json({
            comboio: {
                ...vehicle,
                fuelLevels: estoque.parseLevels(vehicle.fuelLevels),
                fuelCapacity: num(vehicle.fuelCapacity) || null,
            },
            periodo: { startDate, endDate },
            totais: Object.fromEntries(Object.entries(totais).map(([k, v]) => [k, num(v)])),
            porObra: porObra.map(o => ({ ...o, litros: num(o.litros), qtd: num(o.qtd), valor: num(o.valor) })),
            porVeiculo: porVeiculo.map(v => ({ ...v, litros: num(v.litros), qtd: num(v.qtd) })),
            serie: serie.map(s => ({ dia: s.dia, entradas: num(s.entradas), saidas: num(s.saidas), drenagens: num(s.drenagens) })),
            saldoTeorico,
            ultimaEntrada: ultimaEntrada || null,
            entradasAbertas: num(entradasAbertas),
        });
    } catch (error) {
        console.error('❌ Erro GET resumo do comboio:', error);
        res.status(500).json({ error: 'Erro ao montar o resumo do comboio.' });
    }
};

const getComboioTransactionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Transação não encontrada' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar transação' });
    }
};

// --- ENTRADA DIRETA (compatibilidade) ---
// A tela nova emite ORDEM de entrada (POST /entrada/ordem) e dá baixa depois.
// Este endpoint continua aceitando o lançamento antigo, já abastecido, mas agora
// pelo mesmo caminho da ordem: grava a ordem concluída e sincroniza o estoque.
const createEntradaTransaction = async (req, res) => {
    const body = req.body || {};
    const actor = actorFromReq(req);
    const tankKey = toComboioTankKey(body.fuelType);
    const litros = sanitizeNumber(body.liters);

    if (!body.comboioVehicleId || !body.partnerId) {
        return res.status(400).json({ error: 'Comboio e posto são obrigatórios.' });
    }
    if (!tankKey) return res.status(400).json({ error: 'Combustível inválido para o comboio.' });
    if (!litros || litros <= 0) return res.status(400).json({ error: 'Informe a quantidade de litros.' });

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const comboio = await lockComboio(conn, body.comboioVehicleId);
        if (!comboio || comboio.isComboioVehicle != 1) {
            await conn.rollback();
            return res.status(400).json({ error: 'O veículo informado não é um comboio.' });
        }

        const orderKey = tankKeyToOrderKey(tankKey);
        const invoiceNumber = sanitize(body.invoiceNumber) ? String(body.invoiceNumber).trim() : null;
        if (invoiceNumber) {
            const [dup] = await conn.execute(
                'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? FOR UPDATE',
                [body.partnerId, invoiceNumber]
            );
            if (dup.length > 0) {
                await conn.rollback();
                return res.status(409).json({ error: `A Nota Fiscal ${invoiceNumber} já consta lançada para este posto.` });
            }
        }

        let price = sanitizeNumber(body.pricePerLiter);
        if (!price || price <= 0) {
            const [priceRows] = await conn.query(
                'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType IN (?) AND price > 0 LIMIT 1',
                [body.partnerId, priceKeysFor(orderKey)]
            );
            price = priceRows.length > 0 ? parseFloat(priceRows[0].price) : 0;
        } else if (body.updatePartnerPrice) {
            await conn.execute(
                `INSERT INTO partner_fuel_prices (partnerId, fuelType, price) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE price = VALUES(price)`,
                [body.partnerId, orderKey, price]
            );
        }

        const [partners] = await conn.execute('SELECT razaoSocial FROM partners WHERE id = ?', [body.partnerId]);
        const authNumber = await nextAuthNumber(conn);
        const refuelingId = crypto.randomUUID();
        await conn.execute(
            `INSERT INTO refuelings
                (id, authNumber, vehicleId, partnerId, partnerName, employeeId, obraId, fuelType, data, status,
                 isFillUp, litrosLiberados, litrosAbastecidos, pricePerLiter, invoiceNumber, createdBy, comboioEntrada)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'Concluída', 0, ?, ?, ?, ?, ?, 1)`,
            [
                refuelingId, authNumber, body.comboioVehicleId, body.partnerId,
                partners[0]?.razaoSocial || 'Posto', sanitize(body.employeeId), orderKey, parseDateBRT(body.date),
                litros, litros, price, invoiceNumber, createdByJson(actor),
            ]
        );
        await estoque.syncEntrada(conn, refuelingId, { actor });
        await conn.commit();

        emitComboioSync(req, [body.comboioVehicleId]);
        res.status(201).json({ message: 'Entrada registrada.', id: refuelingId, refuelingOrder: { authNumber } });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ Erro Entrada comboio:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (conn) conn.release();
    }
};

// --- CRIAR SAÍDA (Abastecimento de Veículo pelo Comboio) ---
const createSaidaTransaction = async (req, res) => {
    const body = req.body || {};
    const actor = actorFromReq(req);
    const { comboioVehicleId, receivingVehicleId } = body;
    const tankKey = toComboioTankKey(body.fuelType);
    const litros = sanitizeNumber(body.liters);

    const recusar = (status, payload) => {
        removeUploadedFiles(req);
        return res.status(status).json(payload);
    };

    if (!comboioVehicleId || !receivingVehicleId) return recusar(400, { error: 'Comboio e veículo são obrigatórios.' });
    if (comboioVehicleId === receivingVehicleId) return recusar(400, { error: 'O comboio não pode abastecer a si mesmo.' });
    if (!tankKey) return recusar(400, { error: 'Combustível inválido para o comboio.' });
    if (!litros || litros <= 0) return recusar(400, { error: 'Informe a quantidade de litros.' });

    const clientId = isUuid(body.id) ? body.id : null;
    const fotosJson = buildFotosFromReq(req);
    let conn;
    try {
        conn = await db.getConnection();

        // Idempotência: o app reenvia com o mesmo id quando a rede cai depois
        // do envio. Antes isso estourava PK duplicada (500) e o operador lançava
        // de novo, na dúvida.
        if (clientId) {
            const [[existente]] = await conn.execute(
                'SELECT id, authNumber, status, motivoBloqueio FROM comboio_transactions WHERE id = ?',
                [clientId]
            );
            if (existente) {
                removeUploadedFiles(req);
                return res.status(200).json({
                    message: 'Distribuição já registrada.',
                    idempotent: true,
                    id: existente.id,
                    status: existente.status,
                    motivoBloqueio: existente.motivoBloqueio,
                    refuelingOrder: { authNumber: existente.authNumber },
                });
            }
        }

        await conn.beginTransaction();
        const abortar = async (status, payload) => {
            await conn.rollback();
            return recusar(status, payload);
        };

        const comboio = await lockComboio(conn, comboioVehicleId);
        if (!comboio || comboio.isComboioVehicle != 1) {
            return abortar(400, { error: 'O veículo de origem não é um comboio.' });
        }
        const [[recebedor]] = await conn.execute(
            `SELECT id, registroInterno, placa, tipo, isOutsourced, permiteMultiplosAbastecimentos
               FROM vehicles WHERE id = ?`,
            [receivingVehicleId]
        );
        if (!recebedor) return abortar(404, { error: 'Veículo que recebe não encontrado.' });

        const saldo = getSaldoTanque(comboio, tankKey);
        if (saldo !== null && litros > saldo + TOLERANCIA_SALDO_L) {
            return abortar(409, {
                error: `Saldo insuficiente no comboio: ${saldo.toFixed(2)} L de ${fuelLabel(tankKey)} `
                     + `disponíveis, ${litros.toFixed(2)} L informados. `
                     + 'Dê baixa na entrada de combustível do comboio antes de distribuir.',
                code: 'INSUFFICIENT_COMBOIO_BALANCE',
                saldoDisponivel: saldo,
                litrosSolicitados: litros,
            });
        }

        const obraId = sanitize(body.obraId);
        const avaliacao = await avaliarSaida(conn, recebedor, obraId, body);
        const date = parseDateBRT(body.date);
        const authNumber = await nextAuthNumber(conn);
        const mirror = await getMirrorPartner(conn, comboioVehicleId, comboio.registroInterno);

        let periodoId = null;
        try { periodoId = await getActivePeriodId(conn, comboioVehicleId); }
        catch (e) { console.warn('⚠️ [comboioPeriodo saída]', e.message); }

        const preco = await getCustoUnitarioComboio(conn, comboioVehicleId, tankKey, date);
        const ct = {
            id: clientId || crypto.randomUUID(),
            authNumber,
            type: 'saida',
            status: avaliacao.status,
            motivoBloqueio: avaliacao.motivo,
            date,
            comboioVehicleId,
            receivingVehicleId,
            receivingVehicleName: recebedor.registroInterno || null,
            partnerId: mirror.id,
            partnerName: mirror.name,
            obraId,
            obraName: await getObraName(conn, obraId),
            obra_periodo_id: periodoId,
            employeeId: sanitize(body.employeeId),
            liters: litros,
            fuelType: tankKey,
            pricePerLiter: preco || null,
            valorTotal: Math.round(litros * preco * 100) / 100,
            responsibleUserEmail: actor.email,
            createdByUserId: actor.id != null ? String(actor.id) : null,
            odometro: avaliacao.odometro,
            horimetro: avaliacao.horimetro,
            fotos: fotosJson,
        };

        const fields = Object.keys(ct);
        await conn.execute(
            `INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
            Object.values(ct).map(v => (v === undefined ? null : v))
        );
        await ajustarTanque(conn, comboioVehicleId, tankKey, -litros);

        if (isConcluida(ct.status)) {
            await applySaidaEffects(conn, ct, actor);
        }

        await conn.commit();
        emitComboioSync(req, [comboioVehicleId]);

        const bloqueada = !isConcluida(ct.status);
        if (bloqueada) notificarBloqueio(req, authNumber, ct.status);

        res.status(201).json({
            message: bloqueada
                ? `Saída Nº ${authNumber} registrada, mas BLOQUEADA: ${ct.motivoBloqueio} Aguarde a liberação do administrador.`
                : 'Abastecimento registrado.',
            id: ct.id,
            status: ct.status,
            bloqueada,
            motivoBloqueio: ct.motivoBloqueio,
            refuelingOrder: { authNumber },
        });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        removeUploadedFiles(req);
        console.error('❌ Erro Saída comboio:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (conn) conn.release();
    }
};

// --- LIBERAR SAÍDA BLOQUEADA (admin) ---
// PUT /comboioTransactions/:id/liberar  { odometro?, horimetro? }
const liberarSaida = async (req, res) => {
    if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Apenas administradores podem liberar saídas bloqueadas.' });
    }
    const actor = actorFromReq(req);
    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [[ct]] = await conn.execute('SELECT * FROM comboio_transactions WHERE id = ? FOR UPDATE', [req.params.id]);
        if (!ct) {
            await conn.rollback();
            return res.status(404).json({ error: 'Saída não encontrada.' });
        }
        if (ct.type !== 'saida' || !STATUS_BLOQUEADOS.includes(ct.status)) {
            await conn.rollback();
            return res.status(400).json({ error: 'Esta movimentação não está bloqueada.' });
        }

        // O admin pode corrigir a leitura na liberação.
        const odometro = has(req.body, 'odometro') ? leituraPositiva(req.body.odometro) : ct.odometro;
        const horimetro = has(req.body, 'horimetro') ? leituraPositiva(req.body.horimetro) : ct.horimetro;
        const liberadoPor = JSON.stringify({ id: actor.id, email: actor.email, statusAnterior: ct.status, motivo: ct.motivoBloqueio });

        await conn.execute(
            `UPDATE comboio_transactions
                SET status = 'Concluída', odometro = ?, horimetro = ?, liberadoPor = ?, liberadoEm = NOW()
              WHERE id = ?`,
            [odometro, horimetro, liberadoPor, ct.id]
        );
        await applySaidaEffects(conn, { ...ct, status: 'Concluída', odometro, horimetro }, actor);

        await conn.commit();
        emitComboioSync(req, [ct.comboioVehicleId]);
        res.json({ message: `Saída Nº ${ct.authNumber} liberada.` });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ Erro ao liberar saída do comboio:', error);
        res.status(500).json({ error: 'Erro ao liberar saída: ' + error.message });
    } finally {
        if (conn) conn.release();
    }
};

// --- DRENAGEM ---
const createDrenagemTransaction = async (req, res) => {
    const body = req.body || {};
    const actor = actorFromReq(req);
    const {
        comboioVehicleId, drainingVehicleId, receivingVehicleId,
        reason, odometro, horimetro, obraId, employeeId,
    } = body;

    // Destino: 'comboio' (devolve ao tanque), 'transfusao' (abastece outro
    // equipamento) ou 'eliminado' (combustível descartado). Compatibilidade:
    // registros sem destino explícito com comboio → 'comboio'.
    const destino = sanitize(body.destino) || (comboioVehicleId ? 'comboio' : null);
    if (!['comboio', 'transfusao', 'eliminado'].includes(destino)) {
        return res.status(400).json({ error: 'Destino de drenagem inválido.' });
    }
    if (!drainingVehicleId) {
        return res.status(400).json({ error: 'Veículo de origem obrigatório.' });
    }
    const safeLiters = sanitizeNumber(body.liters);
    if (!safeLiters || safeLiters <= 0) {
        return res.status(400).json({ error: 'Informe a quantidade de litros.' });
    }
    // Para o tanque do comboio a chave precisa ser uma das dele.
    const fuelType = destino === 'comboio' ? toComboioTankKey(body.fuelType) : (sanitize(body.fuelType) || null);
    if (destino === 'comboio' && !fuelType) {
        return res.status(400).json({ error: 'Combustível inválido para o tanque do comboio.' });
    }

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const drenagemDate = parseDateBRT(body.date);
        const transactionId = isUuid(body.id) ? body.id : crypto.randomUUID();
        const createdBy = createdByJson(actor, { origem: 'drenagem' });

        if (destino === 'comboio') {
            if (!comboioVehicleId) throw new Error('Comboio de destino obrigatório.');
            await lockComboio(conn, comboioVehicleId);
        }

        // Nome e obra atual do veículo de origem
        let drainingVehicleName = null;
        let drainingObraId = sanitize(obraId);
        {
            const [vRows] = await conn.execute(
                'SELECT registroInterno, obraAtualId FROM vehicles WHERE id = ?', [drainingVehicleId]
            );
            if (vRows.length > 0) {
                drainingVehicleName = vRows[0].registroInterno;
                if (!drainingObraId) drainingObraId = vRows[0].obraAtualId || null;
            }
        }

        // ── Ajuste negativo na ORIGEM (desconta a litragem da média de consumo) ──
        // Sem leitura (não é ponto de odômetro), litros negativos. recalcFuelAverage
        // usa isso para reduzir a litragem efetiva do intervalo correspondente.
        await conn.execute(
            `INSERT INTO refuelings
                (id, vehicleId, fuelType, data, status, isFillUp,
                 litrosLiberados, litrosAbastecidos, pricePerLiter, partnerName,
                 drenagemTransactionId, createdBy)
             VALUES (?, ?, ?, ?, 'Concluída', 0, ?, ?, 0, 'DRENAGEM', ?, ?)`,
            [
                crypto.randomUUID(), drainingVehicleId, fuelType, drenagemDate,
                -safeLiters, -safeLiters, transactionId, createdBy,
            ]
        );
        await recalcFuelAverage(conn, drainingVehicleId);

        const transactionData = {
            id: transactionId,
            type: 'drenagem',
            status: 'Concluída',
            destino,
            date: drenagemDate,
            drainingVehicleId: sanitize(drainingVehicleId),
            drainingVehicleName: sanitize(drainingVehicleName),
            liters: safeLiters,
            fuelType,
            reason: sanitize(reason),
            responsibleUserEmail: actor.email,
            createdByUserId: actor.id != null ? String(actor.id) : null,
        };

        if (destino === 'comboio') {
            let drenagemPeriodoId = null;
            try { drenagemPeriodoId = await getActivePeriodId(conn, comboioVehicleId); }
            catch (e) { console.warn('⚠️ [comboioPeriodo drenagem]', e.message); }

            transactionData.comboioVehicleId = sanitize(comboioVehicleId);
            transactionData.obra_periodo_id = drenagemPeriodoId;
            await ajustarTanque(conn, comboioVehicleId, fuelType, safeLiters);

        } else if (destino === 'transfusao') {
            if (!receivingVehicleId) throw new Error('Equipamento receptor obrigatório.');

            const newAuthNumber = await nextAuthNumber(conn);
            let receivingVehicleName = null;
            const [rvRows] = await conn.execute('SELECT registroInterno FROM vehicles WHERE id = ?', [receivingVehicleId]);
            if (rvRows.length > 0) receivingVehicleName = rvRows[0].registroInterno;
            const obraName = await getObraName(conn, drainingObraId);

            // Abastecimento normal do receptor (espelho em refuelings, Concluída, custo 0)
            await conn.execute(
                `INSERT INTO refuelings
                    (id, authNumber, vehicleId, partnerName, employeeId, obraId, fuelType, data,
                     status, isFillUp, litrosLiberados, litrosAbastecidos, pricePerLiter,
                     odometro, horimetro, drenagemTransactionId, createdBy)
                 VALUES (?, ?, ?, 'Transfusão (drenagem)', ?, ?, ?, ?, 'Concluída', 0, ?, ?, 0, ?, ?, ?, ?)`,
                [
                    crypto.randomUUID(), newAuthNumber, receivingVehicleId, sanitize(employeeId),
                    sanitize(drainingObraId), fuelType, drenagemDate,
                    safeLiters, safeLiters, leituraPositiva(odometro), leituraPositiva(horimetro),
                    transactionId, createdBy,
                ]
            );
            await updateVehicleReadingLocal(conn, receivingVehicleId, { odometro, horimetro });
            await recalcFuelAverage(conn, receivingVehicleId);

            transactionData.authNumber = newAuthNumber;
            transactionData.receivingVehicleId = sanitize(receivingVehicleId);
            transactionData.receivingVehicleName = sanitize(receivingVehicleName);
            transactionData.obraId = sanitize(drainingObraId);
            transactionData.obraName = sanitize(obraName);
            transactionData.employeeId = sanitize(employeeId);
            transactionData.odometro = leituraPositiva(odometro);
            transactionData.horimetro = leituraPositiva(horimetro);

        } else if (destino === 'eliminado') {
            // Registra a perda como custo na obra do veículo de origem, pelo custo
            // do diesel (última entrada do tanque equivalente). O valor fica
            // gravado para o estorno usar exatamente o mesmo número.
            transactionData.obraId = sanitize(drainingObraId);
            const preco = await getCustoUnitarioComboio(conn, null, toComboioTankKey(fuelType), drenagemDate);
            const lossValue = Math.round(safeLiters * preco * 100) / 100;
            transactionData.pricePerLiter = preco || null;
            transactionData.valorTotal = lossValue;
            if (drainingObraId && lossValue > 0) {
                await manageDrenagemDescarteExpense({
                    connection: conn, obraId: drainingObraId, date: drenagemDate, fuelType, valueChange: lossValue
                });
            }
        }

        const fields = Object.keys(transactionData);
        await conn.execute(
            `INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
            Object.values(transactionData).map(v => (v === undefined ? null : v))
        );

        await conn.commit();
        emitComboioSync(req, [comboioVehicleId]);
        res.status(201).json({ message: 'Drenagem registrada.', id: transactionId });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ Erro Drenagem:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (conn) conn.release();
    }
};

// --- DELETE ---
// ?force=1 (só admin): permite estornar mesmo que o tanque fique negativo.
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === '1' && isAdmin(req);

    // Entrada vinculada a ordem: a exclusão é da ORDEM (estorna crédito do posto,
    // despesa e tanque pelo mesmo caminho do Abastecimento).
    // Só delega quando a ordem vinculada está marcada como entrada de comboio —
    // é essa marca que faz deleteRefuelingOrder estornar o tanque. Sem ela
    // (vínculo antigo não marcado), cai no caminho legado abaixo.
    try {
        const [[previa]] = await db.execute(
            `SELECT ct.type, ct.refuelingId, r.comboioEntrada
               FROM comboio_transactions ct
               LEFT JOIN refuelings r ON r.id = ct.refuelingId
              WHERE ct.id = ?`,
            [id]
        );
        if (!previa) return res.status(404).json({ error: 'Transação não encontrada' });
        if (previa.type === 'entrada' && previa.refuelingId && Number(previa.comboioEntrada) === 1) {
            const refuelingController = require('./refuelingController');
            req.params.id = previa.refuelingId;
            return refuelingController.deleteRefuelingOrder(req, res);
        }
    } catch (error) {
        console.error('❌ Erro Delete (prévia):', error);
        return res.status(500).json({ error: 'Erro ao deletar.' });
    }

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [rows] = await conn.execute('SELECT * FROM comboio_transactions WHERE id = ? FOR UPDATE', [id]);
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Transação não encontrada' });
        }
        const t = rows[0];
        const litros = parseFloat(t.liters) || 0;

        // Estorno que retira litros do tanque: não pode deixá-lo negativo.
        const conferirRetirada = async (comboioVehicleId, tankKey) => {
            const v = await lockComboio(conn, comboioVehicleId);
            const saldo = getSaldoTanque(v, tankKey);
            if (!force && saldo !== null && saldo - litros < -TOLERANCIA_SALDO_L) {
                return {
                    error: `Excluir deixaria o tanque do comboio negativo: saldo ${saldo.toFixed(2)} L, `
                         + `lançamento de ${litros.toFixed(2)} L. O combustível já foi distribuído.`,
                    code: 'NEGATIVE_STOCK',
                    saldo,
                    litros,
                };
            }
            return null;
        };

        if (t.type === 'entrada') {
            // Entrada antiga sem ordem marcada (o backfill não achou par único ou
            // não marcou a ordem). Estorna o tanque e remove a cópia, se houver —
            // antes ela ficava no histórico e na despesa do posto.
            const tankKey = toComboioTankKey(t.fuelType);
            const erro = await conferirRetirada(t.comboioVehicleId, tankKey);
            if (erro) {
                await conn.rollback();
                return res.status(409).json(erro);
            }
            await ajustarTanque(conn, t.comboioVehicleId, tankKey, -litros);
            if (t.refuelingId) {
                await conn.execute('UPDATE expenses SET refuelingId = NULL WHERE refuelingId = ?', [t.refuelingId]);
                await conn.execute('DELETE FROM refuelings WHERE id = ?', [t.refuelingId]);
            }
            if (t.partnerId && t.fuelType) {
                await estoque.updateEstoqueExpense(conn, t.obraId, t.partnerId, t.fuelType, t.date);
            }

        } else if (t.type === 'saida') {
            await lockComboio(conn, t.comboioVehicleId);
            if (isConcluida(t.status)) {
                await revertSaidaEffects(conn, t);
            }
            await ajustarTanque(conn, t.comboioVehicleId, toComboioTankKey(t.fuelType), litros);

        } else if (t.type === 'drenagem') {
            // Destino legado (registros antigos sem coluna): sempre 'comboio'.
            const destino = t.destino || 'comboio';

            if (destino === 'comboio' && t.comboioVehicleId) {
                const erro = await conferirRetirada(t.comboioVehicleId, toComboioTankKey(t.fuelType));
                if (erro) {
                    await conn.rollback();
                    return res.status(409).json(erro);
                }
            }

            // Remove os refuelings-espelho (ajuste negativo da origem e, na
            // transfusão, o abastecimento do receptor) e recalcula as médias.
            const [espelhos] = await conn.execute(
                'SELECT id, vehicleId FROM refuelings WHERE drenagemTransactionId = ?', [t.id]
            );
            for (const e of espelhos) {
                await conn.execute('UPDATE expenses SET refuelingId = NULL WHERE refuelingId = ?', [e.id]);
            }
            await conn.execute('DELETE FROM refuelings WHERE drenagemTransactionId = ?', [t.id]);
            for (const vehicleId of new Set(espelhos.map(e => e.vehicleId).filter(Boolean))) {
                await recalcFuelAverage(conn, vehicleId);
            }
            // Fallback para drenagens antigas (pré-espelho): recalcula a origem.
            if (espelhos.length === 0 && t.drainingVehicleId) {
                await recalcFuelAverage(conn, t.drainingVehicleId);
            }

            if (destino === 'comboio' && t.comboioVehicleId) {
                await ajustarTanque(conn, t.comboioVehicleId, toComboioTankKey(t.fuelType), -litros);
                // Registros legados também subtraíam do estoque da origem — devolve.
                if (!t.destino && t.drainingVehicleId) {
                    await ajustarTanque(conn, t.drainingVehicleId, toComboioTankKey(t.fuelType), litros);
                }
            } else if (destino === 'eliminado' && t.obraId) {
                let valor = sanitizeNumber(t.valorTotal);
                if (valor === null) valor = litros * await getLegacyAverageFuelPrice(conn, t.fuelType);
                await manageDrenagemDescarteExpense({
                    connection: conn, obraId: t.obraId, date: t.date, fuelType: t.fuelType, valueChange: -valor
                });
            }
        }

        await conn.execute('DELETE FROM comboio_transactions WHERE id = ?', [id]);
        await conn.commit();

        if (t.type === 'saida') removeFotoFiles(t.fotos);
        emitComboioSync(req, [t.comboioVehicleId]);
        res.status(204).end();
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ Erro Delete comboio:', error);
        res.status(500).json({ error: 'Erro ao deletar.' });
    } finally {
        if (conn) conn.release();
    }
};

// --- UPDATE ---
// Saída: litros, combustível, data, obra, motorista e leitura. O veículo que
// recebeu não muda (exclua e lance de novo). Revalida saldo e, quando leitura ou
// obra mudam, as travas — a saída pode ficar bloqueada ou ser liberada.
// Drenagem: só data e motivo. Entrada: edita-se pela ordem (baixa).
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const actor = actorFromReq(req);

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [[old]] = await conn.execute('SELECT * FROM comboio_transactions WHERE id = ? FOR UPDATE', [id]);
        if (!old) {
            await conn.rollback();
            return res.status(404).json({ error: 'Transação não encontrada' });
        }

        if (old.type === 'entrada') {
            await conn.rollback();
            return res.status(409).json({
                error: old.refuelingId
                    ? 'Entradas são editadas pela ordem de entrada (botão Baixa/Editar na lista de ordens).'
                    : 'Entrada antiga sem vínculo com ordem: exclua e lance novamente.',
                code: 'USE_ENTRADA_ORDER',
                refuelingId: old.refuelingId || null,
            });
        }

        if (old.type === 'drenagem') {
            const mudouLitros = has(body, 'liters') && Math.abs((sanitizeNumber(body.liters) || 0) - parseFloat(old.liters)) > 0.001;
            const mudouCombustivel = has(body, 'fuelType') && toComboioTankKey(body.fuelType) !== toComboioTankKey(old.fuelType);
            const mudouDestino = has(body, 'destino') && body.destino !== (old.destino || 'comboio');
            if (mudouLitros || mudouCombustivel || mudouDestino) {
                await conn.rollback();
                return res.status(409).json({ error: 'Na drenagem só data e motivo podem ser alterados. Para mudar litros, combustível ou destino, exclua e registre novamente.' });
            }
            const novaData = has(body, 'date') ? parseDateBRT(body.date) : old.date;
            const novoMotivo = has(body, 'reason') ? sanitize(body.reason) : old.reason;
            await conn.execute('UPDATE comboio_transactions SET date = ?, reason = ? WHERE id = ?', [novaData, novoMotivo, id]);
            await conn.execute('UPDATE refuelings SET data = ? WHERE drenagemTransactionId = ?', [novaData, id]);
            await conn.commit();
            emitComboioSync(req, [old.comboioVehicleId]);
            return res.json({ message: 'Drenagem atualizada.' });
        }

        // ── SAÍDA ──
        const novo = {
            liters: has(body, 'liters') ? sanitizeNumber(body.liters) : parseFloat(old.liters),
            tankKey: has(body, 'fuelType') ? toComboioTankKey(body.fuelType) : toComboioTankKey(old.fuelType),
            date: has(body, 'date') ? parseDateBRT(body.date) : old.date,
            obraId: has(body, 'obraId') ? sanitize(body.obraId) : old.obraId,
            employeeId: has(body, 'employeeId') ? sanitize(body.employeeId) : old.employeeId,
        };
        if (!novo.liters || novo.liters <= 0) {
            await conn.rollback();
            return res.status(400).json({ error: 'Informe a quantidade de litros.' });
        }
        if (!novo.tankKey) {
            await conn.rollback();
            return res.status(400).json({ error: 'Combustível inválido para o comboio.' });
        }

        const [[recebedor]] = await conn.execute(
            'SELECT id, registroInterno, tipo, isOutsourced, permiteMultiplosAbastecimentos FROM vehicles WHERE id = ?',
            [old.receivingVehicleId]
        );
        if (!recebedor) {
            await conn.rollback();
            return res.status(404).json({ error: 'Veículo que recebeu não encontrado.' });
        }

        await lockComboio(conn, old.comboioVehicleId);
        if (isConcluida(old.status)) await revertSaidaEffects(conn, old);
        await ajustarTanque(conn, old.comboioVehicleId, toComboioTankKey(old.fuelType), parseFloat(old.liters) || 0);

        const comboio = await lockComboio(conn, old.comboioVehicleId);
        const saldo = getSaldoTanque(comboio, novo.tankKey);
        if (saldo !== null && novo.liters > saldo + TOLERANCIA_SALDO_L) {
            await conn.rollback();
            return res.status(409).json({
                error: `Saldo insuficiente no comboio: ${saldo.toFixed(2)} L de ${fuelLabel(novo.tankKey)} disponíveis.`,
                code: 'INSUFFICIENT_COMBOIO_BALANCE',
                saldoDisponivel: saldo,
            });
        }

        const leituras = {
            odometro: has(body, 'odometro') ? body.odometro : old.odometro,
            horimetro: has(body, 'horimetro') ? body.horimetro : old.horimetro,
        };
        const mudouLeitura = leituraPositiva(leituras.odometro) !== leituraPositiva(old.odometro)
            || leituraPositiva(leituras.horimetro) !== leituraPositiva(old.horimetro);
        const mudouObra = (novo.obraId || null) !== (old.obraId || null);

        const avaliacao = await avaliarSaida(conn, recebedor, novo.obraId, leituras, {
            checarLeitura: mudouLeitura || old.status === 'BloqueadoLeitura',
            checarOrcamento: mudouObra || old.status === 'BloqueadoOrcamento',
        });

        await ajustarTanque(conn, old.comboioVehicleId, novo.tankKey, -novo.liters);

        const mudouCusto = novo.tankKey !== toComboioTankKey(old.fuelType)
            || new Date(novo.date).getTime() !== new Date(old.date).getTime()
            || sanitizeNumber(old.pricePerLiter) === null;
        const preco = mudouCusto
            ? await getCustoUnitarioComboio(conn, old.comboioVehicleId, novo.tankKey, novo.date)
            : parseFloat(old.pricePerLiter);

        const atualizado = {
            ...old,
            liters: novo.liters,
            fuelType: novo.tankKey,
            date: novo.date,
            obraId: novo.obraId,
            obraName: mudouObra ? await getObraName(conn, novo.obraId) : old.obraName,
            employeeId: novo.employeeId,
            odometro: avaliacao.odometro,
            horimetro: avaliacao.horimetro,
            status: avaliacao.status,
            motivoBloqueio: avaliacao.motivo,
            pricePerLiter: preco || null,
            valorTotal: Math.round(novo.liters * (preco || 0) * 100) / 100,
            refuelingId: null,
        };

        await conn.execute(
            `UPDATE comboio_transactions
                SET liters = ?, fuelType = ?, date = ?, obraId = ?, obraName = ?, employeeId = ?,
                    odometro = ?, horimetro = ?, status = ?, motivoBloqueio = ?,
                    pricePerLiter = ?, valorTotal = ?, refuelingId = NULL
              WHERE id = ?`,
            [
                atualizado.liters, atualizado.fuelType, atualizado.date, atualizado.obraId, atualizado.obraName,
                atualizado.employeeId, atualizado.odometro, atualizado.horimetro, atualizado.status,
                atualizado.motivoBloqueio, atualizado.pricePerLiter, atualizado.valorTotal, id,
            ]
        );

        if (isConcluida(atualizado.status)) {
            await applySaidaEffects(conn, atualizado, actor);
        }

        await conn.commit();
        emitComboioSync(req, [old.comboioVehicleId]);

        const bloqueada = !isConcluida(atualizado.status);
        if (bloqueada && isConcluida(old.status)) notificarBloqueio(req, old.authNumber, atualizado.status);

        res.json({
            message: bloqueada
                ? `Saída atualizada, mas BLOQUEADA: ${atualizado.motivoBloqueio}`
                : 'Transação atualizada com sucesso',
            status: atualizado.status,
            bloqueada,
            motivoBloqueio: atualizado.motivoBloqueio,
        });
    } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ Erro Update comboio:', e);
        res.status(500).json({ error: e.message });
    } finally {
        if (conn) conn.release();
    }
};

module.exports = {
    getAllComboioTransactions,
    getComboioPendencias,
    getComboioResumo,
    getComboioTransactionById,
    deleteTransaction,
    createEntradaTransaction,
    createSaidaTransaction,
    liberarSaida,
    createDrenagemTransaction,
    updateTransaction,
    uploadSaidaFotos,
    COMBOIO_TANK_KEYS,
};
