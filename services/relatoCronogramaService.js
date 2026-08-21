// services/relatoCronogramaService.js
//
// Monta a "sequência de manutenção" de um relato de ocorrência: para cada item
// triado, quando o serviço começa e quando deve estar concluído, contando
// apenas DIAS ÚTEIS — sábado, domingo e os feriados de admin_holidays ficam de
// fora (utils/businessDays).
//
// Regra de sequenciamento: SEQUENCIAL dentro de cada executor, PARALELO entre
// executores. Duas oficinas diferentes trabalham ao mesmo tempo; a mesma
// oficina faz um serviço depois do outro. Dentro do executor a ordem é a
// prioridade da gravidade (A antes de B antes de C antes de D) e, no empate, a
// ordem em que o item aparece na ficha de papel.
//
// Contagem do prazo: N dias úteis contados A PARTIR da data base, incluindo-a
// quando ela própria é dia útil — fechar um relato numa sexta com prazo de 2
// dias úteis conclui na segunda (sexta = 1º, segunda = 2º). Se a data base cair
// em fim de semana ou feriado, o início escorrega para o próximo dia útil.
// Adiar o começo é decisão do gestor, que escolhe a data base no wizard, e não
// algo que o sistema deva impor.
//
// O cronograma é PERSISTIDO no fechamento, não recalculado a cada leitura:
// cadastrar um feriado novo depois não pode reescrever em silêncio um prazo já
// combinado com o fornecedor. Para recalcular existe endpoint explícito.

const {
    loadHolidaySet, nextBusinessDay, addBusinessDays, ensureBusinessDay, toYmd,
} = require('../utils/businessDays');
const { OFICINA_INTERNA_PARTNER_ID } = require('../utils/ensureOficinaInternaPartner');

/** Prazos e prioridade por gravidade, indexados pela letra. */
const carregarSlaConfig = async (dbClient) => {
    const [rows] = await dbClient.query('SELECT * FROM relato_sla_config');
    return Object.fromEntries(rows.map(r => [r.gravidade, r]));
};

/**
 * Executor efetivo do item. 'interno' sempre resolve para o partner-espelho da
 * oficina da MAK; assim todo item tem um executor não-nulo e o agrupamento das
 * ordens não precisa de caso especial.
 */
const resolverExecutor = (item) => {
    if (item.executorTipo === 'interno') return OFICINA_INTERNA_PARTNER_ID;
    return item.executorPartnerId || null;
};

/**
 * Calcula o cronograma.
 *
 * @param {Array}  itens       itens do relato já triados
 * @param {string} dataBase    'YYYY-MM-DD' — a partir de quando pode começar
 * @param {Set}    holidaySet  feriados aplicáveis
 * @param {object} slaConfig   mapa gravidade → linha de relato_sla_config
 * @returns {{ cronograma: Array, dataConclusaoPrevistaGeral: string|null, avisos: string[] }}
 */
const computeCronograma = (itens, dataBase, holidaySet, slaConfig) => {
    const avisos = [];
    const ativos = (itens || []).filter(i => i.status !== 'Cancelado');

    const inicioPossivel = ensureBusinessDay(dataBase, holidaySet);
    if (inicioPossivel !== dataBase) {
        avisos.push(`${dataBase} não é dia útil — a contagem dos prazos começa em ${inicioPossivel}.`);
    }

    // Agrupa por executor. Item sem executor entra num grupo próprio ('__sem__')
    // para ainda receber previsão: o gestor precisa ver o impacto no prazo mesmo
    // antes de decidir quem executa.
    const grupos = new Map();
    for (const item of ativos) {
        const chave = resolverExecutor(item) || '__sem_executor__';
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(item);
    }
    if (grupos.has('__sem_executor__')) {
        avisos.push(`${grupos.get('__sem_executor__').length} item(ns) ainda sem executor definido.`);
    }

    const cronograma = [];

    for (const [, itensDoGrupo] of grupos) {
        itensDoGrupo.sort((a, b) => {
            const pa = slaConfig[a.gravidade]?.ordemPrioridade ?? 99;
            const pb = slaConfig[b.gravidade]?.ordemPrioridade ?? 99;
            if (pa !== pb) return pa - pb;
            return (a.sequencia || 0) - (b.sequencia || 0);
        });

        let cursor = inicioPossivel;
        for (const item of itensDoGrupo) {
            const slaPadrao = slaConfig[item.gravidade]?.slaDiasUteis;
            const sla = Number(item.slaDiasUteis) > 0 ? Number(item.slaDiasUteis) : (slaPadrao || 1);
            if (!slaPadrao && !item.slaDiasUteis) {
                avisos.push(`Item ${item.sequencia}: gravidade "${item.gravidade}" sem prazo configurado — usando 1 dia útil.`);
            }

            const dataInicioPrevista = cursor;
            // Um prazo de N dias úteis contados A PARTIR do início consome o
            // próprio dia de início, daí o `sla - 1`.
            const dataConclusaoPrevista = addBusinessDays(dataInicioPrevista, sla - 1, holidaySet);

            cronograma.push({
                itemId: item.id,
                sequencia: item.sequencia,
                gravidade: item.gravidade,
                itemComponente: item.itemComponente,
                executorPartnerId: resolverExecutor(item),
                executorNome: item.executorNome || null,
                slaDiasUteis: sla,
                dataInicioPrevista,
                dataConclusaoPrevista,
            });

            cursor = nextBusinessDay(dataConclusaoPrevista, holidaySet);
        }
    }

    // ordemSequencia é a posição global na fila de conclusão — é o número que
    // aparece como "sequência de manutenção" para o gestor.
    cronograma.sort((a, b) =>
        a.dataConclusaoPrevista.localeCompare(b.dataConclusaoPrevista)
        || (a.sequencia || 0) - (b.sequencia || 0)
    );
    cronograma.forEach((c, i) => { c.ordemSequencia = i + 1; });

    const dataConclusaoPrevistaGeral = cronograma.length
        ? cronograma.reduce((max, c) => (c.dataConclusaoPrevista > max ? c.dataConclusaoPrevista : max), cronograma[0].dataConclusaoPrevista)
        : null;

    return { cronograma, dataConclusaoPrevistaGeral, avisos };
};

/**
 * Agrupa os itens nas ordens que serão criadas — uma por executor, peças e mão
 * de obra no mesmo documento (decisão do processo). `tipo` sai 'compra' quando
 * todos os itens do grupo vêm do estoque, senão 'servico'.
 */
const agruparPorExecutor = (itens, cronogramaPorItem, partnersPorId) => {
    const grupos = new Map();

    for (const item of (itens || []).filter(i => i.status !== 'Cancelado')) {
        const executorId = resolverExecutor(item);
        if (!executorId) continue; // sem executor não vira ordem

        if (!grupos.has(executorId)) {
            const partner = partnersPorId.get(executorId);
            grupos.set(executorId, {
                executorPartnerId: executorId,
                executorNome: partner?.nomeFantasia || partner?.razaoSocial || item.executorNome || 'Executor não identificado',
                executorInterno: !!partner?.is_interno,
                itens: [],
                totalEstimado: 0,
                dataConclusaoPrevista: null,
            });
        }

        const grupo = grupos.get(executorId);
        const quantidade = Number(item.quantidade) || 1;
        const valorUnit = Number(item.valorEstimado) || 0;
        const crono = cronogramaPorItem.get(item.id);

        grupo.itens.push({
            id: item.id,
            sequencia: item.sequencia,
            gravidade: item.gravidade,
            itemComponente: item.itemComponente,
            descricaoProblema: item.descricaoProblema,
            servicoDescricao: item.servicoDescricao,
            inventoryItemId: item.inventoryItemId || null,
            quantidade,
            valorEstimado: item.valorEstimado == null ? null : valorUnit,
            dataInicioPrevista: crono?.dataInicioPrevista || null,
            dataConclusaoPrevista: crono?.dataConclusaoPrevista || null,
        });
        grupo.totalEstimado += quantidade * valorUnit;

        if (crono?.dataConclusaoPrevista
            && (!grupo.dataConclusaoPrevista || crono.dataConclusaoPrevista > grupo.dataConclusaoPrevista)) {
            grupo.dataConclusaoPrevista = crono.dataConclusaoPrevista;
        }
    }

    return [...grupos.values()].map(g => ({
        ...g,
        // Só é ordem de COMPRA quando tudo no grupo saiu do estoque; qualquer
        // mão de obra junto já faz o documento virar ordem de serviço.
        tipo: g.itens.length > 0 && g.itens.every(i => i.inventoryItemId) ? 'compra' : 'servico',
    }));
};

/** Carrega os partners citados pelos itens, para resolver nome e flag interna. */
const carregarPartnersDosItens = async (dbClient, itens) => {
    const ids = [...new Set((itens || []).map(resolverExecutor).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const [rows] = await dbClient.query(
        `SELECT id, razaoSocial, nomeFantasia, is_oficina, is_interno, status_operacional
           FROM partners WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
    );
    return new Map(rows.map(r => [r.id, r]));
};

/**
 * Monta a prévia completa do fechamento (sem persistir nada): agrupamento das
 * ordens + cronograma + avisos.
 */
const montarPreview = async (dbClient, { relato, itens, dataBase, regiao = null }) => {
    const holidaySet = await loadHolidaySet(dbClient, { regiao });
    const slaConfig = await carregarSlaConfig(dbClient);
    const base = toYmd(dataBase) || toYmd(new Date());

    const { cronograma, dataConclusaoPrevistaGeral, avisos } = computeCronograma(itens, base, holidaySet, slaConfig);
    const cronogramaPorItem = new Map(cronograma.map(c => [c.itemId, c]));

    const partnersPorId = await carregarPartnersDosItens(dbClient, itens);
    const grupos = agruparPorExecutor(itens, cronogramaPorItem, partnersPorId);

    for (const g of grupos) {
        const p = partnersPorId.get(g.executorPartnerId);
        if (p && p.status_operacional === 'BLOQUEADO') {
            avisos.push(`Executor "${g.executorNome}" está BLOQUEADO no cadastro de parceiros.`);
        }
    }

    return {
        dataBase: base,
        grupos,
        cronograma,
        dataConclusaoPrevistaGeral,
        avisos,
        slaConfig,
    };
};

module.exports = {
    carregarSlaConfig,
    carregarPartnersDosItens,
    resolverExecutor,
    computeCronograma,
    agruparPorExecutor,
    montarPreview,
};
