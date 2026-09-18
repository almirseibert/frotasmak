// services/orderDelivery.js
// Rastreamento de entrega das ordens de abastecimento.
//
// Motivo: até então o envio da ordem ao posto era fire-and-forget — o
// controller respondia 201 antes de qualquer tentativa, e a falha morria
// num console.warn. Quem emitiu a ordem nunca sabia se o posto recebeu.
//
// Aqui cada tentativa (por destinatário e por canal) vira uma linha em
// `order_notifications`, com o payload da ordem guardado para permitir
// reenvio automático (fila de retentativa) ou manual (botão na tela).

const crypto = require('crypto');
const db = require('../database');

// ─── Status possíveis ────────────────────────────────────────────────────────
// PENDENTE     — registrada, ainda não tentou (ou tentando agora)
// ENVIADO      — confirmado pelo canal
// PARCIAL      — mensagem foi, mas o PDF não (falhou no WhatsApp ou não foi gerado)
// FALHA        — tentativa deu erro; elegível para retentativa
// SEM_CONTATO  — canal habilitado mas sem número/e-mail cadastrado
// DESATIVADO   — canal desligado no cadastro do parceiro (não é erro)
const STATUS = {
    PENDENTE:    'PENDENTE',
    ENVIADO:     'ENVIADO',
    PARCIAL:     'PARCIAL',
    FALHA:       'FALHA',
    SEM_CONTATO: 'SEM_CONTATO',
    DESATIVADO:  'DESATIVADO',
};

// Status que representam "não chegou ao posto e precisa de ação humana"
const STATUS_PROBLEMA = [STATUS.FALHA, STATUS.SEM_CONTATO, STATUS.PENDENTE];

let _ensured = false;

// Cria a tabela sob demanda (mesmo padrão das migrações inline do server.js).
const ensureTable = async () => {
    if (_ensured) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS order_notifications (
            id                VARCHAR(36)  NOT NULL PRIMARY KEY,
            authNumber        INT UNSIGNED DEFAULT NULL,
            tipo              VARCHAR(40)  DEFAULT NULL,
            destinatario_tipo VARCHAR(20)  NOT NULL,
            partnerId         VARCHAR(64)  DEFAULT NULL,
            destinatario_nome VARCHAR(255) DEFAULT NULL,
            canal             VARCHAR(20)  NOT NULL,
            destino           VARCHAR(255) DEFAULT NULL,
            status            VARCHAR(20)  NOT NULL DEFAULT 'PENDENTE',
            erro              TEXT         DEFAULT NULL,
            tentativas        INT          NOT NULL DEFAULT 0,
            order_json        LONGTEXT     DEFAULT NULL,
            ultima_tentativa  DATETIME     DEFAULT NULL,
            created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ordem_dest_canal (authNumber, destinatario_tipo, canal),
            KEY idx_status (status),
            KEY idx_auth (authNumber),
            KEY idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    _ensured = true;
};

// Upsert de uma tentativa. Chave natural: (authNumber, destinatario_tipo, canal),
// então reenviar a mesma ordem atualiza a linha em vez de duplicar.
//
// `incrementaTentativa` só é true quando houve de fato uma chamada ao canal —
// DESATIVADO/SEM_CONTATO não contam como tentativa.
const registrar = async ({
    authNumber, tipo, destinatarioTipo, partnerId, destinatarioNome,
    canal, destino, status, erro = null, order = null, incrementaTentativa = false,
}) => {
    try {
        await ensureTable();
        const orderJson = order ? JSON.stringify(order) : null;
        const errStr = erro == null ? null : String(erro).slice(0, 2000);
        await db.query(
            `INSERT INTO order_notifications
               (id, authNumber, tipo, destinatario_tipo, partnerId, destinatario_nome,
                canal, destino, status, erro, tentativas, order_json, ultima_tentativa)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                status           = VALUES(status),
                erro             = VALUES(erro),
                destino          = VALUES(destino),
                destinatario_nome= VALUES(destinatario_nome),
                tentativas       = tentativas + ?,
                order_json       = COALESCE(VALUES(order_json), order_json),
                ultima_tentativa = COALESCE(VALUES(ultima_tentativa), ultima_tentativa)`,
            [
                crypto.randomUUID(), authNumber ?? null, tipo ?? null, destinatarioTipo,
                partnerId ?? null, destinatarioNome ?? null, canal, destino ?? null,
                status, errStr, incrementaTentativa ? 1 : 0, orderJson,
                incrementaTentativa ? new Date() : null,
                incrementaTentativa ? 1 : 0,
            ]
        );
    } catch (e) {
        // Rastreamento nunca pode derrubar o envio em si.
        console.error('[orderDelivery] falha ao registrar tentativa:', e.message);
    }
};

// Resumo por ordem, no formato que o frontend consome para o badge.
// Retorna { [authNumber]: { resumo, canais: [...] } }
// resumo: 'entregue' | 'parcial' | 'falha' | 'sem_canal' | 'pendente'
const resumirPorOrdem = (linhas) => {
    const porOrdem = {};
    for (const l of linhas) {
        const key = String(l.authNumber);
        if (!porOrdem[key]) porOrdem[key] = { authNumber: l.authNumber, canais: [] };
        porOrdem[key].canais.push(l);
    }
    for (const key of Object.keys(porOrdem)) {
        const canais = porOrdem[key].canais;
        // Só interessam os canais que deveriam ter entregue algo.
        const relevantes = canais.filter(c => c.status !== STATUS.DESATIVADO);
        let resumo;
        if (relevantes.length === 0) {
            // Todos os canais desligados no cadastro do posto — ninguém foi avisado.
            resumo = 'sem_canal';
        } else if (relevantes.some(c => c.status === STATUS.ENVIADO)) {
            resumo = relevantes.some(c => c.status === STATUS.FALHA || c.status === STATUS.PARCIAL)
                ? 'parcial' : 'entregue';
        } else if (relevantes.some(c => c.status === STATUS.PARCIAL)) {
            resumo = 'parcial';
        } else if (relevantes.some(c => c.status === STATUS.FALHA)) {
            resumo = 'falha';
        } else if (relevantes.every(c => c.status === STATUS.SEM_CONTATO)) {
            resumo = 'sem_canal';
        } else {
            resumo = 'pendente';
        }
        porOrdem[key].resumo = resumo;
    }
    return porOrdem;
};

const buscarPorAuthNumbers = async (authNumbers) => {
    await ensureTable();
    if (!authNumbers || authNumbers.length === 0) return {};
    const placeholders = authNumbers.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT id, authNumber, tipo, destinatario_tipo, destinatario_nome, canal,
                destino, status, erro, tentativas, ultima_tentativa, created_at
           FROM order_notifications
          WHERE authNumber IN (${placeholders})`,
        authNumbers
    );
    return resumirPorOrdem(rows);
};

// Pendências abertas — alimenta o painel admin e o alerta de "no escuro".
const listarPendencias = async ({ dias = 7, limit = 200 } = {}) => {
    await ensureTable();
    const placeholders = STATUS_PROBLEMA.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT id, authNumber, tipo, destinatario_tipo, destinatario_nome, canal,
                destino, status, erro, tentativas, ultima_tentativa, created_at
           FROM order_notifications
          WHERE status IN (${placeholders})
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY created_at DESC
          LIMIT ?`,
        [...STATUS_PROBLEMA, dias, limit]
    );
    return rows;
};

const contarPendencias = async ({ dias = 7 } = {}) => {
    await ensureTable();
    const placeholders = STATUS_PROBLEMA.map(() => '?').join(',');
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS total FROM order_notifications
          WHERE status IN (${placeholders})
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [...STATUS_PROBLEMA, dias]
    );
    return Number(row?.total || 0);
};

module.exports = {
    STATUS,
    STATUS_PROBLEMA,
    ensureTable,
    registrar,
    buscarPorAuthNumbers,
    listarPendencias,
    contarPendencias,
    resumirPorOrdem,
};
