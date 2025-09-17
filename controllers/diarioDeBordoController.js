// controllers/diarioDeBordoController.js
const db = require('../database');

const parseJsonFields = (item) => {
    if (!item) return null;
    const newItem = { ...item };
    if (newItem.startReadings) newItem.startReadings = JSON.parse(newItem.startReadings);
    if (newItem.endReadings) newItem.endReadings = JSON.parse(newItem.endReadings);
    if (newItem.breaks) newItem.breaks = JSON.parse(newItem.breaks);
    if (newItem.createdBy) newItem.createdBy = JSON.parse(newItem.createdBy);
    return newItem;
};

const getAllDiarioDeBordo = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM diario_de_bordo');
        res.json(rows.map(parseJsonFields));
    } catch (error) {
        console.error('Erro ao buscar diário de bordo:', error);
        res.status(500).json({ error: 'Erro ao buscar diário de bordo' });
    }
};

const getDiarioDeBordoById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM diario_de_bordo WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Registro não encontrado' });
        }
        res.json(parseJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar registro:', error);
        res.status(500).json({ error: 'Erro ao buscar registro' });
    }
};

const createDiarioDeBordo = async (req, res) => {
    const data = req.body;
    if (data.startReadings) data.startReadings = JSON.stringify(data.startReadings);
    if (data.endReadings) data.endReadings = JSON.stringify(data.endReadings);
    if (data.breaks) data.breaks = JSON.stringify(data.breaks);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO diario_de_bordo (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar registro de diário de bordo:', error);
        res.status(500).json({ error: 'Erro ao criar registro de diário de bordo' });
    }
};

const updateDiarioDeBordo = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.startReadings) data.startReadings = JSON.stringify(data.startReadings);
    if (data.endReadings) data.endReadings = JSON.stringify(data.endReadings);
    if (data.breaks) data.breaks = JSON.stringify(data.breaks);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE diario_de_bordo SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Registro de diário de bordo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar registro:', error);
        res.status(500).json({ error: 'Erro ao atualizar registro' });
    }
};

const deleteDiarioDeBordo = async (req, res) => {
    try {
        await db.execute('DELETE FROM diario_de_bordo WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar registro:', error);
        res.status(500).json({ error: 'Erro ao deletar registro' });
    }
};

module.exports = {
    getAllDiarioDeBordo,
    getDiarioDeBordoById,
    createDiarioDeBordo,
    updateDiarioDeBordo,
    deleteDiarioDeBordo,
};