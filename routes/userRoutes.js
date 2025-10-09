const express = require('express');
const router = express.Router();
const db = require('../database');
const authMiddleware = require('../middlewares/authMiddleware');

/**
 * Rota GET /api/users/profile
 * Rota protegida para obter os dados do perfil do utilizador.
 */
router.get('/profile', authMiddleware, async (req, res) => {
    // O token JWT contém `id` (o ID do utilizador no banco de dados).
    const userId = req.user.id; 
    
    if (!userId) {
        return res.status(401).json({ message: 'Token de autenticação inválido ou faltando dados.' });
    }

    try {
        // --- CÓDIGO CORRIGIDO ---
        // A consulta foi alterada para buscar 'canAccessRefueling' da tabela 'users' (u)
        // e o LEFT JOIN com a tabela 'employees' foi removido por ser desnecessário aqui.
        const [rows] = await db.query(
            `SELECT 
                u.id, 
                u.email, 
                u.role, 
                u.name, 
                u.phone,
                u.canAccessRefueling
            FROM users u
            WHERE u.id = ?`, 
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Perfil do utilizador não encontrado.' });
        }

        const userProfile = rows[0];

        // Converte o valor do DB (0 ou 1) para o booleano esperado pelo frontend
        res.json({
            ...userProfile,
            canAccessRefueling: userProfile.canAccessRefueling === 1,
        });

    } catch (error) {
        console.error('Erro ao buscar perfil do utilizador:', error);
        res.status(500).json({ message: 'Erro interno do servidor ao buscar o perfil.' });
    }
});

module.exports = router;
