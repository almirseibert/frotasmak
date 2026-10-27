// utils/contratoAditivos.js
// Consolidação de contrato + aditivos.
//
// Regra central: a linha de `terceiro_contratos` NUNCA muda por causa de um
// aditivo — ela é o contrato original, que é o que o PDF assinado diz. Os
// valores VIGENTES (o que o terceiro tem a receber hoje) são derivados = base
// + soma dos aditivos em minuta ou assinados. A assinatura não é pré-requisito
// para os números: no dia a dia o aditivo vale desde que é lançado. Ela só
// trava edição/exclusão (aditivoVigente).

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

// Itens ([{ type, hours, price, consomeDe? }]) vindos do banco (JSON ou string).
// `consomeDe`: máquina fora do plano da obra que consome horas de outro item.
const parseItens = (v) => {
    const arr = parseJson(v, []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((i) => i && i.type)
        .map((i) => {
            const item = { type: String(i.type), hours: num(i.hours), price: num(i.price) };
            if (i.consomeDe) item.consomeDe = String(i.consomeDe);
            return item;
        });
};

// O driver devolve DATE como objeto Date: String(d).slice(0, 10) daria "Wed Mar 11".
const ymd = (d) => {
    if (!d) return null;
    if (d instanceof Date) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return String(d).slice(0, 10);
};

const MODOS_CONCLUSAO = ['original', 'apurado', 'personalizado'];

// Bloco `conclusao` do contrato concluído (null nos demais). Concluído sem valor
// gravado (anterior ao registro da conclusão) não muda número nenhum.
const conclusaoDoContrato = (contrato) => {
    if (contrato?.status !== 'concluido' || contrato.conclusaoValor == null || !contrato.conclusaoData) return null;
    return {
        data: ymd(contrato.conclusaoData),
        modo: contrato.conclusaoModo,
        valor: num(contrato.conclusaoValor),
        valorContratado: contrato.conclusaoValorContratado == null ? null : num(contrato.conclusaoValorContratado),
        valorApurado: contrato.conclusaoValorApurado == null ? null : num(contrato.conclusaoValorApurado),
        horasExecutadas: contrato.conclusaoHorasExecutadas == null ? null : num(contrato.conclusaoHorasExecutadas),
        observacao: contrato.conclusaoObservacao || null,
        registradaPor: contrato.conclusaoRegistradaPor || null,
        registradaEm: contrato.conclusaoRegistradaEm || null,
    };
};

const TIPOS_ADITIVO =['acrescimo', 'supressao', 'prazo', 'reajuste', 'escopo'];

// Aditivo com documento assinado (status 'assinado' + assinadoUrl) — imutável.
const aditivoVigente = (a) => a && a.status === 'assinado' && !!a.assinadoUrl;

// O que entra nos números do contrato: minuta ou assinado.
const aditivoConta = (a) => a && (a.status === 'minuta' || a.status === 'assinado');

// Soma os deltas de itens sobre a base, preservando a ordem: primeiro os
// subgrupos do contrato original, depois os incluídos por aditivo de escopo.
// `price` do delta sobrescreve o da base (usado pelo aditivo de reajuste).
const consolidarItens = (itensBase, aditivos) => {
    const ordem = [];
    const mapa = new Map();
    const push = (type, hours, price, consomeDe) => {
        if (!mapa.has(type)) { ordem.push(type); mapa.set(type, { type, hours: 0, price: 0 }); }
        const cur = mapa.get(type);
        cur.hours += hours;
        if (price > 0) cur.price = price;
        if (consomeDe) cur.consomeDe = consomeDe;
    };
    // O aditivo herda o `consomeDe` da base: acréscimo numa máquina fora do plano
    // continua saindo do mesmo item de origem.
    itensBase.forEach((i) => push(i.type, i.hours, i.price, i.consomeDe));
    aditivos.forEach((a) => parseItens(a.itensDelta).forEach((i) => push(i.type, i.hours, i.price)));
    // Supressão total de um subgrupo o remove da lista vigente.
    return ordem.map((t) => mapa.get(t)).filter((i) => i.hours > 0 || i.price > 0);
};

// Bloco `vigente` anexado a cada contrato devolvido pela API. Consumido pelos
// cards (CONTRATADO / SALDO A PAGAR), pelo progresso físico e pelo plano por
// subgrupo. Os campos da linha base seguem intactos ao lado, para exibir o
// "original R$ X" e para a geração da minuta do contrato.
const calcularVigente = (contrato, aditivos = []) => {
    const validos = aditivos.filter(aditivoConta);
    const itensBase = parseItens(contrato.itensContratados);
    const itens = consolidarItens(itensBase, validos);

    const horasBase = num(contrato.horasContratadas);
    const valorBase = num(contrato.valorTotal);
    const horasDelta = validos.reduce((a, x) => a + num(x.horasDelta), 0);
    const valorDelta = validos.reduce((a, x) => a + num(x.valorDelta), 0);

    const horasContratadas = horasBase + horasDelta;
    const valorContratado = valorBase + valorDelta;

    // Última data de vigência estipulada por aditivo (prazo/escopo),
    // na ordem de sequência; sem aditivo de prazo, mantém a do contrato.
    const vigenciaContratada = validos
        .filter((a) => a.novaVigenciaFim)
        .reduce((acc, a) => a.novaVigenciaFim, contrato.vigenciaFim);

    // Concluído: o valor do contrato passa a ser o escolhido na conclusão e a
    // janela de apuração (horas e diesel) fecha na data de conclusão.
    const conclusao = conclusaoDoContrato(contrato);
    const valorTotal = conclusao ? conclusao.valor : valorContratado;
    const fimContratado = ymd(vigenciaContratada);
    const vigenciaFim = conclusao && (!fimContratado || conclusao.data < fimContratado)
        ? conclusao.data : vigenciaContratada;

    return {
        horasContratadas,
        valorTotal,
        valorContratado,
        conclusao,
        valorHora: horasContratadas > 0 && contrato.contractType !== 'fechado'
            ? Math.round((valorContratado / horasContratadas) * 100) / 100
            : num(contrato.valorHora),
        itensContratados: itens,
        vigenciaFim,
        horasDelta,
        valorDelta,
        totalAditivos: validos.length,
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
    ymd,
    parseItens,
    MODOS_CONCLUSAO,
    conclusaoDoContrato,
    TIPOS_ADITIVO,
    aditivoVigente,
    aditivoConta,
    consolidarItens,
    calcularVigente,
    anexarVigente,
};
