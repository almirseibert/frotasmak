const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// ===================================================================================
// FUNÇÕES AUXILIARES DE SANITIZAÇÃO
// ===================================================================================

/**
 * Tenta fazer o parse de um campo que pode estar "sujo" com JSON stringificado.
 * Se falhar, retorna o valor original ou null.
 */
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field; // Já é objeto
    if (typeof field !== 'string') return field; // Não é string, retorna como está

    try {
        // Tenta detectar se parece um JSON antes de parsear
        if (field.trim().startsWith('{') || field.trim().startsWith('[')) {
            const parsed = JSON.parse(field);
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed;
            }
        }
        return field; // É uma string normal
    } catch (e) {
        return field; // Retorna a string original se der erro no parse
    }
};

/**
 * Processa e limpa os dados do funcionário vindos do banco antes de enviar ao frontend.
 * Resolve o problema crítico de status vindo como '{"status":"ativo"}'
 */
const parseEmployeeJsonFields = (employee) => {
    if (!employee) return null;
    const newEmployee = { ...employee };
    
    // Parse de campos que são legitimamente JSON
    newEmployee.alocadoEm = parseJsonSafe(employee.alocadoEm, 'alocadoEm');
    newEmployee.ultimaAlteracao = parseJsonSafe(employee.ultimaAlteracao, 'ultimaAlteracao');
    
    // CORREÇÃO CRÍTICA DE STATUS
    // Se o status no banco estiver "sujo" (ex: JSON stringificado), limpamos aqui para o frontend não quebrar.
    if (newEmployee.status && typeof newEmployee.status === 'string' && newEmployee.status.includes('{')) {
        try {
            const statusObj = JSON.parse(newEmployee.status);
            // Tenta pegar o status dentro do objeto, ou define 'ativo' como fallback seguro
            newEmployee.status = statusObj.status || 'ativo';
        } catch (e) {
            // Se não conseguir ler, assume 'ativo' para não travar a UI, mas loga o erro
            console.warn(`Falha ao limpar status do funcionário ID ${employee.id}:`, employee.status);
            newEmployee.status = 'ativo'; 
        }
    }
    
    return newEmployee;
};

// ===================================================================================
// CONTROLLERS
// ===================================================================================

// --- GET: Todos os funcionários ---
const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees');
        // Aplica a limpeza em cada registro
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

const allowedEmployeeFields = [
    'id', 'userId', 'nome', 'vulgo', 'funcao', 'registroInterno', 'cpf',
    'endereco', 'cidade', 'contato', 'status', 'dataContratacao',
    'cnhNumero', 'cnhCategoria', 'cnhVencimento', 'podeAcessarAbastecimento',
    'alocadoEm', 'ultimaAlteracao', 'dataAdmissao', 'dataDesligamento'
];

// --- POST: Criar um novo funcionário ---
const createEmployee = async (req, res) => {
    const data = req.body;
    
    const employeeData = {};
    Object.keys(data).forEach(key => {
        if (allowedEmployeeFields.includes(key)) {
            employeeData[key] = data[key];
        }
    });

    if (!employeeData.id) return res.status(400).json({ error: 'ID obrigatório.' });
    if (!employeeData.nome || !employeeData.registroInterno) return res.status(400).json({ error: 'Dados incompletos.' });

    // SANITIZAÇÃO DE STATUS NO CREATE
    if (!employeeData.status) {
        employeeData.status = 'ativo';
    } else if (typeof employeeData.status === 'object' || (typeof employeeData.status === 'string' && employeeData.status.includes('{'))) {
         // Se o frontend enviou lixo no create, forçamos 'ativo'
         employeeData.status = 'ativo';
    }

    // *** REGRA DE NEGÓCIO: Sincronia de Datas ***
    // Garante que dataContratacao (usado em relatórios antigos) seja igual à dataAdmissao (novo padrão)
    if (employeeData.dataAdmissao) {
        employeeData.dataContratacao = employeeData.dataAdmissao;
    }

    // Prepara campos JSON legítimos
    if (employeeData.alocadoEm) employeeData.alocadoEm = JSON.stringify(employeeData.alocadoEm);
    if (employeeData.ultimaAlteracao) employeeData.ultimaAlteracao = JSON.stringify(employeeData.ultimaAlteracao);

    const fields = Object.keys(employeeData);
    const values = Object.values(employeeData);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO employees (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        res.status(201).json({ id: employeeData.id, ...req.body });
    } catch (error) {
        console.error('Erro ao criar funcionário:', error);
        res.status(500).json({ error: 'Erro ao criar funcionário' });
    }
};

// --- UPDATE: Atualizar um funcionário existente ---
const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    const employeeData = {};
    Object.keys(data).forEach(key => {
        if (allowedEmployeeFields.includes(key) && key !== 'id' && key !== 'userId') {
            employeeData[key] = data[key];
        }
    });

    // *** REGRA DE NEGÓCIO: Sincronia de Datas na Edição ***
    if (employeeData.dataAdmissao) {
        employeeData.dataContratacao = employeeData.dataAdmissao;
    }

    // *** PROTEÇÃO CONTRA STATUS SUJO ***
    // Se tentarem atualizar status por aqui enviando um objeto, removemos o campo da query.
    // O status deve ser alterado preferencialmente pela rota dedicada 'updateEmployeeStatus'.
    if (employeeData.status && (typeof employeeData.status === 'object' || employeeData.status.includes('{'))) {
         delete employeeData.status; 
    }
    
    if (employeeData.alocadoEm) employeeData.alocadoEm = JSON.stringify(employeeData.alocadoEm);
    if (employeeData.ultimaAlteracao) employeeData.ultimaAlteracao = JSON.stringify(employeeData.ultimaAlteracao);

    const fields = Object.keys(employeeData);
    if (fields.length === 0) return res.status(400).json({ message: 'Nenhum dado válido para atualização.' });
    
    const values = Object.values(employeeData);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE employees SET ${setClause} WHERE id = ?`;

    try {
        const [result] = await db.execute(query, [...values, id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Funcionário não encontrado.' });
        res.json({ message: 'Atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar:', error);
        res.status(500).json({ error: 'Erro ao atualizar' });
    }
};

// --- DELETE ---
const deleteEmployee = async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
         if (result.affectedRows === 0) return res.status(404).json({ message: 'Não encontrado.' });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar:', error);
        res.status(500).json({ error: 'Erro ao deletar' });
    }
};

// --- GET Histórico ---
const getEmployeeHistory = async (req, res) => {
    const { id } = req.params;
    try {
        const [rhEvents] = await db.execute(
            "SELECT * FROM employee_events_history WHERE employeeId = ? ORDER BY eventDate DESC", [id]
        );
        const [obraHistory] = await db.execute(
            "SELECT * FROM obras_historico_veiculos WHERE employeeId = ? ORDER BY dataEntrada DESC", [id]
        );

        const unifiedHistory = [];
        rhEvents.forEach(event => {
            unifiedHistory.push({
                type: 'rh',
                eventType: event.eventType,
                date: event.eventDate,
                description: event.eventType === 'desligamento' ? 'Desligamento' : 'Admissão/Readmissão',
                notes: event.notes
            });
        });

        const [obras] = await db.execute("SELECT id, nome FROM obras");
        const obrasMap = obras.reduce((acc, o) => ({...acc, [o.id]: o.nome}), {});

        obraHistory.forEach(h => {
            unifiedHistory.push({
                type: 'obra',
                obraName: obrasMap[h.obraId] || 'Obra Desconhecida',
                vehicle: h.registroInterno ? `${h.registroInterno} (${h.modelo})` : 'N/A',
                dateStart: h.dataEntrada,
                dateEnd: h.dataSaida,
                date: h.dataEntrada 
            });
        });

        unifiedHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(unifiedHistory);
    } catch (error) {
        console.error(`Erro ao buscar histórico:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
};

// --- PUT: Atualizar Status (Rota Especializada e Blindada) ---
const updateEmployeeStatus = async (req, res) => {
    const { id } = req.params;
    
    const body = req.body || {}; // Garante que body é um objeto
    let { status, date } = body;

    // --- DEBUG LOGGING: Adicionado para ajudar o usuário a depurar o ambiente ---
    console.log(`[DEBUG] Tentativa de atualização de status para ID: ${id}`);
    console.log(`[DEBUG] Corpo (Body) da Requisição recebido:`, body);
    console.log(`[DEBUG] Status extraído: ${status}, Data extraída: ${date}`);
    // --- FIM DEBUG LOGGING ---

    // Validação básica: Verifica se as propriedades existem no body
    if (!body.status || !body.date) {
        // Retorna o erro 400, mas com a mensagem exata do que faltou
        let missingFields = [];
        if (!body.status) missingFields.push('status');
        if (!body.date) missingFields.push('date');
        
        console.error(`[ERRO CRÍTICO] Campos obrigatórios faltando: ${missingFields.join(', ')}`);
        return res.status(400).json({ message: `Status e Data são obrigatórios. Campos faltantes no Body: ${missingFields.join(', ')}` });
    }

    // A partir daqui, as variáveis status e date são usadas
    
    // *** LIMPEZA CRÍTICA DE DADOS ***
    // Se o frontend enviar um objeto {status: "...", date: "..."} DENTRO da variável status,
    // ou uma string JSON, nós detectamos e limpamos aqui.
    if (typeof status === 'object') {
        status = status.status || 'ativo';
    } else if (typeof status === 'string' && status.includes('{')) {
        try {
            const parsed = JSON.parse(status);
            status = parsed.status || 'ativo';
        } catch (e) {
            console.warn("Recebido status corrompido que não pôde ser parseado. Forçando 'ativo'.", status);
            status = 'ativo'; // Fallback de segurança
        }
    }

    // Normalização
    status = status.toLowerCase();
    // Garante que só entra 'ativo' ou 'inativo' no banco
    if (status !== 'ativo' && status !== 'inativo') {
         // Se vier algo estranho, tenta deduzir ou usa padrão
         status = 'ativo';
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        let queryEmployee = '';
        let paramsEmployee = [];
        let eventType = '';
        let notes = '';

        if (status === 'ativo') {
            // ATIVAR: Atualiza status, dataAdmissao E dataContratacao, e limpa dataDesligamento
            queryEmployee = 'UPDATE employees SET status = ?, dataAdmissao = ?, dataContratacao = ?, dataDesligamento = NULL WHERE id = ?';
            paramsEmployee = ['ativo', date, date, id]; 
            eventType = 'readmissao';
            notes = 'Funcionário reativado/readmitido via Sistema.';
        } else {
            // INATIVAR: Atualiza status e dataDesligamento. Mantém admissão antiga.
            queryEmployee = 'UPDATE employees SET status = ?, dataDesligamento = ? WHERE id = ?';
            paramsEmployee = ['inativo', date, id];
            eventType = 'desligamento';
            notes = 'Funcionário desligado/inativado via Sistema.';
        }

        // 1. Executa a Query Principal
        const [result] = await connection.execute(queryEmployee, paramsEmployee);
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Funcionário não encontrado.' });
        }

        // 2. Grava no Histórico de Eventos
        const eventId = uuidv4();
        await connection.execute(
            `INSERT INTO employee_events_history (id, employeeId, eventType, eventDate, notes) VALUES (?, ?, ?, ?, ?)`,
            [eventId, id, eventType, date, notes]
        );

        await connection.commit();
        res.json({ message: `Status atualizado para ${status} com sucesso.` });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllEmployees,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    getEmployeeHistory,
    updateEmployeeStatus
};