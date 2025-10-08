const express = require('express');
const router = express.Router();
const db = require('../database'); // Conexão com o banco de dados

// ====================================================================
// ROTA: GET /api/users/profile
// OBJETIVO: Buscar os detalhes do usuário logado usando o token JWT.
// PROTEGIDA: Sim (requer token válido)
// ====================================================================
router.get('/profile', async (req, res) => {
    // O middleware de autenticação (authMiddleware) já validou o token
    // e adicionou os dados do usuário (como o ID) no objeto 'req.user'.
    const userId = req.user.id; 

    if (!userId) {
        return res.status(400).json({ message: 'ID do usuário não encontrado no token.' });
    }

    try {
        // Busca o usuário no banco de dados pelo ID extraído do token
        const [rows] = await db.query('SELECT id, name, email, role FROM users WHERE id = ?', [userId]);
        
        const user = rows[0];

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // O frontend (AuthContext) espera um campo 'uid'.
        // Renomeamos 'id' para 'uid' na resposta para manter a compatibilidade.
        const userProfile = {
            uid: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        };

        res.json(userProfile);

    } catch (error) {
        console.error('Erro ao buscar perfil do usuário:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

module.exports = router;
