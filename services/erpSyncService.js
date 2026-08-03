// services/erpSyncService.js
// ─────────────────────────────────────────────────────────────────────────────
// Ponte de sincronização FrotasMAK → Odoo (ERP financeiro-fiscal).
// Ver ../../IMPLANTACAO_ERP_ODOO.md.
//
// INERTE POR PADRÃO: só age quando TODAS as envs estiverem configuradas
//   ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
// Sem elas, isConfigured() = false e processQueue() retorna imediatamente —
// nada é chamado em produção enquanto o Odoo não estiver no ar.
//
// Comunicação: Odoo External API via JSON-RPC (endpoint /jsonrpc), usando a
// API key do usuário técnico como "password" no execute_kw (Odoo 14+).
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const crypto = require('crypto');
const db = require('../database');

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;
const MAX_ATTEMPTS = parseInt(process.env.ODOO_SYNC_MAX_ATTEMPTS || '5', 10);

// Mapa entidade FrotasMAK → tabela cuja coluna odoo_move_id recebe o ID da fatura.
const MOVE_TABLE = {
    order: 'orders',
    terceiro_pagamento: 'terceirizado_pagamentos',
    expense: 'expenses',
    fine: 'fines',
};

let _uid = null;      // cache do uid autenticado
let _running = false; // trava reentrância do worker

function isConfigured() {
    return Boolean(ODOO_URL && ODOO_DB && ODOO_USER && ODOO_API_KEY);
}

async function jsonRpc(service, method, args) {
    const base = ODOO_URL.replace(/\/+$/, '');
    const { data } = await axios.post(`${base}/jsonrpc`, {
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: Date.now(),
    }, { timeout: 30000 });
    if (data && data.error) {
        const msg = data.error?.data?.message || data.error?.message || 'erro Odoo desconhecido';
        throw new Error(`Odoo RPC: ${msg}`);
    }
    return data ? data.result : undefined;
}

async function authenticate() {
    if (_uid) return _uid;
    _uid = await jsonRpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
    if (!_uid) {
        throw new Error('autenticação Odoo falhou (uid vazio) — verifique ODOO_DB/ODOO_USER/ODOO_API_KEY');
    }
    return _uid;
}

async function execKw(model, method, args = [], kwargs = {}) {
    const uid = await authenticate();
    return jsonRpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

// ── Mestres: garantem o registro correspondente no Odoo (idempotente) ────────
// Grava o ID do Odoo de volta na linha do FrotasMAK para não recriar.

async function ensurePartner(partnerId) {
    const [rows] = await db.query('SELECT * FROM partners WHERE id = ?', [partnerId]);
    if (!rows.length) throw new Error(`parceiro ${partnerId} não encontrado no FrotasMAK`);
    const p = rows[0];
    if (p.odoo_partner_id) return p.odoo_partner_id;

    const vals = {
        name: p.razaoSocial || p.nomeFantasia || 'Parceiro sem nome',
        is_company: (p.tipoPessoa || 'juridica') === 'juridica',
        supplier_rank: 1,
        street: p.endereco || false,
        city: p.cidade || false,
        email: p.email || false,
        phone: p.telefone || false,
        // TODO(Fase 1, validar no ambiente Odoo): campos fiscais da localização
        // OCA l10n_br_base — os nomes exatos (ex.: cnpj_cpf, inscr_est) devem ser
        // confirmados na instância antes de habilitar. Mantidos fora do payload
        // até validarmos para não quebrar o create.
        // cnpj_cpf: p.cnpj || false,
        // inscr_est: p.inscricaoEstadual || false,
    };
    const odooId = await execKw('res.partner', 'create', [vals]);
    await db.query('UPDATE partners SET odoo_partner_id = ? WHERE id = ?', [odooId, partnerId]);
    return odooId;
}

async function ensureAnalytic(obraId) {
    const [rows] = await db.query('SELECT * FROM obras WHERE id = ?', [obraId]);
    if (!rows.length) throw new Error(`obra ${obraId} não encontrada no FrotasMAK`);
    const o = rows[0];
    if (o.odoo_analytic_id) return o.odoo_analytic_id;

    const vals = { name: o.nome || o.descricao || `Obra ${obraId}` };
    // NOTA(Fase 1): no Odoo 17+/18 a conta analítica pode exigir plan_id
    // (account.analytic.plan). Se o create falhar por isso, defina um plano
    // default no Odoo ou informe plan_id aqui.
    const odooId = await execKw('account.analytic.account', 'create', [vals]);
    await db.query('UPDATE obras SET odoo_analytic_id = ? WHERE id = ?', [odooId, obraId]);
    return odooId;
}

// ── Contas a pagar (Fase 1): cria uma fatura de fornecedor no Odoo ───────────
// payload: { partnerId, obraId?, invoiceDate?, ref?, lines: [{name, quantity, price_unit}] }
async function upsertVendorBill(entityType, entityId, payload) {
    const table = MOVE_TABLE[entityType];

    // Idempotência dura: se a origem já tem odoo_move_id, não recria nem altera
    // (política de atualização/estorno de fatura fica para refino da Fase 1).
    if (table) {
        const [r] = await db.query(`SELECT odoo_move_id FROM ${table} WHERE id = ?`, [entityId]);
        if (r.length && r[0].odoo_move_id) return r[0].odoo_move_id;
    }

    if (!payload || !payload.partnerId) {
        throw new Error('payload sem partnerId — impossível criar fatura de fornecedor');
    }

    const partnerOdooId = await ensurePartner(payload.partnerId);
    const analyticId = payload.obraId ? await ensureAnalytic(payload.obraId) : null;

    const lines = (payload.lines || []).map((l) => [0, 0, {
        name: l.name || 'Item',
        quantity: Number(l.quantity) || 1,
        price_unit: Number(l.price_unit) || 0,
        ...(analyticId ? { analytic_distribution: { [analyticId]: 100 } } : {}),
    }]);

    const vals = {
        move_type: 'in_invoice',
        partner_id: partnerOdooId,
        ref: payload.ref || `${entityType} ${entityId}`,
        invoice_line_ids: lines,
    };
    if (payload.invoiceDate) vals.invoice_date = payload.invoiceDate;

    const moveId = await execKw('account.move', 'create', [vals]);
    if (table) {
        await db.query(`UPDATE ${table} SET odoo_move_id = ? WHERE id = ?`, [moveId, entityId]);
    }
    return moveId;
}

// ── Fila ─────────────────────────────────────────────────────────────────────

// Enfileira um evento de sincronização. Idempotente por (entity_type, entity_id,
// operation): reenfileirar o mesmo evento atualiza o payload e reprocessa.
async function enqueue(entityType, entityId, operation, payload = null) {
    const id = crypto.randomUUID();
    try {
        await db.query(
            `INSERT INTO erp_sync_queue (id, entity_type, entity_id, operation, payload, status)
             VALUES (?, ?, ?, ?, ?, 'pending')
             ON DUPLICATE KEY UPDATE payload = VALUES(payload), status = 'pending',
                                     attempts = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP`,
            [id, entityType, String(entityId), operation, payload ? JSON.stringify(payload) : null]
        );
    } catch (e) {
        console.warn('⚠️ [erp-sync] enqueue falhou:', e.message);
    }
}

async function handleJob(job) {
    const payload = job.payload
        ? (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload)
        : {};
    switch (job.operation) {
        case 'upsert_vendor_bill':
            return upsertVendorBill(job.entity_type, job.entity_id, payload);
        default:
            throw new Error(`operação desconhecida: ${job.operation}`);
    }
}

// Processa a fila. Chamado pelo cron (cronService.js). Reentrância travada por
// _running; claim atômico por linha evita processamento duplicado.
async function processQueue() {
    if (!isConfigured() || _running) return;
    _running = true;
    try {
        const [rows] = await db.query(
            `SELECT * FROM erp_sync_queue
              WHERE status = 'pending' AND attempts < ?
              ORDER BY created_at ASC LIMIT 20`,
            [MAX_ATTEMPTS]
        );
        for (const job of rows) {
            const [claim] = await db.query(
                `UPDATE erp_sync_queue SET status = 'processing' WHERE id = ? AND status = 'pending'`,
                [job.id]
            );
            if (!claim.affectedRows) continue; // outra execução já pegou

            try {
                const result = await handleJob(job);
                await db.query(
                    `UPDATE erp_sync_queue SET status = 'done', odoo_result = ?, last_error = NULL WHERE id = ?`,
                    [JSON.stringify({ result }), job.id]
                );
                console.log(`✅ [erp-sync] ${job.entity_type}/${job.entity_id} (${job.operation}) → Odoo #${result}`);
            } catch (err) {
                const attempts = (job.attempts || 0) + 1;
                const status = attempts >= MAX_ATTEMPTS ? 'error' : 'pending';
                await db.query(
                    `UPDATE erp_sync_queue SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
                    [status, attempts, String(err.message).slice(0, 2000), job.id]
                );
                console.warn(`⚠️ [erp-sync] ${job.entity_type}/${job.entity_id} falhou (tentativa ${attempts}/${MAX_ATTEMPTS}): ${err.message}`);
            }
        }
    } catch (e) {
        console.error('❌ [erp-sync] processQueue:', e.message);
    } finally {
        _running = false;
    }
}

module.exports = {
    isConfigured,
    enqueue,
    processQueue,
    // expostos para uso direto/teste
    ensurePartner,
    ensureAnalytic,
    upsertVendorBill,
    execKw,
};
