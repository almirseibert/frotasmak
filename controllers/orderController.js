// controllers/orderController.js
const db = require('../database');

const parseJsonFields = (item) => {
    if (!item) return null;
    const newItem = { ...item };
    if (newItem.items) newItem.items = JSON.parse(newItem.items);
    if (newItem.payment) newItem.payment = JSON.parse(newItem.payment);
    if (newItem.createdBy) newItem.createdBy = JSON.parse(newItem.createdBy);
    if (newItem.editedBy) newItem.editedBy = JSON.parse(newItem.editedBy);
    return newItem;
};

const getAllOrders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders');
        res.json(rows.map(parseJsonFields));
    } catch (error) {
        console.error('Erro ao buscar ordens:', error);
        res.status(500).json({ error: 'Erro ao buscar ordens' });
    }
};

const getOrderById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        res.json(parseJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar ordem:', error);
        res.status(500).json({ error: 'Erro ao buscar ordem' });
    }
};

const createOrder = async (req, res) => {
    const data = req.body;
    if (data.items) data.items = JSON.stringify(data.items);
    if (data.payment) data.payment = JSON.stringify(data.payment);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);
    if (data.editedBy) data.editedBy = JSON.stringify(data.editedBy);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO orders (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar ordem:', error);
        res.status(500).json({ error: 'Erro ao criar ordem' });
    }
};

const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.items) data.items = JSON.stringify(data.items);
    if (data.payment) data.payment = JSON.stringify(data.payment);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);
    if (data.editedBy) data.editedBy = JSON.stringify(data.editedBy);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE orders SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Ordem atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar ordem:', error);
        res.status(500).json({ error: 'Erro ao atualizar ordem' });
    }
};

const deleteOrder = async (req, res) => {
    try {
        await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
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
};