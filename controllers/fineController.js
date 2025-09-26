// controllers/fineController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON ---
const parseFineJsonFields = (fine) => {
    if (!fine) return null;
    const newFine = { ...fine };
    if (newFine.vehicleInfo) newFine.vehicleInfo = JSON.parse(newFine.vehicleInfo);
    if (newFine.employeeInfo) newFine.employeeInfo = JSON.parse(newFine.employeeInfo);
    if (newFine.ultimaAlteracao) newFine.ultimaAlteracao = JSON.parse(newFine.ultimaAlteracao);
    return newFine;
};

// --- READ: Obter todas as multas ---
const getAllFines = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM fines');
        res.json(rows.map(parseFineJsonFields));
    } catch (error) {
        console.error('Erro ao buscar multas:', error);
        res.status(500).json({ error: 'Erro ao buscar multas' });
    }
};

// --- READ: Obter uma única multa por ID ---
const getFineById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM fines WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Multa não encontrada' });
        }
        res.json(parseFineJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar multa:', error);
        res.status(500).json({ error: 'Erro ao buscar multa' });
    }
};

// --- CREATE: Criar uma nova multa ---
const createFine = async (req, res) => {
    const data = req.body;
    
    if (data.vehicleInfo) data.vehicleInfo = JSON.stringify(data.vehicleInfo);
    if (data.employeeInfo) data.employeeInfo = JSON.stringify(data.employeeInfo);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO fines (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar multa:', error);
        res.status(500).json({ error: 'Erro ao criar multa' });
    }
};

// --- UPDATE: Atualizar uma multa existente ---
const updateFine = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.vehicleInfo) data.vehicleInfo = JSON.stringify(data.vehicleInfo);
    if (data.employeeInfo) data.employeeInfo = JSON.stringify(data.employeeInfo);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE fines SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Multa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar multa:', error);
        res.status(500).json({ error: 'Erro ao atualizar multa' });
    }
};

// --- DELETE: Deletar uma multa ---
const deleteFine = async (req, res) => {
    try {
        await db.execute('DELETE FROM fines WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar multa:', error);
        res.status(500).json({ error: 'Erro ao deletar multa' });
    }
};

module.exports = {
    getAllFines,
    getFineById,
    createFine,
    updateFine,
    deleteFine,
};