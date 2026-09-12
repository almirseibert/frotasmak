// backend/services/evidenciaCarimboConfigService.js
// -----------------------------------------------------------------------------
// Config de CAMPOS do carimbo em 3 níveis (§5.3) — a pendência que o código
// carregava desde a Fase 2: a tabela evidencia_carimbo_config era criada na
// migração e nunca lida (servirVariante passava `r._campos = {}` com um TODO).
//
// `campos` é um objeto { chave: boolean }. Só `false` esconde — chave ausente
// mostra, que é o default de montarLinhas. A coordenada NÃO é configurável.
// -----------------------------------------------------------------------------
const { randomUUID } = require('crypto');

const CHAVES_CAMPO = [
    'data_hora', 'precisao', 'obra', 'equipamento',
    'operador', 'horimetro', 'linha_livre',
];

const TTL_MS = 60 * 1000;
const _cache = new Map(); // `${obraId}|${veiculoId}` -> { at, campos }
const invalidarCacheCampos = () => _cache.clear();

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { const p = JSON.parse(v); return p ?? fallback; } catch { return fallback; }
};

/** global <- obra <- veiculo, campo a campo. Devolve { chave: boolean }. */
async function resolveCampos(db, obraId, veiculoId) {
    const chave = `${obraId || ''}|${veiculoId || ''}`;
    const hit = _cache.get(chave);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.campos;

    let rows = [];
    try {
        [rows] = await db.query(
            `SELECT escopo, campos FROM evidencia_carimbo_config
              WHERE (escopo = 'global')
                 OR (escopo = 'obra'    AND escopo_id = ?)
                 OR (escopo = 'veiculo' AND escopo_id = ?)`,
            [String(obraId || ''), String(veiculoId || '')]
        );
    } catch { /* tabela ausente no boot: mostra tudo */ }

    const campos = {};
    for (const escopo of ['global', 'obra', 'veiculo']) {
        const row = rows.find(r => r.escopo === escopo);
        const c = parseJson(row?.campos, null);
        if (!c) continue;
        for (const k of CHAVES_CAMPO) if (c[k] != null) campos[k] = !!c[k];
    }
    _cache.set(chave, { at: Date.now(), campos });
    return campos;
}

async function lerCampos(db, escopo, escopoId) {
    const [[row]] = await db.query(
        'SELECT campos FROM evidencia_carimbo_config WHERE escopo = ? AND escopo_id = ? LIMIT 1',
        [escopo, String(escopoId || '')]
    );
    return parseJson(row?.campos, {});
}

async function salvarCampos(db, escopo, escopoId, campos) {
    const limpo = {};
    for (const k of CHAVES_CAMPO) if (campos && campos[k] != null) limpo[k] = !!campos[k];
    await db.query(
        `INSERT INTO evidencia_carimbo_config (id, escopo, escopo_id, campos)
         VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE campos = VALUES(campos)`,
        [randomUUID(), escopo, String(escopoId || ''), JSON.stringify(limpo)]
    );
    invalidarCacheCampos();
    return limpo;
}

module.exports = { CHAVES_CAMPO, resolveCampos, lerCampos, salvarCampos, invalidarCacheCampos };
