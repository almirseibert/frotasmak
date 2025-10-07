// controllers/employeeController.js
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
const parseEmployeeJsonFields = (employee) => {
    if (!employee) return null;
    const newEmployee = { ...employee };
    
    // Aplicação da função segura:
    newEmployee.alocadoEm = parseJsonSafe(newEmployee.alocadoEm, 'alocadoEm');
    newEmployee.ultimaAlteracao = parseJsonSafe(newEmployee.ultimaAlteracao, 'ultimaAlteracao');
    
    return newEmployee;
};

// --- READ: Obter todos os funcionários ---
const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM employees');
        res.json(rows.map(parseEmployeeJsonFields));
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar funcionários' });
    }
};

// --- READ: Obter um único funcionário por ID ---
const getEmployeeById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM employees WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Funcionário não encontrado' });
        }
        res.json(parseEmployeeJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar funcionário:', error);
        res.status(500).json({ error: 'Erro ao buscar funcionário' });
    }
};

// --- CREATE: Criar um novo funcionário ---
const createEmployee = async (req, res) => {
    const data = req.body;
    
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO employees (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar funcionário:', error);
        res.status(500).json({ error: 'Erro ao criar funcionário' });
    }
};

// --- UPDATE: Atualizar um funcionário existente ---
const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE employees SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Funcionário atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar funcionário:', error);
        res.status(500).json({ error: 'Erro ao atualizar funcionário' });
    }
};

// --- DELETE: Deletar um funcionário ---
const deleteEmployee = async (req, res) => {
    try {
        await db.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar funcionário:', error);
        res.status(500).json({ error: 'Erro ao deletar funcionário' });
    }
};

module.exports = {
    getAllEmployees,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    parseEmployeeJsonFields // Exportado para uso em outros controllers
};
