// utils/planoItem.js
//
// Qual ITEM DO PLANO DE TRABALHO uma máquina vai desempenhar numa obra.
// Ver docs/item-de-contrato-e-substituicao-plano.md.
//
// O problema que isto resolve: até aqui a hora era atribuída ao item do plano por
// igualdade de string entre a chave do plano e o subgrupo do veículo. Contrato com
// item de 23T + uma 11T mandada para o serviço = hora sem item, fora do progresso
// da obra e valorada pelo preço errado.
//
// Regra firmada com o usuário: fora da correspondência exata, o sistema NUNCA
// atribui sozinho. Ele sugere e espera a confirmação de quem está alocando —
// um mesmo contrato pode ter 100 h de 30T e 200 h de 23T, e só quem aloca sabe
// qual serviço aquela máquina vai fazer.

const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

/**
 * Chaves do plano de trabalho da obra, com as horas contratadas de cada uma.
 * Usa o plano por subgrupo quando existe; cai no plano por grupo (obras antigas).
 * @returns {Array<{ key: string, horasContratadas: number, nivel: 'subgrupo'|'grupo' }>}
 */
const itensDoPlano = (obra) => {
    const porSub = parseJson(obra?.horasContratadasPorSubTipo);
    const porTipo = parseJson(obra?.horasContratadasPorTipo);
    const temSub = porSub && Object.keys(porSub).length > 0;
    const plano = temSub ? porSub : (porTipo || {});
    return Object.entries(plano).map(([key, horas]) => ({
        key,
        horasContratadas: parseFloat(horas) || 0,
        nivel: temSub ? 'subgrupo' : 'grupo',
    }));
};

/**
 * Resolve a chave de classificação de uma hora para o NÍVEL do mapa que vai
 * consultá-la.
 *
 * `planoItemKey` é gravado no nível do plano da obra — normalmente SUBGRUPO
 * ("Escavadeira Hidráulica 23T"). Vários consumidores casam essa chave contra
 * mapas de nível GRUPO (`horasContratadasPorTipo`, `valoresPorTipo`). Consultar
 * um mapa de grupo com chave de subgrupo não dá erro: dá `undefined` — a hora
 * some do realizado, ou é valorada a R$ 0.
 *
 * A regra aqui não precisa da taxonomia: se a chave existe no mapa alvo, ela é
 * do nível certo e vale (é o que preserva a substituição — uma 11T declarada no
 * item 23T conta no 23T). Se não existe, a hora cai no grupo do próprio veículo,
 * que é o balde correto naquele nível.
 *
 * @param {string|null} chave        planoItemKey, ou null para o legado
 * @param {string|null} grupoVeiculo `vehicles.tipo` da máquina que apontou
 * @param {object} mapaAlvo          o mapa que será consultado com o resultado
 */
const chaveNoNivelDoMapa = (chave, grupoVeiculo, mapaAlvo) => {
    const k = (chave || '').trim();
    if (!k) return grupoVeiculo || null;
    if (mapaAlvo && Object.prototype.hasOwnProperty.call(mapaAlvo, k)) return k;
    return grupoVeiculo || k;
};

/**
 * Mapa subTipo -> grupos, a partir da taxonomia.
 *
 * É um Set e não uma string porque o mesmo subgrupo vale para vários grupos:
 * "Caçamba Basculante 12m³" é item de Caçamba Truckado E de Caçamba Traçado.
 * Ver a migração "subgrupo N:N" em server.js.
 *
 * @returns {Promise<Map<string, Set<string>>>}
 */
const carregarTaxonomia = async (db) => {
    const [linhas] = await db.query(`
        SELECT s.nome AS sub, t.nome AS grupo
        FROM vehicle_sub_types s
        JOIN vehicle_type_sub_types v ON v.sub_type_id = s.id
        JOIN vehicle_types t ON t.id = v.type_id
    `);
    const mapa = new Map();
    linhas.forEach(r => {
        if (!mapa.has(r.sub)) mapa.set(r.sub, new Set());
        mapa.get(r.sub).add(r.grupo);
    });
    return mapa;
};

/**
 * Decide o item que a máquina desempenha, ou o que perguntar a quem aloca.
 *
 * Casos (na ordem):
 *  1. subgrupo da máquina idêntico a um item, candidato único  -> automatico
 *  2. um único item do GRUPO da máquina                        -> confirmar, pré-selecionado
 *  3. dois ou mais itens do grupo                              -> confirmar, SEM pré-seleção
 *  4. nenhum item do grupo                                     -> confirmar, lista completa
 *  5. obra sem plano cadastrado                                -> sem vínculo (legado)
 *
 * Não pré-selecionar no caso 3 é deliberado: é onde 23T e 30T se separam. Um default
 * ali transformaria o "confirmar" em reflexo justamente onde a escolha é real.
 *
 * @returns {{ decisao: 'automatico'|'confirmar'|'sem_plano', itemKey: string|null,
 *             sugestao: string|null, candidatos: Array, motivo: string }}
 */
const resolverItemDaAlocacao = ({ obra, veiculo, grupoDoSubtipo }) => {
    const itens = itensDoPlano(obra);
    if (itens.length === 0) {
        return {
            decisao: 'sem_plano', itemKey: null, sugestao: null, candidatos: [],
            motivo: 'A obra não tem plano de trabalho cadastrado.',
        };
    }

    const subTipoVeiculo = (veiculo?.sub_tipo || '').trim() || null;
    const grupoVeiculo = (veiculo?.tipo || '').trim() || null;

    // 1. Correspondência exata — único caso que dispensa confirmação.
    if (subTipoVeiculo) {
        const exatos = itens.filter(i => i.key === subTipoVeiculo);
        if (exatos.length === 1) {
            return {
                decisao: 'automatico', itemKey: exatos[0].key, sugestao: exatos[0].key,
                candidatos: exatos,
                motivo: `A máquina é ${subTipoVeiculo} e a obra tem esse item no plano.`,
            };
        }
    }

    // 2 a 4. Candidatos do mesmo grupo da máquina. A chave do plano pode ser um
    // subgrupo (mapeia pela taxonomia, podendo valer para vários grupos) ou o
    // próprio nome do grupo (plano antigo).
    const doGrupo = itens.filter(i => {
        const grupos = grupoDoSubtipo.get(i.key);
        return grupos ? grupos.has(grupoVeiculo) : i.key === grupoVeiculo;
    });

    if (doGrupo.length === 1) {
        return {
            decisao: 'confirmar', itemKey: null, sugestao: doGrupo[0].key, candidatos: itens,
            motivo: subTipoVeiculo
                ? `A obra não tem item de ${subTipoVeiculo}. O único item de ${grupoVeiculo} no plano é "${doGrupo[0].key}".`
                : `A máquina está cadastrada apenas como ${grupoVeiculo}. O único item desse grupo no plano é "${doGrupo[0].key}".`,
        };
    }
    if (doGrupo.length > 1) {
        return {
            decisao: 'confirmar', itemKey: null, sugestao: null, candidatos: itens,
            motivo: `A obra tem ${doGrupo.length} itens de ${grupoVeiculo} (${doGrupo.map(i => i.key).join(', ')}). Escolha qual esta máquina vai desempenhar.`,
        };
    }
    return {
        decisao: 'confirmar', itemKey: null, sugestao: null, candidatos: itens,
        motivo: `O plano da obra não tem nenhum item de ${grupoVeiculo || 'equipamento desse tipo'}.`,
    };
};

/**
 * Valida a chave escolhida contra o plano. Chave inexistente é recusada — deixar
 * passar criaria vínculo órfão, que é exatamente o problema que este módulo resolve.
 */
const validarItemKey = (obra, itemKey) => {
    if (itemKey == null || itemKey === '') return { ok: true, itemKey: null };
    const itens = itensDoPlano(obra);
    const achado = itens.find(i => i.key === itemKey);
    if (!achado) {
        return { ok: false, erro: `O item "${itemKey}" não existe no plano de trabalho desta obra.` };
    }
    return { ok: true, itemKey: achado.key };
};

/**
 * Item vigente da máquina numa obra: o da estadia em aberto. Usado para carimbar
 * o apontamento no momento em que ele é criado.
 */
const itemVigenteDaAlocacao = async (db, obraId, vehicleId) => {
    if (!obraId || !vehicleId) return null;
    const [rows] = await db.query(
        `SELECT planoItemKey FROM obras_historico_veiculos
          WHERE obraId = ? AND veiculoId = ? AND dataSaida IS NULL
          ORDER BY dataEntrada DESC LIMIT 1`,
        [obraId, vehicleId]
    );
    return rows[0]?.planoItemKey || null;
};

/**
 * Chaves de item que já estão em uso na obra — alocações e apontamentos carimbados.
 * @returns {Promise<Map<string, { alocacoes: number, apontamentos: number }>>}
 */
const chavesEmUso = async (db, obraId) => {
    const [aloc] = await db.query(
        `SELECT planoItemKey, COUNT(*) AS q FROM obras_historico_veiculos
          WHERE obraId = ? AND planoItemKey IS NOT NULL AND planoItemKey <> ''
          GROUP BY planoItemKey`, [obraId]);
    const [logs] = await db.query(
        `SELECT planoItemKey, COUNT(*) AS q FROM daily_work_logs
          WHERE obraId = ? AND planoItemKey IS NOT NULL AND planoItemKey <> ''
          GROUP BY planoItemKey`, [obraId]);

    const mapa = new Map();
    const somar = (linhas, campo) => linhas.forEach(r => {
        const cur = mapa.get(r.planoItemKey) || { alocacoes: 0, apontamentos: 0 };
        cur[campo] = Number(r.q) || 0;
        mapa.set(r.planoItemKey, cur);
    });
    somar(aloc, 'alocacoes');
    somar(logs, 'apontamentos');
    return mapa;
};

/**
 * Impede que a edição do plano de trabalho remova ou renomeie um item que já tem
 * alocação ou apontamento apontando para ele.
 *
 * O vínculo é gravado pela CHAVE do item (ver 2.1 do doc): sumir com a chave
 * orfanaria as horas silenciosamente — exatamente o problema que este módulo
 * existe para resolver. Renomear chega aqui como "chave antiga sumiu".
 *
 * @returns {Promise<{ ok: true } | { ok: false, erro: string, itens: string[] }>}
 */
const verificarItensRemovidos = async (db, obraId, obraAtual, planoNovo) => {
    const chavesAntes = new Set(itensDoPlano(obraAtual).map(i => i.key));
    if (chavesAntes.size === 0) return { ok: true };

    const chavesDepois = new Set(Object.keys(planoNovo || {}));
    const emUso = await chavesEmUso(db, obraId);

    const quebradas = [...chavesAntes].filter(k => !chavesDepois.has(k) && emUso.has(k));
    if (quebradas.length === 0) return { ok: true };

    const detalhe = quebradas.map(k => {
        const u = emUso.get(k);
        const partes = [];
        if (u.alocacoes) partes.push(`${u.alocacoes} alocaç${u.alocacoes > 1 ? 'ões' : 'ão'}`);
        if (u.apontamentos) partes.push(`${u.apontamentos} apontamento${u.apontamentos > 1 ? 's' : ''}`);
        return `"${k}" (${partes.join(' e ')})`;
    }).join('; ');

    return {
        ok: false,
        itens: quebradas,
        erro: `Não é possível remover ou renomear ${detalhe}: há máquinas alocadas nesse item. `
            + `Realoque as máquinas para outro item antes de alterar o plano de trabalho.`,
    };
};

module.exports = {
    itensDoPlano,
    chaveNoNivelDoMapa,
    carregarTaxonomia,
    resolverItemDaAlocacao,
    validarItemKey,
    itemVigenteDaAlocacao,
    chavesEmUso,
    verificarItensRemovidos,
};
