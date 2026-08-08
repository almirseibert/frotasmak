// Dias úteis e feriados.
//
// Fonte dos feriados: tabela `admin_holidays` (criada em routes/adminRoutes.js).
// `regiao` NULL = feriado nacional; preenchida = feriado municipal/estadual que
// só vale para aquela região (mesmos valores de obras.regiao: 'Lajeado' | 'Santa Maria').
//
// Todas as datas circulam como string 'YYYY-MM-DD' e são parseadas com
// 'T12:00:00' — meio-dia evita que UTC/horário de verão empurrem o dia para
// trás. Mesmo truque usado em obraSupervisorController.
//
// O espelho puro deste arquivo vive em frontend/src/utils/businessDays.js.
// Se mudar a semântica aqui, mude lá também.

const { ymdBRT } = require('./dateBRT');

const MAX_ITER = 3650; // ~10 anos — trava de segurança contra loop infinito

// --- Normalização ------------------------------------------------------------

// Aceita Date | 'YYYY-MM-DD' | ISO string | timestamp. Retorna 'YYYY-MM-DD' ou null.
const toYmd = (input) => {
    if (!input) return null;
    if (typeof input === 'string') {
        const m = input.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
    }
    return ymdBRT(input);
};

const parseYmd = (ymd) => new Date(`${ymd}T12:00:00`);

const fmtYmd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// --- Cache de feriados -------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;
let _cache = { rows: null, at: 0 };

// Invalidar sempre que a tabela mudar (POST/DELETE de feriado).
const invalidateHolidayCache = () => { _cache = { rows: null, at: 0 }; };

const loadHolidayRows = async (dbClient, { force = false } = {}) => {
    const now = Date.now();
    if (!force && _cache.rows && (now - _cache.at) < TTL_MS) return _cache.rows;

    // No banco a região é NOT NULL DEFAULT '' (para o UNIQUE funcionar — ver a
    // migração em routes/adminRoutes.js). Aqui e para fora ela volta a ser null.
    const [rows] = await dbClient.query('SELECT id, name, date, regiao FROM admin_holidays');
    const normalized = rows
        .map(r => ({ id: r.id, name: r.name, date: toYmd(r.date), regiao: r.regiao || null }))
        .filter(r => r.date);

    _cache = { rows: normalized, at: now };
    return normalized;
};

// Regiões aceitas em admin_holidays.regiao — mesmos valores do ENUM obras.regiao.
// Qualquer outro valor vira '' no banco = feriado nacional (null na API).
const HOLIDAY_REGIOES = ['Lajeado', 'Santa Maria'];

/** Normaliza a região vinda do cliente para o valor gravável (nunca null). */
const sanitizeRegiao = (regiao) => (HOLIDAY_REGIOES.includes(regiao) ? regiao : '');

/** Lista completa e ordenada, com datas normalizadas. Não usa cache. */
const listHolidays = async (dbClient) => {
    const [rows] = await dbClient.query(
        'SELECT id, name, date, regiao FROM admin_holidays ORDER BY date ASC, name ASC'
    );
    return rows.map(r => ({ id: r.id, name: r.name, date: toYmd(r.date), regiao: r.regiao || null }));
};

/**
 * Conjunto de feriados aplicáveis, como Set<'YYYY-MM-DD'>.
 * Sempre inclui os nacionais (regiao NULL); os regionais entram só quando
 * `regiao` é informada e bate.
 */
const loadHolidaySet = async (dbClient, { force = false, regiao = null } = {}) => {
    const rows = await loadHolidayRows(dbClient, { force });
    return new Set(
        rows.filter(r => r.regiao === null || (regiao && r.regiao === regiao)).map(r => r.date)
    );
};

// --- Núcleo puro (espelhado no frontend) -------------------------------------

const isWeekend = (ymd) => {
    const wd = parseYmd(ymd).getDay();
    return wd === 0 || wd === 6;
};

const isHoliday = (ymd, holidaySet) => !!(holidaySet && holidaySet.has(ymd));

const isBusinessDay = (ymd, holidaySet) => !isWeekend(ymd) && !isHoliday(ymd, holidaySet);

const shiftDays = (ymd, n) => {
    const d = parseYmd(ymd);
    d.setDate(d.getDate() + n);
    return fmtYmd(d);
};

/** Primeiro dia útil ESTRITAMENTE depois de `ymd`. */
const nextBusinessDay = (ymd, holidaySet) => {
    let cur = shiftDays(ymd, 1);
    for (let i = 0; i < MAX_ITER; i++) {
        if (isBusinessDay(cur, holidaySet)) return cur;
        cur = shiftDays(cur, 1);
    }
    return cur;
};

/** Último dia útil ESTRITAMENTE antes de `ymd`. */
const previousBusinessDay = (ymd, holidaySet) => {
    let cur = shiftDays(ymd, -1);
    for (let i = 0; i < MAX_ITER; i++) {
        if (isBusinessDay(cur, holidaySet)) return cur;
        cur = shiftDays(cur, -1);
    }
    return cur;
};

/** Se `ymd` já for dia útil devolve ele mesmo; senão o próximo dia útil. */
const ensureBusinessDay = (ymd, holidaySet) =>
    isBusinessDay(ymd, holidaySet) ? ymd : nextBusinessDay(ymd, holidaySet);

/**
 * Soma `n` dias úteis a `ymd`. n = 0 devolve `ymd` inalterado; n negativo anda
 * para trás. Um prazo de N dias úteis a partir de um início D é
 * `addBusinessDays(D, N - 1)`.
 */
const addBusinessDays = (ymd, n, holidaySet) => {
    const step = n < 0 ? -1 : 1;
    let restantes = Math.abs(n);
    let cur = ymd;
    let guard = 0;
    while (restantes > 0 && guard++ < MAX_ITER) {
        cur = shiftDays(cur, step);
        if (isBusinessDay(cur, holidaySet)) restantes--;
    }
    return cur;
};

/** Lista dia a dia de [start, end] inclusive, marcando quais são úteis. */
const businessDayList = (startYmd, endYmd, holidaySet) => {
    const out = [];
    let cur = startYmd;
    const end = endYmd;
    let guard = 0;
    while (cur <= end && guard++ < MAX_ITER) {
        out.push({ date: cur, isBusinessDay: isBusinessDay(cur, holidaySet) });
        cur = shiftDays(cur, 1);
    }
    return out;
};

/** Quantidade de dias úteis em [start, end] inclusive. */
const businessDaysBetween = (startYmd, endYmd, holidaySet) =>
    businessDayList(startYmd, endYmd, holidaySet).filter(d => d.isBusinessDay).length;

/** Total de dias corridos em [start, end] inclusive. */
const diffDays = (startYmd, endYmd) =>
    Math.round((parseYmd(endYmd) - parseYmd(startYmd)) / 86400000) + 1;

module.exports = {
    toYmd,
    fmtYmd,
    parseYmd,
    HOLIDAY_REGIOES,
    sanitizeRegiao,
    listHolidays,
    loadHolidaySet,
    loadHolidayRows,
    invalidateHolidayCache,
    isWeekend,
    isHoliday,
    isBusinessDay,
    ensureBusinessDay,
    nextBusinessDay,
    previousBusinessDay,
    addBusinessDays,
    businessDayList,
    businessDaysBetween,
    diffDays,
};
