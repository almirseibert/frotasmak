// controllers/refuelingController.js
const db = require('../database');

const parseJsonFields = (item) => {
    if (!item) return null;
    const newItem = { ...item };
    if (newItem.createdBy) newItem.createdBy = JSON.parse(newItem.createdBy);
    if (newItem.confirmedBy) newItem.confirmedBy = JSON.parse(newItem.confirmedBy);
    if (newItem.editedBy) newItem.editedBy = JSON.parse(newItem.editedBy);
    return newItem;
};

const getAllRefuelings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings');
        res.json(rows.map(parseJsonFields));
    } catch (error) {
        console.error('Erro ao buscar abastecimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimentos' });
    }
};

const getRefuelingById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Abastecimento não encontrado' });
        }
        res.json(parseJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimento' });
    }
};

const createRefueling = async (req, res) => {
    const data = req.body;
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);
    if (data.confirmedBy) data.confirmedBy = JSON.stringify(data.confirmedBy);
    if (data.editedBy) data.editedBy = JSON.stringify(data.editedBy);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO refuelings (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao criar abastecimento' });
    }
};

const updateRefueling = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);
    if (data.confirmedBy) data.confirmedBy = JSON.stringify(data.confirmedBy);
    if (data.editedBy) data.editedBy = JSON.stringify(data.editedBy);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE refuelings SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Abastecimento atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao atualizar abastecimento' });
    }
};

const deleteRefueling = async (req, res) => {
    try {
        await db.execute('DELETE FROM refuelings WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao deletar abastecimento' });
    }
};

module.exports = {
    getAllRefuelings,
    getRefuelingById,
    createRefueling,
    updateRefueling,
    deleteRefueling,
};