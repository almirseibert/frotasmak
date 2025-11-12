const db = require('../database');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;

    try {
        const parsed = JSON.parse(field);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao analisar o campo '${key}'. Valor problemático:`, field);
        return null;
    }
};

// --- Função Auxiliar para processar campos JSON de um funcionário ---
const parseEmployeeJsonFields = (employee) => {
    if (!employee) return null;
    const newEmployee = { ...employee };
    newEmployee.alocadoEm = parseJsonSafe(employee.alocadoEm, 'alocadoEm');
    newEmployee.ultimaAlteracao = parseJsonSafe(employee.ultimaAlteracao, 'ultimaAlteracao');
    return newEmployee;
};

// --- GET: Todos os funcionários ---
const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees');
        const employees = rows.map(parseEmployeeJsonFields);
        res.json(employees);
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar funcionários' });
    }
};

// --- GET: Um funcionário por ID ---
const getEmployeeById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Funcionário não encontrado' });
        }
        const employee = parseEmployeeJsonFields(rows[0]);
        res.json(employee);
    } catch (error) {
        console.error('Erro ao buscar funcionário por ID:', error);
        res.status(500).json({ error: 'Erro ao buscar funcionário' });
    }
};

// --- (NOVO) Lista de campos permitidos da tabela 'employees' ---
// (Baseado no seu frotasmak (1).sql)
const allowedEmployeeFields = [
    'id',
    'userId',
    'nome',
    'vulgo',
    'funcao',
    'registroInterno',
    'cpf',
    'endereco',
    'cidade',
    'contato',
    'status',
    'dataContratacao',
    'cnhNumero',
    'cnhCategoria',
    'cnhVencimento',
    'podeAcessarAbastecimento',
    'alocadoEm',
    'ultimaAlteracao'
];

// --- POST: Criar um novo funcionário (CORRIGIDO E SEGURO) ---
const createEmployee = async (req, res) => {
    const data = req.body;
    
    // 1. Filtra apenas os campos permitidos
    const employeeData = {};
    Object.keys(data).forEach(key => {
        if (allowedEmployeeFields.includes(key)) {
            employeeData[key] = data[key];
        }
    });

    // 2. Validação crucial (ID e Nome/Registro)
    if (!employeeData.id) {
        return res.status(400).json({ error: 'ID do funcionário é obrigatório (gerado pelo cliente).' });
    }
    if (!employeeData.nome || !employeeData.registroInterno) {
         return res.status(400).json({ error: 'Nome e Registro Interno são obrigatórios.' });
    }

    // 3. Define o status padrão se não for fornecido
    if (!employeeData.status) {
        employeeData.status = 'ativo';
    }

    // 4. Stringify campos JSON
    if (employeeData.alocadoEm) employeeData.alocadoEm = JSON.stringify(employeeData.alocadoEm);
    if (employeeData.ultimaAlteracao) employeeData.ultimaAlteracao = JSON.stringify(employeeData.ultimaAlteracao);

    // 5. Constrói a query
    const fields = Object.keys(employeeData);
    const values = Object.values(employeeData);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO employees (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        res.status(201).json({ id: employeeData.id, ...req.body }); // Retorna o objeto completo
    } catch (error) {
        console.error('Erro ao criar funcionário:', error);
        res.status(500).json({ error: 'Erro ao criar funcionário' });
    }
};

// --- UPDATE: Atualizar um funcionário existente (CORRIGIDO E SEGURO) ---
const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    // 1. Filtra apenas os campos permitidos (exceto 'id' e 'userId' que não devem ser mudados aqui)
    const employeeData = {};
    Object.keys(data).forEach(key => {
        if (allowedEmployeeFields.includes(key) && key !== 'id' && key !== 'userId') {
            employeeData[key] = data[key];
        }
    });
    
    // 2. Stringify campos JSON
    if (employeeData.alocadoEm) employeeData.alocadoEm = JSON.stringify(employeeData.alocadoEm);
    if (employeeData.ultimaAlteracao) employeeData.ultimaAlteracao = JSON.stringify(employeeData.ultimaAlteracao);

    // 3. Constrói a query
    const fields = Object.keys(employeeData);
    if (fields.length === 0) {
        return res.status(400).json({ message: 'Nenhum dado para atualizar.' });
    }
    
    const values = Object.values(employeeData);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE employees SET ${setClause} WHERE id = ?`;

    try {
        const [result] = await db.execute(query, [...values, id]);
        if (result.affectedRows === 0) {
             return res.status(404).json({ message: 'Funcionário não encontrado.' });
        }
        res.json({ message: 'Funcionário atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar funcionário:', error);
        res.status(500).json({ error: 'Erro ao atualizar funcionário' });
    }
};

// --- DELETE: Deletar um funcionário ---
const deleteEmployee = async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
         if (result.affectedRows === 0) {
             return res.status(404).json({ message: 'Funcionário não encontrado.' });
        }
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar funcionário:', error);
        res.status(500).json({ error: 'Erro ao deletar funcionário' });
    }
};

// --- FUNÇÕES QUE ESTAVAM EM FALTA (JÁ EXISTENTES NO SEU ARQUIVO) ---

// --- GET: Obter histórico de um funcionário ---
const getEmployeeHistory = async (req, res) => {
    const { id } = req.params;
    try {
        // Implementação de exemplo: esta lógica precisa ser adaptada às suas tabelas de histórico
        // Por exemplo, buscar em 'vehicle_history' onde o 'employeeId' bate
        const [historyRows] = await db.execute(
            "SELECT * FROM vehicle_history WHERE JSON_EXTRACT(details, '$.employeeId') = ?",
             [id]
        );
        
        const parsedHistory = historyRows.map(h => ({
            ...h,
            details: parseJsonSafe(h.details, 'history.details')
        }));

        res.json(parsedHistory);
    } catch (error) {
        console.error(`Erro ao buscar histórico para o funcionário ${id}:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico do funcionário' });
    }
};

// --- PUT: Atualizar o status de um funcionário ---
const updateEmployeeStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({ message: 'O novo status é obrigatório.' });
    }

    try {
        const [result] = await db.execute('UPDATE employees SET status = ? WHERE id = ?', [status, id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Funcionário não encontrado.' });
        }
        res.json({ message: 'Status do funcionário atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar status do funcionário:', error);
        res.status(500).json({ error: 'Erro ao atualizar o status do funcionário' });
    }
};


// --- EXPORTAÇÃO DE TODAS AS FUNÇÕES ---
module.exports = {
    getAllEmployees,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    getEmployeeHistory,     // Agora exportada e com lógica básica
    updateEmployeeStatus    // Agora exportada
};