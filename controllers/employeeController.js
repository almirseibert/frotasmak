const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ===================================================================================
// FUNÇÕES AUXILIARES
// ===================================================================================

const parseJsonSafe = (field) => {
    if (!field) return null;
    if (typeof field === 'object') return field;
    try {
        return JSON.parse(field);
    } catch (e) {
        return field;
    }
};

const cleanCpf = (cpf) => cpf ? cpf.replace(/\D/g, '') : '';

// ===================================================================================
// CONTROLLERS
// ===================================================================================

// --- LISTAR TODOS ---
const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees ORDER BY nome ASC');
        
        const cleanRows = rows.map(emp => {
            // Tratamento para status que venha como JSON incorreto
            let statusLimpo = emp.status;
            if (statusLimpo && typeof statusLimpo === 'string' && statusLimpo.includes('{')) {
                try { statusLimpo = JSON.parse(statusLimpo).status || 'ativo'; } catch(e) { statusLimpo = 'ativo'; }
            }

            return {
                ...emp,
                status: statusLimpo || 'ativo',
                aso: parseJsonSafe(emp.aso),
                epi: parseJsonSafe(emp.epi),
                cnh: parseJsonSafe(emp.cnh) || { 
                    numero: emp.cnhNumero,
                    categoria: emp.cnhCategoria,
                    validade: emp.cnhVencimento
                },
                certificados: parseJsonSafe(emp.certificados) || []
            };
        });

        res.json(cleanRows);
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// --- BUSCAR POR ID ---
const getEmployeeById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado' });
        
        const emp = rows[0];
        res.json({
            ...emp,
            aso: parseJsonSafe(emp.aso),
            epi: parseJsonSafe(emp.epi),
            cnh: parseJsonSafe(emp.cnh) || { 
                numero: emp.cnhNumero, 
                categoria: emp.cnhCategoria, 
                validade: emp.cnhVencimento 
            },
            certificados: parseJsonSafe(emp.certificados)
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar funcionário.' });
    }
};

// --- CRIAR FUNCIONÁRIO ---
const createEmployee = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const newId = uuidv4();
        
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        // CNH Híbrida: Salva no JSON e nas colunas antigas
        const cnhObj = data.cnh || {};
        const cnhJson = JSON.stringify(cnhObj);
        const cnhNumero = data.cnhNumero || cnhObj.numero || null;
        const cnhCategoria = data.cnhCategoria || cnhObj.categoria || null;
        const cnhVencimento = data.cnhVencimento || cnhObj.validade || null;

        const status = 'ativo';

        await connection.execute(
            `INSERT INTO employees (
                id, nome, vulgo, registroInterno, cpf, rg, dataNascimento, funcao, telefone, contato, email, 
                endereco, cidade, dataAdmissao, dataContratacao, status, 
                cnhNumero, cnhCategoria, cnhVencimento,
                aso, epi, cnh, certificados
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                newId, data.nome, data.vulgo, data.registroInterno, data.cpf, data.rg, data.dataNascimento, data.funcao, data.telefone, data.contato, data.email,
                data.endereco, data.cidade, data.dataAdmissao, data.dataAdmissao, status,
                cnhNumero, cnhCategoria, cnhVencimento,
                aso, epi, cnhJson, certificados
            ]
        );

        // Cria usuário automaticamente
        const cpfLimpo = cleanCpf(data.cpf);
        if (cpfLimpo) {
            const userEmail = `${cpfLimpo}@frotamak.com`;
            const userPassword = cpfLimpo; 
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(userPassword, salt);
            const newUserId = uuidv4();

            const [existingUsers] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
            
            if (existingUsers.length === 0) {
                await connection.execute(
                    `INSERT INTO users (
                        id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [newUserId, data.nome, userEmail, hashedPassword, 'user', 'user', 'ativo', 1, newId]
                );
            }
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['employees'] });
        res.status(201).json({ message: 'Funcionário criado com sucesso.', id: newId });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE employee:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- ATUALIZAR FUNCIONÁRIO ---
const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        const cnhObj = data.cnh || {};
        const cnhJson = JSON.stringify(cnhObj);
        const cnhNumero = data.cnhNumero || cnhObj.numero || null;
        const cnhCategoria = data.cnhCategoria || cnhObj.categoria || null;
        const cnhVencimento = data.cnhVencimento || cnhObj.validade || null;

        let statusUpdateClause = "";
        let params = [
            data.nome, data.vulgo, data.registroInterno, data.cpf, data.rg, data.dataNascimento, data.funcao, 
            data.telefone, data.contato, data.email, data.endereco, data.cidade, 
            data.dataAdmissao, 
            cnhNumero, cnhCategoria, cnhVencimento,
            aso, epi, cnhJson, certificados, data.dataDesligamento || null
        ];

        // Atualiza status apenas se vier uma string limpa
        if (data.status && typeof data.status === 'string' && !data.status.includes('{')) {
             statusUpdateClause = ", status = ?";
             params.push(data.status);
        }

        params.push(id);

        await connection.execute(
            `UPDATE employees SET 
                nome=?, vulgo=?, registroInterno=?, cpf=?, rg=?, dataNascimento=?, funcao=?, 
                telefone=?, contato=?, email=?, endereco=?, cidade=?, 
                dataAdmissao=?, 
                cnhNumero=?, cnhCategoria=?, cnhVencimento=?,
                aso=?, epi=?, cnh=?, certificados=?, dataDesligamento=?
                ${statusUpdateClause}
             WHERE id=?`,
            params
        );

        if (data.status === 'inativo') {
            await connection.execute(
                `UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`,
                [id]
            );
        }

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
        await db.execute('DELETE FROM users WHERE employeeId = ?', [id]);
        req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Funcionário excluído.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir funcionário.' });
    }
};

// --- HISTÓRICO COMPLETO (Corrigido para incluir alocadoEm e eventos) ---
const getEmployeeHistory = async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Busca eventos de RH (Admissão/Desligamento) - Tabela employee_events_history
        const [rhEvents] = await db.execute(
            "SELECT * FROM employee_events_history WHERE employeeId = ? ORDER BY eventDate DESC", [id]
        );

        // 2. Busca histórico de Obras - Tabela obras_historico_veiculos
        const [obraHistory] = await db.execute(
            `SELECT h.*, o.nome as obraNome 
             FROM obras_historico_veiculos h
             LEFT JOIN obras o ON h.obraId = o.id
             WHERE h.employeeId = ? 
             ORDER BY h.dataEntrada DESC`, [id]
        );

        // 3. Busca histórico de Alocação em Veículos (Tabela Nova)
        const [operationalHistory] = await db.execute(
            `SELECT a.*, v.placa, v.modelo, v.registroInterno 
             FROM vehicle_operational_assignment a
             LEFT JOIN vehicles v ON a.vehicleId = v.id
             WHERE a.employeeId = ?
             ORDER BY a.startDate DESC`,
            [id]
        );

        // 4. Busca Alocação Manual Legada (coluna alocadoEm)
        const [employeeData] = await db.execute("SELECT alocadoEm, nome FROM employees WHERE id = ?", [id]);
        let legacyAllocation = null;
        if (employeeData.length > 0 && employeeData[0].alocadoEm) {
            legacyAllocation = {
                type: 'legado',
                description: `Alocação Fixa/Manual: ${employeeData[0].alocadoEm}`,
                date: new Date().toISOString() // Data atual apenas para referência
            };
        }

        // Formata para o padrão unificado
        const unifiedHistory = {
            rh: rhEvents.map(e => ({
                type: 'rh',
                date: e.eventDate,
                description: e.eventType === 'desligamento' ? 'Desligamento' : (e.eventType === 'readmissao' ? 'Readmissão' : 'Evento RH'),
                notes: e.notes
            })),
            obras: obraHistory.map(h => ({
                type: 'obra',
                obraNome: h.obraNome || 'Obra Desconhecida',
                role: h.tipo || 'Alocação',
                startDate: h.dataEntrada,
                endDate: h.dataSaida
            })),
            veiculos: operationalHistory.map(h => ({
                type: 'veiculo',
                modelo: h.modelo,
                placa: h.placa,
                registroInterno: h.registroInterno,
                assignedAt: h.startDate,
                subGroup: h.subGroup
            })),
            outros: legacyAllocation ? [legacyAllocation] : []
        };

        res.json(unifiedHistory);
    } catch (error) {
        console.error("Erro histórico funcionário:", error);
        res.status(500).json({ error: "Erro ao buscar histórico completo." });
    }
};

// --- ATUALIZAR STATUS ---
const updateEmployeeStatus = async (req, res) => {
    const { id } = req.params;
    const { status, date } = req.body;
    
    if (!status || !date) return res.status(400).json({ message: "Status e Data obrigatórios." });

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
            notes = 'Funcionário readmitido via Sistema.';
        } else {
            queryEmployee = 'UPDATE employees SET status = ?, dataDesligamento = ? WHERE id = ?';
            paramsEmployee = ['inativo', date, id];
            eventType = 'desligamento';
            notes = 'Funcionário desligado via Sistema.';
        }

        await connection.execute(queryEmployee, paramsEmployee);

        const eventId = uuidv4();
        await connection.execute(
            `INSERT INTO employee_events_history (id, employeeId, eventType, eventDate, notes) VALUES (?, ?, ?, ?, ?)`,
            [eventId, id, eventType, date, notes]
        );

        if (status === 'inativo') {
            await connection.execute(
                `UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`,
                [id]
            );
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: `Status atualizado para ${status}.` });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status.' });
    } finally {
        connection.release();
    }
};

const syncActiveEmployeesToUsers = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [employees] = await connection.query("SELECT * FROM employees WHERE status = 'ativo'");
        let count = 0;
        for (const emp of employees) {
            const cpfLimpo = cleanCpf(emp.cpf);
            if (!cpfLimpo) continue;
            const userEmail = `${cpfLimpo}@frotamak.com`;
            const [exists] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
            if (exists.length === 0) {
                const newUserId = uuidv4();
                const hash = await bcrypt.hash(cpfLimpo, 10);
                await connection.execute(
                    `INSERT INTO users (id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao) 
                     VALUES (?, ?, ?, ?, 'user', 'user', 'ativo', 1, ?, NOW())`,
                    [newUserId, emp.nome, userEmail, hash, emp.id]
                );
                count++;
            }
        }
        await connection.commit();
        res.json({ message: `Sincronização concluída. ${count} usuários criados.` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
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
    syncActiveEmployeesToUsers
};