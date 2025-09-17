// controllers/vehicleController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON ---
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    if (newVehicle.fuelLevels) newVehicle.fuelLevels = JSON.parse(newVehicle.fuelLevels);
    if (newVehicle.alocadoEm) newVehicle.alocadoEm = JSON.parse(newVehicle.alocadoEm);
    if (newVehicle.history) newVehicle.history = JSON.parse(newVehicle.history);
    return newVehicle;
};

// --- READ: Obter todos os veículos ---
const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        res.json(rows.map(parseVehicleJsonFields));
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

// --- READ: Obter um único veículo por ID ---
const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        res.json(parseVehicleJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar veículo:', error);
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

// --- CREATE: Criar um novo veículo ---
const createVehicle = async (req, res) => {
    const data = req.body;
    
    // Converte campos complexos para strings JSON antes de inserir
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.history) data.history = JSON.stringify(data.history);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar veículo:', error);
        res.status(500).json({ error: 'Erro ao criar veículo' });
    }
};

// --- UPDATE: Atualizar um veículo existente ---
const updateVehicle = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    // Converte campos complexos para strings JSON antes de atualizar
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.history) data.history = JSON.stringify(data.history);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE vehicles SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Veículo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar veículo:', error);
        res.status(500).json({ error: 'Erro ao atualizar veículo' });
    }
};

// --- DELETE: Deletar um veículo ---
const deleteVehicle = async (req, res) => {
    try {
        await db.execute('DELETE FROM vehicles WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar veículo:', error);
        res.status(500).json({ error: 'Erro ao deletar veículo' });
    }
};

module.exports = {
    getAllVehicles,
    getVehicleById,
    createVehicle,
    updateVehicle,
    deleteVehicle,
};