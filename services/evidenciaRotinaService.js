// backend/services/evidenciaRotinaService.js
// -----------------------------------------------------------------------------
// Rotinas semanais — resolução da config em 3 níveis e materialização da agenda.
// A matemática do agendamento é pura e vive em utils/evidenciaRotinas.js; aqui só
// existe I/O. Ver o cabeçalho daquele arquivo para o porquê da separação.
// -----------------------------------------------------------------------------
const { randomUUID } = require('crypto');
const {
    ROTINA_PADRAO, TIPOS_ROTINA, rotinasDevidas,
} = require('../utils/evidenciaRotinas');
const { nEsimoDiaSolicitado, contarDiasSolicitados } = require('../utils/evidenciaRegras');

// ---- Cache da config resolvida (TTL curto, mesmo espírito do authMiddleware) ----
const TTL_MS = 60 * 1000;
const _cache = new Map(); // `${obraId}|${veiculoId}` -> { at, regra }
const invalidarCacheRotina = () => _cache.clear();

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { const p = JSON.parse(v); return p ?? fallback; } catch { return fallback; }
};

// Mescla campo a campo: o nível mais específico NÃO-NULO vence. É por isso que as
// colunas de evidencia_rotina_config são DEFAULT NULL — NULL significa "herda".
function _mesclar(base, row) {
    if (!row) return base;
    const out = { ...base };
    if (row.ativa != null) out.ativa = row.ativa !== 0;
    if (row.freq_dias != null) out.freq_dias = Number(row.freq_dias);
    if (row.defasagem_dias != null) out.defasagem_dias = Number(row.defasagem_dias);
    if (row.carry_dias != null) out.carry_dias = Number(row.carry_dias);
    if (row.alternar_ordem != null) out.alternar_ordem = row.alternar_ordem !== 0;
    const tipos = parseJson(row.tipos, null);
    if (Array.isArray(tipos) && tipos.length) out.tipos = tipos.filter(t => TIPOS_ROTINA.includes(t));
    return out;
}

/** ROTINA_PADRAO <- global <- obra <- veiculo. Uma query só. */
async function resolveRegraRotina(db, obraId, veiculoId) {
    const chave = `${obraId || ''}|${veiculoId || ''}`;
    const hit = _cache.get(chave);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.regra;

    let rows = [];
    try {
        [rows] = await db.query(
            `SELECT * FROM evidencia_rotina_config
              WHERE (escopo = 'global')
                 OR (escopo = 'obra'    AND escopo_id = ?)
                 OR (escopo = 'veiculo' AND escopo_id = ?)`,
            [String(obraId || ''), String(veiculoId || '')]
        );
    } catch { /* tabela pode não existir no boot; cai nos defaults */ }

    let regra = { ...ROTINA_PADRAO };
    for (const escopo of ['global', 'obra', 'veiculo']) {
        regra = _mesclar(regra, rows.find(r => r.escopo === escopo));
    }
    _cache.set(chave, { at: Date.now(), regra });
    return regra;
}

async function salvarRegraRotina(db, { escopo, escopo_id, ...campos }) {
    const id = randomUUID();
    const nn = (v) => (v === undefined || v === '' ? null : v);
    await db.query(
        `INSERT INTO evidencia_rotina_config
           (id, escopo, escopo_id, ativa, freq_dias, defasagem_dias, carry_dias, alternar_ordem, tipos)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           ativa=VALUES(ativa), freq_dias=VALUES(freq_dias),
           defasagem_dias=VALUES(defasagem_dias), carry_dias=VALUES(carry_dias),
           alternar_ordem=VALUES(alternar_ordem), tipos=VALUES(tipos)`,
        [id, escopo, String(escopo_id || ''),
         campos.ativa == null ? null : (campos.ativa ? 1 : 0),
         nn(campos.freq_dias), nn(campos.defasagem_dias), nn(campos.carry_dias),
         campos.alternar_ordem == null ? null : (campos.alternar_ordem ? 1 : 0),
         campos.tipos ? JSON.stringify(campos.tipos) : null]
    );
    invalidarCacheRotina();
}

// ---- Memo de materialização -----------------------------------------------------
// O operador faz poll a cada 60s; sem isto seriam ~800 writes/min só para
// reconfirmar o que já está gravado. A leitura das abertas continua sempre fresca.
const MEMO_TTL_MS = 10 * 60 * 1000;
const _memoMat = new Map();

/**
 * Materializa o que vence hoje, expira o que passou da janela de arrasto e
 * devolve as rotinas ABERTAS (inclusive arrastadas de dias anteriores).
 */
async function garantirAgenda(db, { veiculoId, obraId, dataRef, diasSemana, feriadoSet, cfg }) {
    const chaveMemo = `${veiculoId}|${dataRef}`;
    const recente = _memoMat.get(chaveMemo);

    if (!recente || Date.now() - recente > MEMO_TTL_MS) {
        // 1) O que vence hoje. INSERT IGNORE + uq_rotina_agenda é a trava de
        //    idempotência sob concorrência (dois meu-escopo em paralelo). Nunca
        //    dedupar pela PK randomUUID() — ela é diferente a cada chamada.
        for (const { tipo, ciclo } of rotinasDevidas(veiculoId, dataRef, { diasSemana, feriadoSet, cfg })) {
            await db.query(
                `INSERT IGNORE INTO evidencia_rotina_agenda
                   (id, veiculo_id, obra_id, tipo, data_prevista, ciclo) VALUES (?,?,?,?,?,?)`,
                [randomUUID(), veiculoId, obraId || null, tipo, dataRef, ciclo]
            );
        }
        // 2) Expira o que passou da janela de arrasto (em dias SOLICITADOS).
        const limite = _recuarDiasSolicitados(dataRef, cfg.carry_dias, diasSemana, feriadoSet);
        if (limite) {
            await db.query(
                `UPDATE evidencia_rotina_agenda SET status = 'EXPIRADA'
                  WHERE veiculo_id = ? AND status = 'PENDENTE' AND data_prevista < ?`,
                [veiculoId, limite]
            );
        }
        _memoMat.set(chaveMemo, Date.now());
    }

    // 3) O que está aberto hoje — sempre fresco, nunca memoizado.
    const [abertas] = await db.query(
        `SELECT tipo, data_prevista, status, ciclo FROM evidencia_rotina_agenda
          WHERE veiculo_id = ? AND status = 'PENDENTE' AND data_prevista <= ?
          ORDER BY data_prevista`,
        [veiculoId, dataRef]
    );
    return abertas;
}

// Recua N dias solicitados a partir de `ymd`. Usa a contagem para trás em
// passos de 1 dia corrido, com trava — N é sempre pequeno (carry_dias ~3).
function _recuarDiasSolicitados(ymd, n, diasSemana, feriadoSet) {
    if (!n || n < 1) return ymd;
    const { somarDias, diaSolicitado } = require('../utils/evidenciaRegras');
    let atual = ymd;
    let restantes = n;
    for (let i = 0; i < 90 && restantes > 0; i++) {
        atual = somarDias(atual, -1);
        if (diaSolicitado(atual, { dias_semana: diasSemana }, feriadoSet)) restantes--;
    }
    return atual;
}

/** Fecha a ocorrência aberta mais antiga do tipo quando a foto entra. */
async function marcarCumprida(db, { veiculoId, tipo, dataRef, registroId }) {
    // MySQL 8 aceita UPDATE ... ORDER BY ... LIMIT.
    await db.query(
        `UPDATE evidencia_rotina_agenda
            SET status = 'CUMPRIDA', registro_id = ?, cumprida_em = NOW()
          WHERE veiculo_id = ? AND tipo = ? AND status = 'PENDENTE' AND data_prevista <= ?
          ORDER BY data_prevista LIMIT 1`,
        [registroId || null, veiculoId, tipo, dataRef]
    );
}

/** Contagem exigidas/cumpridas do dia, para as colunas informativas da aderência. */
async function contarDoDia(db, veiculoId, dataRef) {
    const [rows] = await db.query(
        `SELECT status FROM evidencia_rotina_agenda
          WHERE veiculo_id = ? AND data_prevista = ?`, [veiculoId, dataRef]);
    return {
        exigidas: rows.length,
        cumpridas: rows.filter(r => r.status === 'CUMPRIDA').length,
    };
}

module.exports = {
    resolveRegraRotina, salvarRegraRotina, invalidarCacheRotina,
    garantirAgenda, marcarCumprida, contarDoDia,
    _recuarDiasSolicitados, nEsimoDiaSolicitado, contarDiasSolicitados,
};
