// controllers/inactivityAlertController.js
const db = require('../database');

const getAllInactivityAlerts = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM inactivity_alerts');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar alertas de inatividade:', error);
        res.status(500).json({ error: 'Erro ao buscar alertas de inatividade' });
    }
};

const createInactivityAlert = async (req, res) => {
    const data = req.body;
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO inactivity_alerts (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao criar alerta de inatividade' });
    }
};

const updateInactivityAlert = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE inactivity_alerts SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Alerta de inatividade atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao atualizar alerta de inatividade' });
    }
};

const deleteInactivityAlert = async (req, res) => {
    try {
        await db.execute('DELETE FROM inactivity_alerts WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao deletar alerta de inatividade' });
    }
};

module.exports = {
    getAllInactivityAlerts,
    createInactivityAlert,
    updateInactivityAlert,
    deleteInactivityAlert,
};