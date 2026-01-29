const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs'); // Importação necessária para gerar senhas

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
    const cleanEmp = { ...employee };

    // Lista de campos que sabemos que são JSON no banco (ou podem ter sido corrompidos como string JSON)
    const jsonFields = ['aso', 'epi', 'cnh', 'certificados', 'historicoObras', 'historicoVeiculos'];

    jsonFields.forEach(field => {
        cleanEmp[field] = parseJsonSafe(cleanEmp[field], field);
    });

    // TRATAMENTO ESPECIAL PARA O CAMPO STATUS
    // Se o status vier como objeto (ex: {"status":"ativo"}), extraímos o valor
    if (typeof cleanEmp.status === 'object' && cleanEmp.status !== null && cleanEmp.status.status) {
        cleanEmp.status = cleanEmp.status.status;
    }
    // Normalização final de status string
    if (typeof cleanEmp.status === 'string') {
        cleanEmp.status = cleanEmp.status.toLowerCase().replace(/['"]/g, '');
    }

    return cleanEmp;
};

// ===================================================================================
// CONTROLLERS
// ===================================================================================

const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees ORDER BY nome ASC');
        const cleanRows = rows.map(parseEmployeeJsonFields);
        res.json(cleanRows);
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const getEmployeeById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado' });
        res.json(parseEmployeeJsonFields(rows[0]));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar funcionário.' });
    }
};

// Helper para limpar CPF (deixar apenas números)
const cleanCpf = (cpf) => {
    return cpf ? cpf.replace(/\D/g, '') : '';
};

// --- CRIAÇÃO DE FUNCIONÁRIO COM GERAÇÃO AUTOMÁTICA DE USUÁRIO ---
const createEmployee = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const newId = uuidv4();
        
        // Garante que campos JSON sejam strings válidas para o banco
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const cnh = JSON.stringify(data.cnh || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        // Status padrão na criação
        const status = 'ativo';

        await connection.execute(
            `INSERT INTO employees (
                id, nome, cpf, rg, dataNascimento, funcao, telefone, email, 
                endereco, dataAdmissao, status, 
                aso, epi, cnh, certificados
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                newId, data.nome, data.cpf, data.rg, data.dataNascimento, data.funcao, data.telefone, data.email,
                data.endereco, data.dataAdmissao, status,
                aso, epi, cnh, certificados
            ]
        );

        // --- LÓGICA DE CRIAÇÃO AUTOMÁTICA DE USUÁRIO ---
        const cpfLimpo = cleanCpf(data.cpf);
        if (cpfLimpo) {
            const userEmail = `${cpfLimpo}@frotamak.com`;
            const userPassword = cpfLimpo; // A senha é o CPF limpo
            
            // Hash da senha
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(userPassword, salt);
            
            const newUserId = uuidv4();

            // Verifica se já existe usuário com este email para evitar erro de duplicidade
            const [existingUsers] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
            
            if (existingUsers.length === 0) {
                await connection.execute(
                    `INSERT INTO users (
                        id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        newUserId, 
                        data.nome, 
                        userEmail, 
                        hashedPassword, 
                        'user', // Role padrão
                        'user', // Type padrão
                        'ativo', 
                        1, // Acesso ao abastecimento liberado por padrão (ajustar conforme regra de negócio)
                        newId // Vincula ao ID do funcionário criado
                    ]
                );
            }
        }
        // ---------------------------------------------------

        await connection.commit();
        req.io.emit('server:sync', { targets: ['employees'] });
        res.status(201).json({ message: 'Funcionário e Usuário criados com sucesso.', id: newId });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE employee:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const cnh = JSON.stringify(data.cnh || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        let status = data.status;
        if (typeof status === 'object' && status.status) status = status.status;

        await connection.execute(
            `UPDATE employees SET 
                nome=?, cpf=?, rg=?, dataNascimento=?, funcao=?, telefone=?, email=?, 
                endereco=?, dataAdmissao=?, status=?, 
                aso=?, epi=?, cnh=?, certificados=?, dataDesligamento=?
             WHERE id=?`,
            [
                data.nome, data.cpf, data.rg, data.dataNascimento, data.funcao, data.telefone, data.email,
                data.endereco, data.dataAdmissao, status,
                aso, epi, cnh, certificados, data.dataDesligamento || null,
                id
            ]
        );

        // --- LÓGICA DE INATIVAÇÃO DE USUÁRIO ---
        if (status === 'inativo' || status === 'Inativo') {
            // Se o funcionário for inativado, inativamos o usuário vinculado pelo employeeId OU pelo email gerado
            const cpfLimpo = cleanCpf(data.cpf);
            const userEmail = cpfLimpo ? `${cpfLimpo}@frotamak.com` : null;

            if (userEmail) {
                await connection.execute(
                    `UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE email = ? OR employeeId = ?`,
                    [userEmail, id]
                );
            } else {
                await connection.execute(
                    `UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`,
                    [id]
                );
            }
        }
        // ----------------------------------------

        await connection.commit();
        req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Funcionário atualizado.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE employee:', error);
        res.status(500).json({ error: 'Erro ao atualizar funcionário.' });
    } finally {
        connection.release();
    }
};

const deleteEmployee = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM employees WHERE id = ?', [id]);
        
        // Também deleta o usuário associado (opcional, mas recomendado para limpeza)
        await db.execute('DELETE FROM users WHERE employeeId = ?', [id]);

        req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Funcionário excluído.' });
    } catch (error) {
        console.error('Erro DELETE employee:', error);
        res.status(500).json({ error: 'Erro ao excluir funcionário.' });
    }
};

const getEmployeeHistory = async (req, res) => {
    const { id } = req.params;
    try {
        const [obraHistory] = await db.query(
            `SELECT h.*, o.nome as obraNome 
             FROM vehicle_history h 
             LEFT JOIN obras o ON h.obraId = o.id
             WHERE h.employeeId = ? 
             ORDER BY h.startDate DESC`, 
            [id]
        );

        const [operationalHistory] = await db.query(
            `SELECT a.*, v.placa, v.modelo 
             FROM vehicle_operational_assignment a
             LEFT JOIN vehicles v ON a.vehicleId = v.id
             WHERE a.employeeId = ?
             ORDER BY a.assignedAt DESC`,
            [id]
        );

        res.json({
            obras: obraHistory,
            veiculos: operationalHistory
        });
    } catch (error) {
        console.error("Erro histórico funcionário:", error);
        res.status(500).json({ error: "Erro ao buscar histórico." });
    }
};

const updateEmployeeStatus = async (req, res) => {
    const { id } = req.params;
    const { status, date } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        let queryEmployee = '';
        let paramsEmployee = [];
        let eventType = '';
        let notes = '';

        if (status === 'ativo') {
            queryEmployee = 'UPDATE employees SET status = ?, dataAdmissao = ?, dataDesligamento = NULL WHERE id = ?';
            paramsEmployee = ['ativo', date, id];
            eventType = 'readmissao';
            notes = 'Funcionário readmitido/reativado via Sistema.';
        } else {
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

        // --- LÓGICA DE INATIVAÇÃO DE USUÁRIO (Status Change) ---
        if (status === 'inativo') {
            await connection.execute(
                `UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`,
                [id]
            );
        }
        // -------------------------------------------------------

        await connection.commit();

        // SOCKET EMIT
        req.io.emit('server:sync', { targets: ['employees'] });

        res.json({ message: `Status atualizado para ${status} com sucesso.` });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status.' });
    } finally {
        connection.release();
    }
};

// --- NOVA FUNÇÃO: SINCRONIZAR (MIGRAR) FUNCIONÁRIOS PARA USUÁRIOS ---
const syncActiveEmployeesToUsers = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Buscar todos os funcionários ATIVOS
        // A query considera 'Ativo' ou 'ativo'
        const [employees] = await connection.query("SELECT * FROM employees WHERE status LIKE 'ativo' OR status LIKE 'Ativo'");
        
        let createdCount = 0;
        let updatedCount = 0;

        for (const emp of employees) {
            const cpfLimpo = cleanCpf(emp.cpf);
            if (!cpfLimpo) continue;

            const userEmail = `${cpfLimpo}@frotamak.com`;
            const userPassword = cpfLimpo;
            
            // Verifica se usuário já existe
            const [existingUsers] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);

            if (existingUsers.length === 0) {
                // CRIAR NOVO USUÁRIO
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(userPassword, salt);
                const newUserId = uuidv4();

                await connection.execute(
                    `INSERT INTO users (
                        id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        newUserId, 
                        emp.nome, 
                        userEmail, 
                        hashedPassword, 
                        'user', // Role
                        'user', // Type
                        'ativo', 
                        1, // Acesso Liberado
                        emp.id
                    ]
                );
                createdCount++;
            } else {
                // Se já existe, atualizamos para garantir que está vinculado e ativo (opcional, mas seguro)
                // Não resetamos a senha para não bloquear quem já trocou
                await connection.execute(
                    `UPDATE users SET status = 'ativo', employeeId = ? WHERE id = ?`,
                    [emp.id, existingUsers[0].id]
                );
                updatedCount++;
            }
        }

        await connection.commit();
        res.json({ 
            message: 'Sincronização concluída.', 
            details: `Criados: ${createdCount}, Atualizados/Verificados: ${updatedCount}` 
        });

    } catch (error) {
        await connection.rollback();
        console.error('Erro na migração de usuários:', error);
        res.status(500).json({ error: 'Erro ao migrar usuários.' });
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
    updateEmployeeStatus,
    syncActiveEmployeesToUsers // Exportando a nova função
};