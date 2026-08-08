// services/relatoOrderService.js
//
// Gera as Ordens de Compra/Serviço a partir de um relato de ocorrência
// (FRM-MAN-001) que está sendo fechado.
//
// Agrupamento: UMA ordem por executor — peças e mão de obra do mesmo
// fornecedor entram no mesmo documento, que é como a MAK trabalha hoje. Item
// sem executor não gera ordem.
//
// As ordens são linhas normais em `orders`, então herdam numeração via
// `counters`, PDF, notificação ao fornecedor, sincronização com `expenses` e
// baixa de estoque. O que as distingue são as colunas novas:
//   tipo     'compra' | 'servico'
//   relatoId de qual relato vieram
//   osMc     número da OS do sistema MC (financeiro externo)
//   origem   'relato'
//
// NÃO notifica o fornecedor automaticamente: o gestor revisa as ordens e
// dispara pela OrdersPage (POST /orders/:id/notify), que gera o PDF com o
// número real. Também NÃO dispara `dispatchAsync('ordem_gerada')` — esse
// template é de ordem de ABASTECIMENTO e sairia com os campos em "—".

const crypto = require('crypto');

// Mesma normalização de orderController.getSafeObraId: 'Administração' e
// 'Oficina' são pseudo-obras da UI e quebrariam a FK de orders.obraId.
const getSafeObraId = (id) => {
    if (!id) return null;
    if (id === 'Administração' || id === 'Oficina') return null;
    return id;
};

const safeStringify = (val) => {
    if (val === null || val === undefined || val === '') return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
};

/**
 * Cria as ordens de um relato. Roda DENTRO da transação de quem chama.
 *
 * @param {object} connection      conexão já em transação
 * @param {object} params
 * @param {object} params.relato   cabeçalho do relato
 * @param {Array}  params.grupos   saída de relatoCronogramaService.agruparPorExecutor
 * @param {string} params.osMc     número da OS do sistema MC
 * @param {string} params.dataBase 'YYYY-MM-DD'
 * @returns {Array} ordens criadas
 */
const gerarOrdensDoRelato = async (connection, {
    relato, grupos, osMc, dataBase, employeeIdAutorizado = null, obraCustoId = null,
    kmHrAtual = null, kmHrUnit = null, createdBy = null,
}) => {
    if (!grupos || grupos.length === 0) return [];

    // Um único lock no contador para todas as ordens do relato: o incremento
    // acontece em memória e a linha só é gravada uma vez no fim. A trava fica
    // retida até o commit, igual ao createOrder, mas com 1 round-trip.
    const [counterRows] = await connection.execute(
        'SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE'
    );
    let proximoNumero = Number(counterRows[0]?.lastNumber || 0);

    const orderDate = new Date(`${dataBase}T12:00:00`);
    const obraId = getSafeObraId(obraCustoId ?? relato.obraOrigemId);
    const criadoPor = safeStringify(createdBy);
    const ordens = [];

    for (const grupo of grupos) {
        proximoNumero += 1;
        const orderId = crypto.randomUUID();

        // A descrição do item da ordem carrega a gravidade e o componente da
        // ficha — quem recebe a ordem precisa saber a urgência sem abrir o relato.
        const items = grupo.itens.map(item => ({
            itemId: item.inventoryItemId || null,
            quantity: Number(item.quantidade) || 1,
            description: `[${item.gravidade}] ${item.itemComponente}`
                + (item.servicoDescricao ? ` — ${item.servicoDescricao}` : ` — ${item.descricaoProblema}`),
            unitPrice: Number(item.valorEstimado) || 0,
        }));

        const totalValue = items.reduce((soma, i) => soma + (i.quantity * i.unitPrice), 0);
        // Sem valor estimado a ordem nasce "a cotar" — é o mesmo estado que a
        // OrdersPage usa quando o preço ainda não é conhecido, e nesse estado
        // nenhuma despesa é lançada.
        const status = totalValue > 0 ? 'Ativa' : 'Pendente de Valor';

        const prazo = grupo.dataConclusaoPrevista
            ? ` · Prazo: ${grupo.dataConclusaoPrevista.split('-').reverse().join('/')}`
            : '';

        const rawOrderData = {
            id: orderId,
            orderNumber: proximoNumero,
            date: orderDate,
            supplierId: grupo.executorPartnerId,
            supplier: grupo.executorNome,
            employeeId: employeeIdAutorizado || null,
            operatorId: null,
            obraId,
            vehicleId: relato.vehicleId,
            kmHrAtual: kmHrAtual != null ? parseFloat(kmHrAtual) : null,
            kmHrUnit: kmHrUnit || null,
            revisionId: null,
            totalValue,
            status,
            invoiceNumber: null,
            observacoes: `OS MC ${osMc} · Relato #${relato.numero}${prazo}`,
            items: JSON.stringify(items),
            payment: null,
            createdBy: criadoPor,
            editedBy: null,
            anexos: '[]',
            tipo: grupo.tipo,
            relatoId: relato.id,
            osMc,
            origem: 'relato',
        };

        await connection.query('INSERT INTO orders SET ?', [rawOrderData]);

        // Vínculo item ↔ ordem. O UNIQUE(itemId, orderId) da tabela é a rede de
        // segurança contra geração dupla.
        for (const item of grupo.itens) {
            await connection.query('INSERT INTO relato_item_ordens SET ?', [{
                id: crypto.randomUUID(),
                relatoId: relato.id,
                itemId: item.id,
                orderId,
                papel: item.inventoryItemId ? 'peca' : 'servico',
            }]);
        }

        // Mesma regra do createOrder: despesa só quando a ordem já nasce com
        // valor. As "a cotar" geram despesa depois, no fechamento com NF.
        if (status === 'Ativa' && obraId) {
            await connection.query('INSERT INTO expenses SET ?', [{
                id: crypto.randomUUID(),
                orderId,
                description: `Ordem C/S #${String(proximoNumero).padStart(6, '0')} - ${grupo.executorNome}`,
                amount: totalValue,
                obraId,
                category: 'Manutenção / Compras',
                createdAt: orderDate,
                createdBy: criadoPor,
            }]);
        }

        ordens.push({
            id: orderId,
            orderNumber: proximoNumero,
            supplierId: grupo.executorPartnerId,
            supplier: grupo.executorNome,
            tipo: grupo.tipo,
            status,
            totalValue,
            osMc,
            itemIds: grupo.itens.map(i => i.id),
            dataConclusaoPrevista: grupo.dataConclusaoPrevista,
        });
    }

    await connection.execute(
        'INSERT INTO counters (name, lastNumber) VALUES ("purchaseOrderCounter", ?) ON DUPLICATE KEY UPDATE lastNumber = ?',
        [proximoNumero, proximoNumero]
    );

    return ordens;
};

/** Ordens já geradas por um relato (usado na resposta 409 de duplo-clique). */
const listarOrdensDoRelato = async (dbClient, relatoId) => {
    const [rows] = await dbClient.execute(
        `SELECT id, orderNumber, supplier, supplierId, status, totalValue, tipo, osMc
           FROM orders WHERE relatoId = ? ORDER BY orderNumber ASC`,
        [relatoId]
    );
    return rows.map(r => ({ ...r, totalValue: Number(r.totalValue) }));
};

module.exports = {
    getSafeObraId,
    gerarOrdensDoRelato,
    listarOrdensDoRelato,
};
