// utils/partCatalog.js
// ─────────────────────────────────────────────────────────────────────────────
// Helpers de normalização e resolução para o Guia de Peças e Reposição.
// Usados pelo controller para casar um veículo (marca/modelo/ano) com os
// modelos do catálogo de referência.
// ─────────────────────────────────────────────────────────────────────────────

// lowercase, sem acento, trim, colapsa espaços múltiplos.
function normalizeText(s) {
    if (s == null) return '';
    return String(s)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove diacríticos
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Mapa de typos/variações → forma canônica da marca.
const MARCA_ALIASES = {
    'volkswagem': 'volkswagen',
    'vw': 'volkswagen',
    'xcg': 'xcmg',
    'liu gong': 'liugong',
    'mitsubichi': 'mitsubishi',
    'mercedes-benz': 'mercedes',
    'mercedes benz': 'mercedes',
    'mb': 'mercedes',
    'fiat-allis': 'fiatallis',
    'fiat allis': 'fiatallis',
    'cat': 'caterpillar',
    'chevrolet': 'chevrolet',
    'gm': 'chevrolet',
    'new holland': 'newholland',
};

// Normaliza a marca aplicando o mapa de aliases sobre o texto normalizado.
function normalizeMarca(s) {
    const base = normalizeText(s);
    if (!base) return '';
    return MARCA_ALIASES[base] || base;
}

// Extrai o ano do veículo tolerando os vários nomes de coluna existentes.
function resolveVehicleAno(vehicle) {
    if (!vehicle) return null;
    const raw = vehicle.anoFabricacao
        ?? vehicle.ano_fabricacao
        ?? vehicle.ano_modelo
        ?? null;
    if (raw == null || raw === '') return null;
    const n = parseInt(String(raw).slice(0, 4), 10);
    return Number.isFinite(n) ? n : null;
}

// Faixa de anos com extremidades abertas quando null.
// anoMatch(null, ...) => true (sem ano do veículo, não filtra por ano).
function anoMatch(ano, ini, fim) {
    if (ano == null) return true;
    if (ini != null && ano < Number(ini)) return false;
    if (fim != null && ano > Number(fim)) return false;
    return true;
}

module.exports = {
    normalizeText,
    normalizeMarca,
    resolveVehicleAno,
    anoMatch,
    MARCA_ALIASES,
};
