// backend/utils/consumo.js
//
// =============================================================================
// FONTE ÚNICA DE CONSUMO NO BACKEND
// =============================================================================
//
// Gêmeo CommonJS de `frontend/src/utils/vehicleRules.js` (computeConsumption,
// getGroupUnit, getReadingSourceForUnit, isHigherBetter), com duas diferenças
// importantes em relação a `backend/utils/vehicleRules.js`:
//
//   1. HIDRATA a taxonomia do banco (vehicle_groups + vehicle_types), em vez de
//      usar o mapa hard-coded. O frontend já faz isso via hydrateVehicleTaxonomy;
//      o backend não fazia, e por isso divergia quando a taxonomia era editada.
//   2. Resolve a MÉDIA ESPERADA e a TOLERÂNCIA em cascata, normalizando unidades.
//
// Unidades possíveis: 'Km/L', 'L/Km', 'L/h', 'h/L'.
//   - Km/L e L/Km leem ODÔMETRO; L/h e h/L leem HORÍMETRO.
//   - Conversão só existe dentro do mesmo par (recíproco). Km/L não vira L/h:
//     são grandezas de leitura diferentes.
// =============================================================================

const dbPadrao = require('../database');
const { vehicleGroups: gruposEstaticos } = require('./vehicleRules');

const UNIDADES = ['Km/L', 'L/Km', 'L/h', 'h/L'];
const UNIDADE_PADRAO = 'L/h';

// ─── Cache da taxonomia ──────────────────────────────────────────────────────
// Muda raramente (tela de admin), mas é consultada a cada análise.
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, tipoParaGrupo, unidadePorGrupo, origem }

const montarFallbackEstatico = () => {
    const tipoParaGrupo = new Map();
    const unidadePorGrupo = new Map();
    Object.keys(gruposEstaticos).forEach((grupo) => {
        // Regra histórica: Leves e Caminhões de Trecho em Km/L, o resto em L/h.
        const unidade = (grupo === 'Veículos Leves' || grupo === 'Caminhões de Trecho') ? 'Km/L' : 'L/h';
        unidadePorGrupo.set(grupo, unidade);
        (gruposEstaticos[grupo] || []).forEach((tipo) => tipoParaGrupo.set(tipo, grupo));
    });
    return { tipoParaGrupo, unidadePorGrupo, origem: 'estatico' };
};

/**
 * Carrega grupos/tipos/unidades do banco, com cache e fallback estático.
 * @param {object} [conn] conexão MySQL (pool ou transação)
 */
const carregarTaxonomia = async (conn = dbPadrao) => {
    if (cache && (Date.now() - cache.at) < TTL_MS) return cache;

    try {
        const [rows] = await conn.query(
            `SELECT g.nome AS grupo, g.unidade AS unidade, t.nome AS tipo
               FROM vehicle_groups g
               LEFT JOIN vehicle_types t ON t.group_id = g.id`
        );

        if (rows && rows.length > 0) {
            const tipoParaGrupo = new Map();
            const unidadePorGrupo = new Map();
            rows.forEach((r) => {
                if (!r.grupo) return;
                unidadePorGrupo.set(r.grupo, UNIDADES.includes(r.unidade) ? r.unidade : UNIDADE_PADRAO);
                if (r.tipo) tipoParaGrupo.set(r.tipo, r.grupo);
            });
            cache = { at: Date.now(), tipoParaGrupo, unidadePorGrupo, origem: 'banco' };
            return cache;
        }
    } catch (e) {
        console.warn('[consumo] falha ao carregar taxonomia do banco, usando fallback estático:', e.message);
    }

    cache = { at: Date.now(), ...montarFallbackEstatico() };
    return cache;
};

/** Invalida o cache — chamar quando a taxonomia for editada no admin. */
const invalidarCache = () => { cache = null; };

/** Grupo ao qual um tipo pertence (ou null). */
const getGrupoDoTipo = async (tipo, conn) => {
    const t = await carregarTaxonomia(conn);
    return t.tipoParaGrupo.get(tipo) || null;
};

/** Unidade de consumo configurada para o grupo de um tipo. */
const getUnidadeDoTipo = async (tipo, conn) => {
    const t = await carregarTaxonomia(conn);
    const grupo = t.tipoParaGrupo.get(tipo);
    return (grupo && t.unidadePorGrupo.get(grupo)) || UNIDADE_PADRAO;
};

/** Qual leitura a unidade exige: 'odometro' (Km) ou 'horimetro' (Hr). */
const getReadingSourceForUnit = (unidade) =>
    (unidade === 'Km/L' || unidade === 'L/Km') ? 'odometro' : 'horimetro';

/** Campo de leitura do veículo para o tipo informado. */
const getCampoLeitura = async (tipo, conn) =>
    getReadingSourceForUnit(await getUnidadeDoTipo(tipo, conn));

/**
 * Calcula a média de consumo conforme a unidade.
 * Idêntico ao computeConsumption do frontend.
 * @param {string} unidade 'Km/L' | 'L/Km' | 'L/h' | 'h/L'
 * @param {number} leitura distância percorrida (Km) ou horas trabalhadas
 * @param {number} litros  litros abastecidos
 * @returns {number|null}
 */
const computeConsumption = (unidade, leitura, litros) => {
    const l = parseFloat(leitura);
    const f = parseFloat(litros);
    if (!(l > 0) || !(f > 0)) return null;
    switch (unidade) {
        case 'Km/L': return l / f;
        case 'L/Km': return f / l;
        case 'h/L':  return l / f;
        case 'L/h':
        default:     return f / l;
    }
};

/** Para a unidade, valor MAIOR é melhor? (Km/L e h/L). */
const isHigherBetter = (unidade) => unidade === 'Km/L' || unidade === 'h/L';

const RECIPROCAS = { 'Km/L': 'L/Km', 'L/Km': 'Km/L', 'L/h': 'h/L', 'h/L': 'L/h' };

/**
 * Converte um valor entre unidades. Só é possível dentro do mesmo par de leitura
 * (Km/L <-> L/Km, L/h <-> h/L). Km/L para L/h devolve null: grandezas diferentes.
 * @returns {number|null}
 */
const converter = (valor, de, para) => {
    const v = parseFloat(valor);
    if (!isFinite(v) || v === 0) return null;
    if (de === para) return v;
    if (RECIPROCAS[de] === para) return 1 / v;
    return null;
};

/**
 * Média esperada + tolerância, em cascata de precedência:
 *   1. vehicles.media_consumo                 (na unidade do GRUPO)
 *   2. vehicle_type_configs (tipo, sub_tipo)  (na unidade da própria linha)
 *   3. vehicle_type_configs (tipo, NULL)      (idem)
 *   4. vehicle_fuel_averages.avg_last_3       (na unidade gravada na linha)
 *   5. vehicle_fuel_averages.avg_by_subtipo
 *   6. vehicle_fuel_averages.avg_by_tipo
 *   7. null -> o portão de média deve ficar 'indeterminado'
 *
 * A tolerância segue a mesma ordem (veículo -> tipo -> padrão do config).
 *
 * @param {object} vehicle linha de `vehicles` (precisa de id, tipo, sub_tipo,
 *                         media_consumo, percentual_tolerancia)
 * @param {object} opts    { conn, toleranciaPadrao }
 */
const resolveMediaEsperada = async (vehicle, opts = {}) => {
    const conn = opts.conn || dbPadrao;
    const toleranciaPadrao = opts.toleranciaPadrao != null ? parseFloat(opts.toleranciaPadrao) : 20;

    const unidade = await getUnidadeDoTipo(vehicle && vehicle.tipo, conn);
    const vazio = {
        media: null, unidade, tolerancia: toleranciaPadrao,
        fonte: 'indisponivel', intervalos: null, confiavel: false,
    };
    if (!vehicle || !vehicle.id) return vazio;

    // Tolerância: a do veículo vence; senão a do tipo; senão o padrão do config.
    let tolerancia = null;
    if (vehicle.percentual_tolerancia != null && vehicle.percentual_tolerancia !== '') {
        const t = parseFloat(vehicle.percentual_tolerancia);
        if (isFinite(t) && t > 0) tolerancia = t;
    }

    // ── 1. Média cadastrada no próprio veículo (já na unidade do grupo) ──
    const mediaVeiculo = parseFloat(vehicle.media_consumo);
    if (isFinite(mediaVeiculo) && mediaVeiculo > 0) {
        return {
            media: mediaVeiculo, unidade,
            tolerancia: tolerancia != null ? tolerancia : toleranciaPadrao,
            fonte: 'veiculo', intervalos: null, confiavel: true,
        };
    }

    // ── 2/3. Configuração por tipo/sub-tipo ──
    let typeConfig = null;
    try {
        const [linhas] = await conn.query(
            `SELECT media_consumo_padrao, percentual_tolerancia_padrao, unidade, sub_tipo
               FROM vehicle_type_configs
              WHERE tipo = ? AND (sub_tipo = ? OR sub_tipo IS NULL)
              ORDER BY sub_tipo IS NULL ASC
              LIMIT 1`,
            [vehicle.tipo || null, vehicle.sub_tipo || null]
        );
        typeConfig = linhas && linhas[0] ? linhas[0] : null;
    } catch (e) {
        console.warn('[consumo] falha ao ler vehicle_type_configs:', e.message);
    }

    if (typeConfig) {
        if (tolerancia == null && typeConfig.percentual_tolerancia_padrao != null) {
            const t = parseFloat(typeConfig.percentual_tolerancia_padrao);
            if (isFinite(t) && t > 0) tolerancia = t;
        }
        const m = parseFloat(typeConfig.media_consumo_padrao);
        if (isFinite(m) && m > 0) {
            const convertida = (typeConfig.unidade === unidade)
                ? m
                : converter(m, typeConfig.unidade, unidade);
            if (convertida != null) {
                return {
                    media: convertida, unidade,
                    tolerancia: tolerancia != null ? tolerancia : toleranciaPadrao,
                    fonte: typeConfig.sub_tipo ? 'tipo_subtipo' : 'tipo',
                    intervalos: null, confiavel: true,
                };
            }
            // Unidade incompatível (ex.: config em Km/L para grupo em L/h).
            // Ignorar em silêncio esconderia um cadastro errado.
            console.warn(
                '[consumo] vehicle_type_configs(' + vehicle.tipo + ') está em '
                + typeConfig.unidade + ' mas o grupo usa ' + unidade
                + '; média do tipo ignorada.'
            );
        }
    }

    const toleranciaFinal = tolerancia != null ? tolerancia : toleranciaPadrao;

    // ── 4/5/6. Histórico calculado ──
    let hist = null;
    try {
        const [linhas] = await conn.query(
            `SELECT avg_last_1, avg_last_2, avg_last_3, avg_by_subtipo, avg_by_tipo,
                    unidade, intervalos_validos, intervalos_tanque_cheio
               FROM vehicle_fuel_averages
              WHERE vehicle_id = ?
              LIMIT 1`,
            [vehicle.id]
        );
        hist = linhas && linhas[0] ? linhas[0] : null;
    } catch (e) {
        console.warn('[consumo] falha ao ler vehicle_fuel_averages:', e.message);
    }

    if (!hist) return { ...vazio, tolerancia: toleranciaFinal };

    // Linhas gravadas antes da correção de unidade não têm `unidade` preenchida
    // e podem estar invertidas (h/L gravado onde a UI mostra L/h). Não dá para
    // confiar nelas — melhor devolver indeterminado do que um número errado.
    if (!hist.unidade) {
        return {
            ...vazio, tolerancia: toleranciaFinal,
            fonte: 'historico_sem_unidade',
            intervalos: hist.intervalos_validos != null ? Number(hist.intervalos_validos) : null,
        };
    }

    const intervalos = hist.intervalos_validos != null ? Number(hist.intervalos_validos) : null;
    const candidatos = [
        ['historico_3', hist.avg_last_3],
        ['historico_subtipo', hist.avg_by_subtipo],
        ['historico_tipo', hist.avg_by_tipo],
    ];

    for (const [fonte, bruto] of candidatos) {
        const v = parseFloat(bruto);
        if (!isFinite(v) || v <= 0) continue;
        const convertida = (hist.unidade === unidade) ? v : converter(v, hist.unidade, unidade);
        if (convertida == null) continue;
        return {
            media: convertida, unidade, tolerancia: toleranciaFinal, fonte,
            intervalos,
            // Só o histórico do próprio veículo conta como base confiável;
            // média de tipo/sub-tipo serve de referência, não de parâmetro.
            confiavel: fonte === 'historico_3',
        };
    }

    return { ...vazio, tolerancia: toleranciaFinal, intervalos };
};

/**
 * A média observada está dentro da faixa aceitável?
 * A faixa é simétrica em torno da média esperada (± tolerância %).
 */
const dentroDaTolerancia = (observada, esperada, toleranciaPercentual) => {
    const o = parseFloat(observada);
    const e = parseFloat(esperada);
    const t = parseFloat(toleranciaPercentual);
    if (!isFinite(o) || !isFinite(e) || e <= 0 || !isFinite(t)) {
        return { dentro: false, desvioPercentual: null, minimo: null, maximo: null };
    }
    const minimo = e * (1 - t / 100);
    const maximo = e * (1 + t / 100);
    return {
        dentro: o >= minimo && o <= maximo,
        desvioPercentual: ((o - e) / e) * 100,
        minimo,
        maximo,
    };
};

/**
 * Litros esperados para percorrer/trabalhar um delta de leitura.
 *   Km/L e h/L: litros = delta / media
 *   L/h e L/Km: litros = delta * media
 */
const litrosEsperados = (unidade, delta, media) => {
    const d = parseFloat(delta);
    const m = parseFloat(media);
    if (!(d > 0) || !(m > 0)) return null;
    return isHigherBetter(unidade) ? (d / m) : (d * m);
};

module.exports = {
    UNIDADES,
    UNIDADE_PADRAO,
    carregarTaxonomia,
    invalidarCache,
    getGrupoDoTipo,
    getUnidadeDoTipo,
    getReadingSourceForUnit,
    getCampoLeitura,
    computeConsumption,
    isHigherBetter,
    converter,
    resolveMediaEsperada,
    dentroDaTolerancia,
    litrosEsperados,
};
