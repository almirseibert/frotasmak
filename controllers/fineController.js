// controllers/fineController.js
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
const parseFineJsonFields = (fine) => {
    if (!fine) return null;
    const newFine = { ...fine };
    
    // Aplicação da função segura:
    newFine.vehicleInfo = parseJsonSafe(newFine.vehicleInfo, 'vehicleInfo');
    newFine.employeeInfo = parseJsonSafe(newFine.employeeInfo, 'employeeInfo');
    newFine.ultimaAlteracao = parseJsonSafe(newFine.ultimaAlteracao, 'ultimaAlteracao');

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
