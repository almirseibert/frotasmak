// utils/obraFinanceiro.js
//
// Preço da hora e custo de combustível de uma obra. Os dois números que formam
// o "% de combustível sobre a receita" — e que antes cada tela calculava de um
// jeito, com resultados diferentes para a mesma obra.

const { chaveNoNivelDoMapa } = require('./planoItem');

const parseJson = (v) => {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch { return {}; }
};

const temChaves = (m) => m && Object.keys(m).length > 0;

/**
 * Mapas de preço e horas contratadas da obra.
 *
 * O contrato é cadastrado por SUBGRUPO (`valoresPorSubTipo`); `valoresPorTipo`
 * é o legado por grupo. Precificar pelo grupo quebra quando o mesmo subgrupo
 * pertence a mais de um grupo: "Caminhão Caçamba Basculante 12m³" é item de
 * Caçamba Truckado E de Caçamba Traçado, o mapa por grupo só guarda um deles, e
 * as horas da máquina do outro grupo saíam a R$ 0 (Ubiretama, set/2026: 168 h).
 */
const precificacaoDaObra = (obra) => {
    const valoresPorSub = parseJson(obra?.valoresPorSubTipo);
    const valoresPorTipo = parseJson(obra?.valoresPorTipo);
    const horasPorSub = parseJson(obra?.horasContratadasPorSubTipo);
    const horasPorTipo = parseJson(obra?.horasContratadasPorTipo);
    const porSubgrupo = temChaves(valoresPorSub);

    /**
     * Preço da hora apontada. Subgrupo primeiro: o item declarado na alocação
     * (preserva a substituição — uma 11T no item 23T vale o preço do 23T) e, sem
     * ele, o subgrupo da máquina. Não achou no mapa por subgrupo, cai no mapa
     * por grupo como sempre foi: nunca precifica abaixo do cálculo antigo.
     */
    const precoDaHora = ({ itemKey, grupoVeiculo, subgrupoVeiculo }) => {
        if (porSubgrupo) {
            const chave = (itemKey || '').trim() || (subgrupoVeiculo || '').trim();
            const preco = parseFloat(valoresPorSub[chave]) || 0;
            if (preco > 0) return preco;
        }
        const chaveGrupo = chaveNoNivelDoMapa(itemKey, grupoVeiculo, valoresPorTipo) || '';
        return parseFloat(valoresPorTipo[chaveGrupo] || valoresPorTipo[chaveGrupo.trim()]) || 0;
    };

    // Plano e preço sempre do MESMO nível, senão o produto horas × preço não casa.
    const planoHoras = porSubgrupo && temChaves(horasPorSub) ? horasPorSub : horasPorTipo;
    const planoValores = porSubgrupo && temChaves(horasPorSub) ? valoresPorSub : valoresPorTipo;

    const horasContratadas = Object.values(planoHoras)
        .reduce((a, h) => a + (parseFloat(h) || 0), 0);
    // Faturamento a 100%: horas contratadas × valor hora (sem km de prancha).
    const faturamentoContratado = Object.entries(planoHoras)
        .reduce((a, [k, h]) => a + (parseFloat(h) || 0) * (parseFloat(planoValores[k]) || 0), 0);

    const temValores = Object.values(valoresPorSub).some(v => parseFloat(v) > 0)
        || Object.values(valoresPorTipo).some(v => parseFloat(v) > 0);

    return { precoDaHora, horasContratadas, faturamentoContratado, temValores };
};

/**
 * Custo real de combustível por obra.
 *
 * NÃO somar `expenses` de combustível direto: a despesa mensal do posto é
 * derivada dos abastecimentos (refuelingController.updateMonthlyExpense) e é
 * localizada pela descrição, que carrega o nome do posto. Renomeou o posto, a
 * linha antiga fica órfã e o mês conta duas vezes (Ubiretama +R$ 14,5 mil, São
 * Gabriel +R$ 521 mil). E NÃO usar `litrosLiberados`: é o autorizado na ordem,
 * zero quando é "completar tanque".
 *
 * Custo = abastecimentos concluídos (litros abastecidos × preço + Arla + outros,
 *         a mesma fórmula da despesa mensal)
 *       + despesas de combustível que NÃO derivam de abastecimento
 *         (saída de comboio, drenagem/descarte, lançamentos manuais e as
 *         semanais antigas, de antes de o abastecimento ter preço).
 *
 * @returns {Promise<Map<string, { total: number, abastecimentos: number, outros: number }>>}
 */
const custoCombustivelPorObra = async (db, obraIds) => {
    const out = new Map();
    const ids = (obraIds || []).filter(Boolean);
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');

    const [abast] = await db.query(`
        SELECT obraId,
               COALESCE(SUM(
                   COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0) +
                   COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0) +
                   COALESCE(outrosValor, 0)
               ), 0) AS custo
          FROM refuelings
         WHERE obraId IN (${ph})
           AND status IN ('Concluída', 'Concluida')
         GROUP BY obraId
    `, ids);

    // Despesa derivada de abastecimento = a MENSAL gerada por updateMonthlyExpense
    // / updateEstoqueExpense: "Combustível: <tipo> - <posto> (setembro de 2026)",
    // que não é saída de comboio nem descarte de drenagem.
    //
    // As SEMANAIS antigas ("... (28/07/2025 a 03/08/2025)", até jan/2026) ficam
    // no custo: naquele período o abastecimento não guardava preço por litro, e
    // essas despesas são o único registro do valor (R$ 3,4 mi em 102 obras).
    const [outros] = await db.query(`
        SELECT obraId, COALESCE(SUM(amount), 0) AS custo
          FROM expenses
         WHERE obraId IN (${ph})
           AND category = 'Combustível'
           AND NOT (
                 fuelType IS NOT NULL
             AND description LIKE 'Combustível: %'
             AND description REGEXP ' de [0-9]{4}[)]$'
             AND description NOT LIKE '%#Comboio%'
             AND COALESCE(partnerName, '') NOT IN ('Comboio Interno', 'Drenagem/Descarte')
           )
         GROUP BY obraId
    `, ids);

    const get = (k) => {
        if (!out.has(k)) out.set(k, { total: 0, abastecimentos: 0, outros: 0 });
        return out.get(k);
    };
    abast.forEach(r => { get(String(r.obraId)).abastecimentos = parseFloat(r.custo) || 0; });
    outros.forEach(r => { get(String(r.obraId)).outros = parseFloat(r.custo) || 0; });
    out.forEach(v => { v.total = v.abastecimentos + v.outros; });
    return out;
};

module.exports = { precificacaoDaObra, custoCombustivelPorObra };
