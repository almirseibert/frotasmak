// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');
const db = require('../database');
const whatsappService = require('../services/whatsappService');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

router.use(authMiddleware);

const adminOnly = (req, res, next) => {
    if (req.user.user_type !== 'admin') {
        return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    next();
};

// ─── INICIALIZAÇÃO DAS TABELAS ADMIN ─────────────────────────────────────────
const initAdminTables = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS access_groups (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description VARCHAR(255) NULL,
                modules JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                value LONGTEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS message_templates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_holidays (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                date DATE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                module VARCHAR(50) NOT NULL,
                frequency VARCHAR(20) NOT NULL DEFAULT 'weekly',
                time VARCHAR(10) NOT NULL DEFAULT '08:00',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Adicionar group_id na tabela users se não existir
        try {
            const [cols] = await db.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'group_id'`
            );
            if (cols.length === 0) {
                await db.query(`ALTER TABLE users ADD COLUMN group_id VARCHAR(36) NULL`);
                console.log('✅ Coluna group_id adicionada à tabela users.');
            }
        } catch (colErr) {
            console.warn('⚠️ Não foi possível adicionar group_id:', colErr.message);
        }
        console.log('✅ Tabelas admin inicializadas com sucesso.');
    } catch (err) {
        console.warn('⚠️ Erro ao inicializar tabelas admin:', err.message);
    }
};

initAdminTables();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const getSetting = async (key, defaultValue = null) => {
    const [rows] = await db.query('SELECT value FROM admin_settings WHERE setting_key = ?', [key]);
    if (rows.length === 0) return defaultValue;
    try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
};

const saveSetting = async (key, value) => {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    await db.query(
        'INSERT INTO admin_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
        [key, json, json]
    );
};

// ─── ROTAS EXISTENTES (via Controller) ────────────────────────────────────────
router.get('/registration-requests', adminController.getRegistrationRequests);
router.post('/registration-requests/approve', adminController.approveRegistrationRequest);
router.delete('/registration-requests/:id', adminController.deleteRegistrationRequest);
router.put('/assign-role', adminController.assignRole);
router.get('/update-message', adminController.getUpdateMessage);
router.put('/update-message', adminController.saveUpdateMessage);
router.post('/migrate-users', adminController.adminMigrateUsers);

// ─── USUÁRIOS ─────────────────────────────────────────────────────────────────

// Listar todos os usuários
router.get('/users', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.name, u.email, u.role, u.user_type, u.status,
                   u.canAccessRefueling AS podeAcessarAbastecimento,
                   u.bloqueado_abastecimento, u.tentativas_falhas_abastecimento,
                   u.group_id, g.name AS group_name
            FROM users u
            LEFT JOIN access_groups g ON u.group_id = g.id
            ORDER BY u.name ASC
        `);
        res.json(rows.map(u => ({ ...u, podeAcessarAbastecimento: !!u.podeAcessarAbastecimento })));
    } catch (error) {
        console.error('Erro ao listar usuários:', error);
        res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

// Criar novo usuário
router.post('/users', adminOnly, async (req, res) => {
    const { name, email, password, user_type, group_id, podeAcessarAbastecimento, canAccessRefueling } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    const canRefuel = !!(podeAcessarAbastecimento || canAccessRefueling);
    try {
        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(409).json({ error: 'E-mail já cadastrado.' });

        const id = uuidv4();
        const hashed = await bcrypt.hash(password, 10);
        const role = user_type || 'viewer';

        await db.query(
            `INSERT INTO users (id, name, email, password, role, user_type, status, canAccessRefueling, group_id, data_criacao)
             VALUES (?, ?, ?, ?, ?, ?, 'ativo', ?, ?, NOW())`,
            [id, name, email, hashed, role, role, canRefuel ? 1 : 0, group_id || null]
        );
        res.status(201).json({ id, message: 'Usuário criado com sucesso.' });
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        res.status(500).json({ error: 'Erro ao criar usuário.' });
    }
});

// Atualizar usuário (PATCH — usado pelo UserEditModal)
router.patch('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, email, password, user_type, group_id, podeAcessarAbastecimento, canAccessRefueling, active } = req.body;
    const canRefuel = podeAcessarAbastecimento !== undefined ? podeAcessarAbastecimento
                    : canAccessRefueling !== undefined ? canAccessRefueling : undefined;
    try {
        const sets = [];
        const params = [];

        if (name !== undefined)     { sets.push('name = ?');               params.push(name); }
        if (email !== undefined)    { sets.push('email = ?');              params.push(email); }
        if (user_type !== undefined){ sets.push('role = ?, user_type = ?');params.push(user_type, user_type); }
        if (group_id !== undefined) { sets.push('group_id = ?');           params.push(group_id || null); }
        if (canRefuel !== undefined){ sets.push('canAccessRefueling = ?'); params.push(canRefuel ? 1 : 0); }
        if (active !== undefined)   { sets.push('status = ?');             params.push(active ? 'ativo' : 'inativo'); }
        if (password) {
            const hashed = await bcrypt.hash(password, 10);
            sets.push('password = ?');
            params.push(hashed);
        }

        if (sets.length === 0) return res.json({ message: 'Nada para atualizar.' });

        params.push(id);
        await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// Toggle status ativo / inativo
router.patch('/users/:id/status', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT status FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        const newStatus = rows[0].status === 'ativo' ? 'inativo' : 'ativo';
        await db.query('UPDATE users SET status = ? WHERE id = ?', [newStatus, id]);
        res.json({ status: newStatus, message: `Usuário ${newStatus}.` });
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.status(500).json({ error: 'Erro ao alterar status do usuário.' });
    }
});

// Reset de senha (gera senha temporária)
router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashed = await bcrypt.hash(tempPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, id]);
        res.json({ message: 'Senha redefinida com sucesso.', temporaryPassword: tempPassword });
    } catch (error) {
        console.error('Erro ao resetar senha:', error);
        res.status(500).json({ error: 'Erro ao redefinir senha.' });
    }
});

// Atualizar usuário (PUT — compatibilidade com rota legada)
router.put('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, email, role, user_type, canAccessRefueling } = req.body;
    try {
        await db.query(
            'UPDATE users SET name = ?, email = ?, role = ?, user_type = ?, canAccessRefueling = ? WHERE id = ?',
            [name, email, role, user_type, canAccessRefueling ? 1 : 0, id]
        );
        res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// Excluir usuário
router.delete('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        if (id === String(req.user.id)) {
            return res.status(400).json({ error: 'Não é possível excluir a si mesmo.' });
        }
        await db.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'Usuário excluído.' });
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        res.status(500).json({ error: 'Erro ao excluir usuário.' });
    }
});

// Desbloquear usuário (abastecimento)
router.put('/users/:id/unlock', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query(
            'UPDATE users SET bloqueado_abastecimento = 0, tentativas_falhas_abastecimento = 0 WHERE id = ?',
            [id]
        );
        res.json({ message: 'Usuário desbloqueado para solicitações de abastecimento.' });
    } catch (error) {
        console.error('Erro ao desbloquear usuário:', error);
        res.status(500).json({ error: 'Erro ao desbloquear usuário.' });
    }
});

// Rota temporária para teste de disparo
router.post('/teste-whatsapp', async (req, res) => {
    try {
        const numeroTeste = req.body.numero;
        const mensagem = '🚜 *Teste Frotas MAK (v2.0)* 🚜\n\nSe você recebeu esta mensagem, acabamos de dar mais um passo em direção à otimização, agora o sistema de Frotas MAK envia automáticamente mensagens pelo Whatsapp';
        const resultado = await whatsappService.enviarMensagem(numeroTeste, mensagem);
        res.status(200).json({ sucesso: true, mensagem: 'Comando de envio disparado!', detalhes: resultado });
    } catch (error) {
        console.error(error);
        res.status(500).json({ sucesso: false, erro: 'Falha na comunicação com a Evolution API.' });
    }
});

module.exports = router;
