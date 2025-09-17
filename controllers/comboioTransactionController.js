// controllers/comboioTransactionController.js
const db = require('../database');

const getAllComboioTransactions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar transações de comboio:', error);
        res.status(500).json({ error: 'Erro ao buscar transações de comboio' });
    }
};

const getComboioTransactionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Transação não encontrada' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar transação:', error);
        res.status(500).json({ error: 'Erro ao buscar transação' });
    }
};

const createComboioTransaction = async (req, res) => {
    const data = req.body;
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar transação de comboio:', error);
        res.status(500).json({ error: 'Erro ao criar transação de comboio' });
    }
};

const updateComboioTransaction = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE comboio_transactions SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Transação atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar transação de comboio:', error);
        res.status(500).json({ error: 'Erro ao atualizar transação de comboio' });
    }
};

const deleteComboioTransaction = async (req, res) => {
    try {
        await db.execute('DELETE FROM comboio_transactions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar transação de comboio:', error);
        res.status(500).json({ error: 'Erro ao deletar transação de comboio' });
    }
};

module.exports = {
    getAllComboioTransactions,
    getComboioTransactionById,
    createComboioTransaction,
    updateComboioTransaction,
    deleteComboioTransaction,
};