// services/relatoStatusService.js
//
// Fecha o ciclo do relato de ocorrência a partir das ordens: quando as ordens
// de um item chegam a um estado terminal, o item conclui; quando todos os itens
// concluem, o relato conclui e o equipamento volta para a frota.
//
// Roda DEPOIS do commit de quem chama (updateOrder / cancelOrder), em transação
// própria: uma falha ao propagar não pode desfazer o fechamento da ordem, que é
// o ato que o usuário pediu.

const db = require('../database');
const { endMaintenanceTx } = require('./vehicleStateService');
const { todayBRT } = require('../utils/dateBRT');

const ORDEM_TERMINAL = ['Concluída', 'Cancelada'];
const VEICULO_EM_MANUTENCAO = ['Em Manutenção', 'Aguardando Manutenção'];

/**
 * Propaga o estado de uma ordem para o item e o relato de origem.
 * No-op silencioso para ordens que não vieram de relato.
 *
 * @param {string} orderId
 * @param {object} req  usado só para emitir server:sync (opcional)
 */
const syncRelatoFromOrder = async (orderId, req = null) => {
    if (!orderId) return null;

    const [[ordem]] = await db.execute('SELECT id, relatoId FROM orders WHERE id = ?', [orderId]);
    if (!ordem?.relatoId) return null;

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const relatoId = ordem.relatoId;

        const [[relato]] = await connection.execute(
            'SELECT * FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [relatoId]
        );
        if (!relato || ['Concluído', 'Cancelado'].includes(relato.status)) {
            await connection.rollback();
            return null;
        }

        // 1. Itens ligados a esta ordem ------------------------------------
        const [itensDaOrdem] = await connection.execute(
            'SELECT DISTINCT itemId FROM relato_item_ordens WHERE orderId = ?', [orderId]
        );

        for (const { itemId } of itensDaOrdem) {
            // Um item só conclui quando TODAS as suas ordens são terminais —
            // peça num fornecedor e mão de obra em outro contam as duas.
            const [ordensDoItem] = await connection.execute(
                `SELECT o.status
                   FROM relato_item_ordens rio
                   JOIN orders o ON o.id = rio.orderId
                  WHERE rio.itemId = ?`,
                [itemId]
            );
            if (ordensDoItem.length === 0) continue;

            const todasTerminais = ordensDoItem.every(o => ORDEM_TERMINAL.includes(o.status));
            if (!todasTerminais) continue;

            const todasCanceladas = ordensDoItem.every(o => o.status === 'Cancelada');
            await connection.execute(
                'UPDATE relato_ocorrencia_itens SET status = ?, dataConclusaoReal = ? WHERE id = ? AND status NOT IN (?, ?)',
                [
                    todasCanceladas ? 'Cancelado' : 'Concluído',
                    todayBRT(),
                    itemId,
                    'Concluído', 'Cancelado',
                ]
            );
        }

        // 2. O relato inteiro ----------------------------------------------
        const [itensDoRelato] = await connection.execute(
            'SELECT status FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]
        );
        const todosTerminais = itensDoRelato.length > 0
            && itensDoRelato.every(i => ['Concluído', 'Cancelado'].includes(i.status));

        let veiculoLiberado = false;
        if (todosTerminais) {
            await connection.execute(
                'UPDATE relatos_ocorrencia SET status = ?, concluidoEm = ? WHERE id = ?',
                ['Concluído', todayBRT(), relatoId]
            );
            veiculoLiberado = await liberarVeiculoSePossivel(connection, relato);
        }

        await connection.commit();

        if (req?.io) {
            req.io.emit('server:sync', { targets: ['relatos', 'orders', 'vehicles'] });
        }
        return { relatoId, relatoConcluido: todosTerminais, veiculoLiberado };
    } catch (error) {
        await connection.rollback();
        console.error('❌ [relatoStatusService] Falha ao propagar estado da ordem:', error.message);
        return null;
    } finally {
        connection.release();
    }
};

/**
 * Devolve o equipamento à frota — mas só se ele ainda estiver em manutenção E
 * não houver OUTRO relato aberto para o mesmo veículo. Sem a segunda condição,
 * concluir um relato liberaria um equipamento ainda quebrado por outro.
 */
const liberarVeiculoSePossivel = async (connection, relato) => {
    if (!relato?.vehicleId) return false;

    const [[v]] = await connection.execute('SELECT status FROM vehicles WHERE id = ?', [relato.vehicleId]);
    if (!v || !VEICULO_EM_MANUTENCAO.includes(v.status)) return false;

    const [[{ n }]] = await connection.execute(
        `SELECT COUNT(*) n FROM relatos_ocorrencia
          WHERE vehicleId = ? AND id <> ? AND status = 'Em Execução'`,
        [relato.vehicleId, relato.id]
    );
    if (n > 0) return false;

    await endMaintenanceTx(connection, relato.vehicleId, {
        location: relato.localManutencao || 'Pátio',
    });
    return true;
};

/**
 * Versão "fire and forget" para chamar depois do commit sem travar a resposta
 * HTTP nem derrubar o request se a propagação falhar.
 */
const syncRelatoFromOrderAsync = (orderId, req = null) => {
    setImmediate(() => {
        syncRelatoFromOrder(orderId, req).catch(e =>
            console.error('❌ [relatoStatusService] erro assíncrono:', e.message)
        );
    });
};

module.exports = {
    ORDEM_TERMINAL,
    syncRelatoFromOrder,
    syncRelatoFromOrderAsync,
    liberarVeiculoSePossivel,
};
