// controllers/adminController.js
const db = require('../database');
const bcrypt = require('bcryptjs');

// --- Função Auxiliar para Conversar com o Banco de Dados ---
const parseAdminJsonFields = (data) => {
    if (!data) return null;
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.parse(data.ultimaAlteracao);
    return data;
};

// --- ROTA: Buscar a lista de solicitações de cadastro ---
const getRegistrationRequests = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM registration_requests ORDER BY requestedAt DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar solicitações de cadastro:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações de cadastro' });
    }
};

// --- ROTA: Aprovar uma solicitação e criar o usuário ---
const approveRegistrationRequest = async (req, res) => {
    const { requestId, role, password } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [requestRows] = await connection.execute('SELECT * FROM registration_requests WHERE id = ? FOR UPDATE', [requestId]);
        const request = requestRows[0];
        if (!request) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitação não encontrada.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await connection.execute('INSERT INTO users (email, role, password) VALUES (?, ?, ?)', [
            request.email,
            role || 'operador', // Define 'operador' como padrão se não for especificado
            hashedPassword
        ]);

        await connection.execute('DELETE FROM registration_requests WHERE id = ?', [requestId]);

        await connection.commit();
        res.status(200).json({ message: 'Solicitação aprovada e usuário criado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao aprovar solicitação:', error);
        res.status(500).json({ error: 'Erro ao aprovar solicitação.' });
    } finally {
        connection.release();
    }
};

// --- ROTA: Rejeitar uma solicitação ---
const deleteRegistrationRequest = async (req, res) => {
    try {
        await db.execute('DELETE FROM registration_requests WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao rejeitar solicitação:', error);
        res.status(500).json({ error: 'Erro ao rejeitar solicitação.' });
    }
};

// --- ROTA: Atribuir um papel a um usuário existente ---
const assignRole = async (req, res) => {
    const { email, role } = req.body;
    try {
        await db.execute('UPDATE users SET role = ? WHERE email = ?', [role, email]);
        res.status(200).json({ message: `Papel de ${role} atribuído com sucesso ao usuário ${email}.` });
    } catch (error) {
        console.error('Erro ao atribuir papel:', error);
        res.status(500).json({ error: 'Erro ao atribuir papel.' });
    }
};

// --- ROTA: Obter a mensagem de atualização do sistema ---
const getUpdateMessage = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM updates LIMIT 1');
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Nenhuma mensagem de atualização encontrada.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao obter mensagem de atualização:', error);
        res.status(500).json({ error: 'Erro ao obter mensagem de atualização.' });
    }
};

// --- ROTA: Salvar a mensagem de atualização do sistema ---
const saveUpdateMessage = async (req, res) => {
    const { message, showPopup } = req.body;
    try {
        await db.execute('INSERT INTO updates (message, showPopup, timestamp) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE message = ?, showPopup = ?, timestamp = ?',
            [message, showPopup, new Date(), message, showPopup, new Date()]);
        res.status(200).json({ message: 'Mensagem de atualização salva com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar mensagem de atualização:', error);
        res.status(500).json({ error: 'Erro ao salvar mensagem de atualização.' });
    }
};


module.exports = {
    getRegistrationRequests,
    approveRegistrationRequest,
    deleteRegistrationRequest,
    assignRole,
    getUpdateMessage,
    saveUpdateMessage
};