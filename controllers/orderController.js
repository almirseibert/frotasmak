// controllers/orderController.js
const db = require('../database');

// --- Função Auxiliar Segura de JSON ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field; 
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'.`);
        return null; 
    }
};

const parseOrderJsonFields = (order) => {
    if (!order) return null;
    const newOrder = { ...order };
    newOrder.items = parseJsonSafe(newOrder.items, 'items');
    newOrder.payment = parseJsonSafe(newOrder.payment, 'payment');
    newOrder.createdBy = parseJsonSafe(newOrder.createdBy, 'createdBy');
    newOrder.editedBy = parseJsonSafe(newOrder.editedBy, 'editedBy');
    newOrder.anexos = parseJsonSafe(newOrder.anexos, 'anexos') || []; 
    return newOrder;
};

// --- READ ---
const getAllOrders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders ORDER BY orderNumber DESC');
        res.json(rows.map(parseOrderJsonFields));
    } catch (error) {
        console.error('Erro ao buscar ordens:', error);
        res.status(500).json({ error: 'Erro ao buscar ordens' });
    }
};

const getOrderById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada' });
        res.json(parseOrderJsonFields(rows[0]));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar ordem' });
    }
};

// --- CREATE ---
const createOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE');
        const newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;

        const orderData = {
            orderNumber: newOrderNumber,
            date: new Date(data.date),
            supplierId: data.supplierId || null, 
            supplier: data.supplier || null,     
            employeeId: data.employeeId || null,
            operatorId: data.operatorId || null, // Novo campo de Operador
            obraId: data.obraId || null,
            vehicleId: data.vehicleId || null,
            revisionId: data.revisionId || null,
            totalValue: data.totalValue || 0,
            status: data.status || 'Aberta',
            invoiceNumber: data.invoiceNumber || null,
            items: JSON.stringify(data.items),
            payment: JSON.stringify(data.payment),
            createdBy: JSON.stringify(data.createdBy),
            editedBy: null,
            anexos: JSON.stringify(data.anexos || [])
        };
        
        // CORREÇÃO: Utilizar .query() no lugar de .execute() para suportar o formato objeto "SET ?"
        const [result] = await connection.query('INSERT INTO orders SET ?', [orderData]);
        const orderId = result.insertId;

        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "purchaseOrderCounter"', [newOrderNumber]);

        // A DESPESA É GERADA COM BASE NO STATUS FINAL DA ORDEM
        if (orderData.status === 'Concluída' || (orderData.status === 'Ativa' && orderData.totalValue > 0)) {
            const expenseData = {
                orderId: orderId,
                description: `Ordem C/S #${String(newOrderNumber).padStart(6, '0')} - ${data.supplier || 'Fornecedor'}`,
                amount: orderData.totalValue,
                obraId: data.obraId,
                category: 'Manutenção / Compras',
                createdAt: new Date(),
                createdBy: orderData.createdBy,
            };
            // Mesma regra do .query() aqui
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
        }
        
        await connection.commit();
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

// --- UPDATE ---
const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        const originalOrder = parseOrderJsonFields(orderRows[0]);
        const newStatus = data.status;

        const orderUpdateData = {
            supplierId: data.supplierId || null,
            supplier: data.supplier || null,
            employeeId: data.employeeId || null,
            operatorId: data.operatorId || null, // Novo campo de Operador
            obraId: data.obraId || null,
            vehicleId: data.vehicleId || null,
            revisionId: data.revisionId || null,
            invoiceNumber: data.invoiceNumber || null,
            status: newStatus,
            totalValue: data.totalValue || 0,
            date: new Date(data.date),
            items: JSON.stringify(data.items),
            payment: JSON.stringify(data.payment),
            editedBy: JSON.stringify(data.editedBy),
            anexos: JSON.stringify(data.anexos || [])
        };
        
        // CORREÇÃO: .query() no lugar de .execute()
        await connection.query('UPDATE orders SET ? WHERE id = ?', [orderUpdateData, id]);

        const originalIsClosed = originalOrder.status === 'Concluída' || originalOrder.status === 'Ativa';
        const newIsClosed = newStatus === 'Concluída' || newStatus === 'Ativa';

        if (!originalIsClosed && newIsClosed) {
            // GERAR DESPESA
            const expenseData = {
                orderId: id,
                description: `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                amount: orderUpdateData.totalValue,
                obraId: data.obraId,
                category: 'Manutenção / Compras',
                createdAt: new Date(),
                createdBy: orderUpdateData.editedBy || orderUpdateData.createdBy,
            };
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
            
        } else if (originalIsClosed && !newIsClosed) {
            // ESTORNAR/DELETAR DESPESA
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
            
        } else if (originalIsClosed && newIsClosed) {
            // ATUALIZAR DESPESA EXISTENTE
            await connection.execute('UPDATE expenses SET amount = ?, description = ?, obraId = ? WHERE orderId = ?', [
                orderUpdateData.totalValue,
                `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                data.obraId,
                id,
            ]);
        }

        await connection.commit();
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

// --- CANCEL ---
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        const originalOrder = parseOrderJsonFields(orderRows[0]);
        
        await connection.execute('UPDATE orders SET status = "Cancelada" WHERE id = ?', [id]);

        if (originalOrder.status === 'Concluída' || originalOrder.status === 'Ativa') {
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        }

        await connection.commit();
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

const deleteOrder = async (req, res) => {
    try {
        await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
        req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
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