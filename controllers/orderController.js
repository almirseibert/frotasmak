// controllers/orderController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro (parseJsonSafe) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    
    // Se já for um objeto/array (por exemplo, se o driver do MySQL já parseou a coluna JSON)
    if (typeof field === 'object') return field; 
    
    // Garante que é uma string antes de tentar o parse
    if (typeof field !== 'string') return field;

    try {
        // Tenta fazer o parse da string
        const parsed = JSON.parse(field);
        
        // Verifica se o resultado do parse é um objeto/array válido
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        // Retorna null em caso de erro, impedindo a quebra da aplicação.
        return null; 
    }
};


// --- Função Auxiliar para Conversão de JSON ---
const parseOrderJsonFields = (order) => {
    if (!order) return null;
    const newOrder = { ...order };
    
    // Aplicação da função segura:
    newOrder.items = parseJsonSafe(newOrder.items, 'items');
    newOrder.payment = parseJsonSafe(newOrder.payment, 'payment');
    newOrder.createdBy = parseJsonSafe(newOrder.createdBy, 'createdBy');
    newOrder.editedBy = parseJsonSafe(newOrder.editedBy, 'editedBy');

    return newOrder;
};

// --- READ: Obter todas as ordens ---
const getAllOrders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders ORDER BY orderNumber DESC');
        res.json(rows.map(parseOrderJsonFields));
    } catch (error) {
        console.error('Erro ao buscar ordens:', error);
        res.status(500).json({ error: 'Erro ao buscar ordens' });
    }
};

// --- READ: Obter uma única ordem por ID ---
const getOrderById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        res.json(parseOrderJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar ordem:', error);
        res.status(500).json({ error: 'Erro ao buscar ordem' });
    }
};

// --- CREATE: Criar uma nova ordem ---
const createOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE');
        const newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;

        const orderData = {
            ...data,
            orderNumber: newOrderNumber,
            date: new Date(data.date),
            totalValue: data.totalValue || 0,
            status: data.status,
            // JSON.stringify é mantido para garantir que os dados sejam salvos corretamente no MySQL
            items: JSON.stringify(data.items),
            payment: JSON.stringify(data.payment),
            createdBy: JSON.stringify(data.createdBy),
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null,
        };
        const [result] = await connection.execute('INSERT INTO orders SET ?', [orderData]);
        const orderId = result.insertId;

        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "purchaseOrderCounter"', [newOrderNumber]);

        if (orderData.status !== 'Pendente de Valor') {
            const expenseData = {
                orderId: orderId,
                description: `Ordem Compra/Serviço #${String(newOrderNumber).padStart(6, '0')} - ${data.supplier}`,
                amount: orderData.totalValue,
                obraId: data.obraId,
                category: 'Ordem de Compra/Serviço',
                createdAt: new Date(),
                createdBy: orderData.createdBy,
            };
            await connection.execute('INSERT INTO expenses SET ?', [expenseData]);
        }
        
        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        // Atualiza tanto a lista de ordens quanto o painel financeiro (se gerou despesa)
        req.io.emit('server:sync', { targets: ['orders', 'expenses'] });

        res.status(201).json({ id: orderId, orderNumber: newOrderNumber });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao criar ordem:', error);
        res.status(500).json({ error: 'Falha ao salvar a ordem.' });
    } finally {
        connection.release();
    }
};


// --- UPDATE: Atualizar uma ordem existente ---
const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        // Garante que originalOrder seja parseado com segurança
        const originalOrder = parseOrderJsonFields(orderRows[0]);
        const newStatus = data.status;

        const orderUpdateData = {
            ...data,
            totalValue: data.totalValue || 0,
            date: new Date(data.date),
            items: JSON.stringify(data.items),
            payment: JSON.stringify(data.payment),
            editedBy: JSON.stringify(data.editedBy),
        };
        await connection.execute('UPDATE orders SET ? WHERE id = ?', [orderUpdateData, id]);

        if (originalOrder.status === 'Pendente de Valor' && newStatus !== 'Pendente de Valor') {
            const expenseData = {
                orderId: id,
                description: `Ordem Compra/Serviço #${String(originalOrder.orderNumber).padStart(6, '0')} - ${data.supplier}`,
                amount: orderUpdateData.totalValue,
                obraId: data.obraId,
                category: 'Ordem de Compra/Serviço',
                createdAt: new Date(),
                createdBy: orderUpdateData.createdBy,
            };
            await connection.execute('INSERT INTO expenses SET ?', [expenseData]);
        } else if (originalOrder.status !== 'Pendente de Valor' && newStatus !== 'Pendente de Valor') {
            await connection.execute('UPDATE expenses SET amount = ?, description = ?, obraId = ? WHERE orderId = ?', [
                orderUpdateData.totalValue,
                `Ordem Compra/Serviço #${String(originalOrder.orderNumber).padStart(6, '0')} - ${data.supplier}`,
                data.obraId,
                id,
            ]);
        }

        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['orders', 'expenses'] });

        res.status(200).json({ message: 'Ordem atualizada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar ordem:', error);
        res.status(500).json({ error: 'Falha ao atualizar a ordem.' });
    } finally {
        connection.release();
    }
};

// --- ROTA: Cancelar uma ordem ---
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        const originalOrder = parseOrderJsonFields(orderRows[0]);
        
        await connection.execute('UPDATE orders SET status = "Cancelada" WHERE id = ?', [id]);

        if (originalOrder.status !== 'Pendente de Valor') {
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        }

        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        // Importante: Cancela a ordem e remove a despesa do financeiro automaticamente
        req.io.emit('server:sync', { targets: ['orders', 'expenses'] });

        res.status(200).json({ message: 'Ordem cancelada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao cancelar ordem:', error);
        res.status(500).json({ error: 'Falha ao cancelar a ordem.' });
    } finally {
        connection.release();
    }
};

// --- DELETE: Deletar uma ordem ---
const deleteOrder = async (req, res) => {
    try {
        await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['orders'] });

        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar ordem:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem' });
    }
};

module.exports = {
    getAllOrders,
    getOrderById,
    createOrder,
    updateOrder,
    deleteOrder,
    cancelOrder,
};