// controllers/revisionController.js
const db = require('../database');

const parseJsonFields = (item) => {
    if (!item) return null;
    const newItem = { ...item };
    if (newItem.ultimaAlteracao) newItem.ultimaAlteracao = JSON.parse(newItem.ultimaAlteracao);
    return newItem;
};

const getAllRevisions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM revisions');
        res.json(rows.map(parseJsonFields));
    } catch (error) {
        console.error('Erro ao buscar revisões:', error);
        res.status(500).json({ error: 'Erro ao buscar revisões' });
    }
};

const getRevisionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM revisions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Revisão não encontrada' });
        }
        res.json(parseJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar revisão' });
    }
};

const createRevision = async (req, res) => {
    const data = req.body;
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar revisão:', error);
        res.status(500).json({ error: 'Erro ao criar revisão' });
    }
};

const updateRevision = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);
    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Revisão atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar revisão:', error);
        res.status(500).json({ error: 'Erro ao atualizar revisão' });
    }
};

const deleteRevision = async (req, res) => {
    try {
        await db.execute('DELETE FROM revisions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar revisão:', error);
        res.status(500).json({ error: 'Erro ao deletar revisão' });
    }
};

module.exports = {
    getAllRevisions,
    getRevisionById,
    createRevision,
    updateRevision,
    deleteRevision,
};