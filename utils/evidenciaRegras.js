// backend/utils/evidenciaRegras.js
// -----------------------------------------------------------------------------
// Núcleo compartilhado do módulo Evidências de Campo (Fase 2).
// Caminhos em disco (com guarda anti path-traversal copiada de aiVisionService),
// haversine, resolução da regra da obra sobre os defaults, escopo §2 e a
// assinatura HMAC das URLs de imagem.
// -----------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getAllowedReadingTypes } = require('./vehicleRules');

// Raiz configurável (§4). Fica DENTRO do volume mak_uploads (public/uploads) para
// sobreviver a deploy, mas a subárvore /uploads/evidencias é bloqueada no HTTP.
const EVIDENCIAS_ROOT = process.env.EVIDENCIAS_ROOT
    || path.join(__dirname, '..', 'public', 'uploads', 'evidencias');

const SUBDIRS = {
    orig:   path.join(EVIDENCIAS_ROOT, 'orig'),
    cache:  path.join(EVIDENCIAS_ROOT, 'cache'),
    export: path.join(EVIDENCIAS_ROOT, 'export'),
    inbox:  path.join(EVIDENCIAS_ROOT, 'inbox'),
};

const garantirDirs = () => {
    for (const dir of Object.values(SUBDIRS)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
};

// Converte caminho relativo (gravado no banco) em absoluto, barrando traversal.
// Espelha aiVisionService.js:71-79 — o caminho vem do banco, alimentado por upload.
const resolverCaminho = (relativo) => {
    if (!relativo) return null;
    const limpo = String(relativo).replace(/^[/\\]+/, '');
    const absoluto = path.resolve(EVIDENCIAS_ROOT, limpo);
    if (!absoluto.startsWith(path.resolve(EVIDENCIAS_ROOT))) return null;
    return absoluto;
};

// Caminho relativo (para o banco) a partir de um absoluto sob a raiz.
const relativizar = (absoluto) => path.relative(EVIDENCIAS_ROOT, absoluto).split(path.sep).join('/');

// ---- Escopo §2: só Caminhões e Máquinas Pesadas (os que usam horímetro) -------
// Reusa a taxonomia oficial; NUNCA manter uma lista paralela de tipos.
const exigeEvidencia = (tipoVeiculo) => getAllowedReadingTypes(tipoVeiculo).includes('horimetro');

// ---- Defaults globais da regra (sem linha em evidencia_config) -----------------
const RAIO_CERCA_PADRAO_M = parseInt(process.env.EVIDENCIA_RAIO_CERCA_M || '500', 10);
const MOMENTOS_PADRAO = ['horimetro_inicio', 'foto_manha', 'foto_tarde', 'horimetro_fim'];
const HORARIOS_PADRAO = {
    horimetro_inicio: '07:30',
    foto_manha:       '10:30',
    foto_tarde:       '15:30',
    horimetro_fim:    '18:00',
};
// 0 = domingo. Fase 10: sábado saiu do padrão — fim de semana não é exibido como
// solicitação (mas continua podendo ser preenchido se o equipamento trabalhou).
// Obra que trabalha sábado liga o dia 6 na config, na aba Configurações.
const DIAS_SEMANA_PADRAO = [1, 2, 3, 4, 5];
const RETROATIVO_MAX_DIAS_PADRAO = 14;
const HISTORICO_DIAS_PADRAO = 14;

const parseJsonCol = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { const p = JSON.parse(v); return p ?? fallback; } catch { return fallback; }
};

// Resolve a regra efetiva da obra: linha de evidencia_config sobre os defaults.
async function resolveRegraObra(db, obraId) {
    let row = null;
    try {
        const [rows] = await db.query('SELECT * FROM evidencia_config WHERE obra_id = ?', [obraId]);
        row = rows[0] || null;
    } catch { /* tabela pode não existir ainda no boot; cai nos defaults */ }
    return {
        obra_id: obraId,
        momentos_exigidos: parseJsonCol(row?.momentos_exigidos, MOMENTOS_PADRAO),
        horarios_limite:   parseJsonCol(row?.horarios_limite, HORARIOS_PADRAO),
        dias_semana:       parseJsonCol(row?.dias_semana, DIAS_SEMANA_PADRAO),
        raio_cerca_m:      row?.raio_cerca_m != null ? Number(row.raio_cerca_m) : RAIO_CERCA_PADRAO_M,
        exigir_gps:        row ? row.exigir_gps !== 0 : true,
        permitir_galeria:  row ? row.permitir_galeria === 1 : false,
        ativa:             row ? row.ativa !== 0 : true,
        // Fase 10 — anexo retroativo e janela do histórico.
        retroativo_max_dias:  row?.retroativo_max_dias != null ? Number(row.retroativo_max_dias) : RETROATIVO_MAX_DIAS_PADRAO,
        retroativo_horimetro: row?.retroativo_horimetro != null ? row.retroativo_horimetro !== 0 : true,
        historico_dias:       row?.historico_dias != null ? Number(row.historico_dias) : HISTORICO_DIAS_PADRAO,
    };
}

// ---- Dia de solicitação (Fase 10) ----------------------------------------------
// Fim de semana e feriado não são exibidos como solicitação nem cobrados, mas o
// envio continua liberado (o equipamento pode ter trabalhado).
//
// O 'T12:00:00' é OBRIGATÓRIO: new Date('2026-09-11') parseia como UTC meia-noite
// e cai no dia anterior em BRT — errar isso desloca todo o calendário em um dia,
// silenciosamente. Mesmo cuidado documentado em businessDays.js:7-9.
const diaDaSemana = (ymd) => new Date(`${ymd}T12:00:00`).getDay();

const diaSolicitado = (ymd, regra, feriadoSet = null) => {
    const dias = (regra && regra.dias_semana) || DIAS_SEMANA_PADRAO;
    if (!dias.includes(diaDaSemana(ymd))) return false;
    return !(feriadoSet && feriadoSet.has(ymd));
};

const somarDias = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00`);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA');
};

// Quantos dias solicitados existem em [de, ate). Semanas inteiras por aritmética
// + resto de no máximo 6 dias — nunca um laço dia a dia sobre meses inteiros.
// Feriados são descontados só dentro da janela (o Set é pequeno e local).
function contarDiasSolicitados(de, ate, diasSemana, feriadoSet = null) {
    if (de >= ate) return 0;
    const ini = new Date(`${de}T12:00:00`);
    const fim = new Date(`${ate}T12:00:00`);
    const totalDias = Math.round((fim - ini) / 86400000);
    const semanas = Math.floor(totalDias / 7);
    let n = semanas * diasSemana.length;
    for (let i = semanas * 7; i < totalDias; i++) {
        const d = new Date(ini); d.setDate(d.getDate() + i);
        if (diasSemana.includes(d.getDay())) n++;
    }
    if (feriadoSet && feriadoSet.size) {
        for (const f of feriadoSet) {
            if (f >= de && f < ate && diasSemana.includes(diaDaSemana(f))) n--;
        }
    }
    return n;
}

// Devolve o k-ésimo (0-based) dia solicitado a partir de `de`, inclusive.
function nEsimoDiaSolicitado(de, k, diasSemana, feriadoSet = null) {
    let ymd = de;
    let vistos = 0;
    for (let i = 0; i < 400; i++) { // trava de segurança
        if (diasSemana.includes(diaDaSemana(ymd)) && !(feriadoSet && feriadoSet.has(ymd))) {
            if (vistos === k) return ymd;
            vistos++;
        }
        ymd = somarDias(ymd, 1);
    }
    return null;
}

// ---- Haversine (metros) --------------------------------------------------------
const haversineM = (lat1, lng1, lat2, lng2) => {
    if ([lat1, lng1, lat2, lng2].some(v => v == null || isNaN(v))) return null;
    const R = 6371000;
    const toRad = (d) => (Number(d) * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

// ---- Assinatura HMAC das URLs de imagem (§4) -----------------------------------
// s = HMAC-SHA256(JWT_SECRET, "id|variante|versao|exp"). Como a versão entra na
// assinatura, editar o carimbo (stamp_version++) invalida sozinho as URLs antigas.
const TTL_URL_MS = 8 * 60 * 60 * 1000; // 8 h
const VARIANTES = ['thumb', 'stamped', 'clean'];

const _segredo = () => process.env.JWT_SECRET || 'dev-secret-evidencias';

const _hmac = (id, variante, versao, exp) =>
    crypto.createHmac('sha256', _segredo())
        .update(`${id}|${variante}|${versao}|${exp}`)
        .digest('hex');

// Devolve o caminho relativo (a partir de /api) para embutir em <img src>.
function assinarVariante(id, variante, versao, base = '/api/public/evidencias') {
    const exp = Date.now() + TTL_URL_MS;
    const s = _hmac(id, variante, versao, exp);
    return `${base}/${id}/${variante}?v=${versao}&exp=${exp}&s=${s}`;
}

// Monta as três URLs assinadas de um registro.
function assinarTodas(id, versao) {
    const out = {};
    for (const v of VARIANTES) out[v] = assinarVariante(id, v, versao);
    return out;
}

function verificarAssinatura(id, variante, versao, exp, s) {
    if (!id || !VARIANTES.includes(variante) || !versao || !exp || !s) return false;
    if (Number(exp) < Date.now()) return false;
    const esperado = _hmac(id, variante, versao, exp);
    // Comparação em tempo constante.
    try {
        return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperado));
    } catch { return false; }
}

module.exports = {
    EVIDENCIAS_ROOT, SUBDIRS, garantirDirs, resolverCaminho, relativizar,
    exigeEvidencia,
    RAIO_CERCA_PADRAO_M, MOMENTOS_PADRAO, HORARIOS_PADRAO, DIAS_SEMANA_PADRAO,
    RETROATIVO_MAX_DIAS_PADRAO, HISTORICO_DIAS_PADRAO,
    resolveRegraObra, haversineM,
    diaDaSemana, diaSolicitado, somarDias, contarDiasSolicitados, nEsimoDiaSolicitado,
    VARIANTES, assinarVariante, assinarTodas, verificarAssinatura,
};
