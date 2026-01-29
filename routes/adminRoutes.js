// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');
const db = require('../database'); // Necessário para as novas rotas inline

router.use(authMiddleware);

// Middleware local para garantir privilégios de admin nas rotas inline abaixo
const adminOnly = (req, res, next) => {
    if (req.user.user_type !== 'admin') {
        return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    next();
};

// --- ROTAS EXISTENTES (Mantidas via Controller) ---

// Rotas de gerenciamento de solicitações de cadastro
router.get('/registration-requests', adminController.getRegistrationRequests);
router.post('/registration-requests/approve', adminController.approveRegistrationRequest);
router.delete('/registration-requests/:id', adminController.deleteRegistrationRequest);

// Rotas de atribuição de papéis
router.put('/assign-role', adminController.assignRole);

// Rotas de mensagem de atualização
router.get('/update-message', adminController.getUpdateMessage);
router.put('/update-message', adminController.saveUpdateMessage);

// Rota para migrar funcionários existentes para usuários
router.post('/migrate-users', adminController.adminMigrateUsers);


// --- NOVAS ROTAS (Funcionalidades Adicionais para Gestão de Usuários e Abastecimento) ---

// 1. Listar Todos os Usuários (Para tabela de gestão)
router.get('/users', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT id, name, email, role, user_type, status, 
                   canAccessRefueling, bloqueado_abastecimento, tentativas_falhas_abastecimento 
            FROM users
            ORDER BY name ASC
        `);
        res.json(rows);
    } catch (error) {
        console.error("Erro ao listar usuários:", error);
        res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

// 2. Atualizar Usuário (Permissões, nome, email)
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
        console.error("Erro ao atualizar usuário:", error);
        res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// 3. Excluir Usuário
router.delete('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Não é possível excluir a si mesmo.' });
        }
        await db.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'Usuário excluído.' });
    } catch (error) {
        console.error("Erro ao excluir usuário:", error);
        res.status(500).json({ error: 'Erro ao excluir usuário.' });
    }
});

// 4. DESBLOQUEAR MOTORISTA (Resetar tentativas de abastecimento)
// Esta rota é chamada quando o Admin clica em "Desbloquear" na tela de gestão
router.put('/users/:id/unlock', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query(
            'UPDATE users SET bloqueado_abastecimento = 0, tentativas_falhas_abastecimento = 0 WHERE id = ?',
            [id]
        );
        res.json({ message: 'Usuário desbloqueado para solicitações de abastecimento.' });
    } catch (error) {
        console.error("Erro ao desbloquear usuário:", error);
        res.status(500).json({ error: 'Erro ao desbloquear usuário.' });
    }
});

module.exports = router;