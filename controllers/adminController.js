const db = require('../database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// --- Buscar solicitações (Usuários Inativos) ---
const getRegistrationRequests = async (req, res) => {
    try {
        // Busca usuários onde status ou user_status seja 'inativo'
        const [rows] = await db.execute(`
            SELECT id, name, email, created_at 
            FROM users 
            WHERE status = 'inativo' OR user_status = 'inativo' 
            ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar solicitações:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações' });
    }
};

// --- Aprovar solicitação (Ativar usuário e Definir Permissões) ---
const approveRegistrationRequest = async (req, res) => {
    const { userId, role, canAccessRefueling } = req.body;

    if (!userId) return res.status(400).json({ error: "ID do usuário obrigatório" });

    try {
        // Atualiza status, role (e user_type para compatibilidade) e permissão de abastecimento
        // REGRA: Se 'role' não for especificado, define como 'operador' por padrão
        await db.execute(
            `UPDATE users 
             SET status = 'ativo', 
                 user_status = 'ativo', 
                 role = ?, 
                 user_type = ?,
                 canAccessRefueling = ? 
             WHERE id = ?`,
            [role || 'operador', role || 'operador', canAccessRefueling ? 1 : 0, userId]
        );

        res.status(200).json({ message: 'Usuário aprovado e ativado com sucesso.' });
    } catch (error) {
        console.error('Erro ao aprovar usuário:', error);
        res.status(500).json({ error: 'Erro ao aprovar usuário.' });
    }
};

// --- Rejeitar solicitação (Deletar usuário inativo) ---
const deleteRegistrationRequest = async (req, res) => {
    const { id } = req.params;
    try {
        // Segurança: Só deleta se estiver inativo
        await db.execute(
            "DELETE FROM users WHERE id = ? AND (status = 'inativo' OR user_status = 'inativo')", 
            [id]
        );
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao rejeitar solicitação:', error);
        res.status(500).json({ error: 'Erro ao rejeitar solicitação.' });
    }
};

// --- Atribuir Papel (Para usuários já ativos) ---
const assignRole = async (req, res) => {
    const { email, role, canAccessRefueling } = req.body;
    try {
        await db.execute(
            'UPDATE users SET role = ?, user_type = ?, canAccessRefueling = ? WHERE email = ?', 
            [role, role, canAccessRefueling ? 1 : 0, email]
        );
        res.status(200).json({ message: `Permissões atualizadas para ${email}.` });
    } catch (error) {
        console.error('Erro ao atribuir papel:', error);
        res.status(500).json({ error: 'Erro ao atribuir papel.' });
    }
};

// --- Mensagens de Atualização ---
const getUpdateMessage = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM updates ORDER BY timestamp DESC LIMIT 1');
        if (rows.length === 0) return res.json({ message: '', showPopup: false });
        res.json(rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Erro update msg'});
    }
};

const saveUpdateMessage = async (req, res) => {
    const { message, showPopup } = req.body;
    try {
        await db.execute('INSERT INTO updates (message, showPopup, timestamp) VALUES (?, ?, ?)', 
            [message, showPopup, new Date()]);
        res.status(200).json({ message: 'Atualizado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Erro salvar msg'});
    }
};

// --- Migração de Funcionários (Para usuários) ---
const adminMigrateUsers = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        // 1. Busca funcionários ativos que ainda NÃO possuem usuário vinculado (userId IS NULL)
        const [employeesToMigrate] = await connection.execute(
            "SELECT id, nome, registroInterno FROM employees WHERE status = 'ativo' AND userId IS NULL"
        );

        let migratedCount = 0;
        for (const employee of employeesToMigrate) {
            // Ignora funcionários sem registro interno (pois é necessário para o email)
            if (!employee.registroInterno) {
                console.warn(`Funcionário ${employee.nome} (ID: ${employee.id}) pulado: Sem Registro Interno.`);
                continue;
            }

            const newUserId = uuidv4();
            
            // REGRA: Senha padrão definida estritamente como "mak123"
            const defaultPassword = 'mak123'; 
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            
            // REGRA: Login automático baseado no registro interno
            const email = `${employee.registroInterno.toLowerCase()}@frotasmak.com.br`;

            // Cria o usuário já como ATIVO e com perfil de OPERADOR
            await connection.execute(
                `INSERT INTO users (id, email, password, role, user_type, status, user_status, employeeId, name, canAccessRefueling) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [newUserId, email, hashedPassword, 'operador', 'operador', 'ativo', 'ativo', employee.id, employee.nome, 0]
            );

            // Vincula o novo usuário ao funcionário existente
            await connection.execute(`UPDATE employees SET userId = ? WHERE id = ?`, [newUserId, employee.id]);
            migratedCount++;
        }
        await connection.commit();
        res.status(200).json({ message: `Migração: ${migratedCount} usuários criados.` });
    } catch (error) {
        await connection.rollback();
        console.error('Erro migração:', error);
        // Tratamento específico para duplicidade de email
        if (error.code === 'ER_DUP_ENTRY') {
             return res.status(409).json({ error: 'Conflito: Alguns emails gerados já existem no sistema. Verifique os Registros Internos.' });
        }
        res.status(500).json({ error: 'Erro na migração.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getRegistrationRequests,
    approveRegistrationRequest,
    deleteRegistrationRequest,
    assignRole,
    getUpdateMessage,
    saveUpdateMessage,
    adminMigrateUsers
};