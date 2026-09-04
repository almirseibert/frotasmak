// utils/contratoAditivos.js
// Consolidação de contrato + aditivos.
//
// Regra central: a linha de `terceiro_contratos` NUNCA muda por causa de um
// aditivo — ela é o contrato original, que é o que o PDF assinado diz. Os
// valores VIGENTES (o que o terceiro tem a receber hoje) são derivados = base
// + soma dos aditivos ASSINADOS. Aditivo em minuta não conta em lugar nenhum.

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

// Itens ([{ type, hours, price }]) vindos do banco (JSON ou string).
const parseItens = (v) => {
    const arr = parseJson(v, []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((i) => i && i.type)
        .map((i) => ({ type: String(i.type), hours: num(i.hours), price: num(i.price) }));
};

const TIPOS_ADITIVO = ['acrescimo', 'supressao', 'prazo', 'reajuste', 'escopo'];

// Um aditivo só move os números depois que o documento assinado sobe — mesma
// regra do contrato-base (status 'assinado' + assinadoUrl preenchida).
const aditivoVigente = (a) => a && a.status === 'assinado' && !!a.assinadoUrl;

// Soma os deltas de itens sobre a base, preservando a ordem: primeiro os
// subgrupos do contrato original, depois os incluídos por aditivo de escopo.
// `price` do delta sobrescreve o da base (usado pelo aditivo de reajuste).
const consolidarItens = (itensBase, aditivos) => {
    const ordem = [];
    const mapa = new Map();
    const push = (type, hours, price) => {
        if (!mapa.has(type)) { ordem.push(type); mapa.set(type, { type, hours: 0, price: 0 }); }
        const cur = mapa.get(type);
        cur.hours += hours;
        if (price > 0) cur.price = price;
    };
    itensBase.forEach((i) => push(i.type, i.hours, i.price));
    aditivos.forEach((a) => parseItens(a.itensDelta).forEach((i) => push(i.type, i.hours, i.price)));
    // Supressão total de um subgrupo o remove da lista vigente.
    return ordem.map((t) => mapa.get(t)).filter((i) => i.hours > 0 || i.price > 0);
};

// Bloco `vigente` anexado a cada contrato devolvido pela API. Consumido pelos
// cards (CONTRATADO / SALDO A PAGAR), pelo progresso físico e pelo plano por
// subgrupo. Os campos da linha base seguem intactos ao lado, para exibir o
// "original R$ X" e para a geração da minuta do contrato.
const calcularVigente = (contrato, aditivos = []) => {
    const assinados = aditivos.filter(aditivoVigente);
    const itensBase = parseItens(contrato.itensContratados);
    const itens = consolidarItens(itensBase, assinados);

    const horasBase = num(contrato.horasContratadas);
    const valorBase = num(contrato.valorTotal);
    const horasDelta = assinados.reduce((a, x) => a + num(x.horasDelta), 0);
    const valorDelta = assinados.reduce((a, x) => a + num(x.valorDelta), 0);

    const horasContratadas = horasBase + horasDelta;
    const valorTotal = valorBase + valorDelta;

    // Última data de vigência estipulada por aditivo assinado (prazo/escopo),
    // na ordem de sequência; sem aditivo de prazo, mantém a do contrato.
    const vigenciaFim = assinados
        .filter((a) => a.novaVigenciaFim)
        .reduce((acc, a) => a.novaVigenciaFim, contrato.vigenciaFim);

    return {
        horasContratadas,
        valorTotal,
        valorHora: horasContratadas > 0 && contrato.contractType !== 'fechado'
            ? Math.round((valorTotal / horasContratadas) * 100) / 100
            : num(contrato.valorHora),
        itensContratados: itens,
        vigenciaFim,
        horasDelta,
        valorDelta,
        totalAditivos: assinados.length,
        temAditivoPendente: aditivos.some((a) => a.status === 'minuta'),
    };
};

// Anexa `vigente` (e o resumo `aditivos`) a uma lista de contratos, em uma única
// consulta de aditivos para todos eles.
const anexarVigente = async (db, contratos) => {
    const lista = Array.isArray(contratos) ? contratos : [contratos];
    if (lista.length === 0) return Array.isArray(contratos) ? [] : null;

    const ids = lista.map((c) => c.id);
    const [aditivos] = await db.query(
        `SELECT * FROM terceiro_contrato_aditivos
          WHERE contratoId IN (${ids.map(() => '?').join(',')})
          ORDER BY sequencia ASC`,
        ids
    );
    const porContrato = new Map();
    aditivos.forEach((a) => {
        if (!porContrato.has(a.contratoId)) porContrato.set(a.contratoId, []);
        porContrato.get(a.contratoId).push({ ...a, itensDelta: parseItens(a.itensDelta) });
    });

    const out = lista.map((c) => {
        const meus = porContrato.get(c.id) || [];
        return { ...c, aditivos: meus, vigente: calcularVigente(c, meus) };
    });
    return Array.isArray(contratos) ? out : out[0];
};

module.exports = {
    num,
    parseItens,
    TIPOS_ADITIVO,
    aditivoVigente,
    consolidarItens,
    calcularVigente,
    anexarVigente,
};
