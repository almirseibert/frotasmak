// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');
const db = require('../database'); // <--- IMPORTANTE: Adiciona a conexão com o DB

// --- ROTAS PÚBLICAS ---
// Estas rotas NÃO usam o authMiddleware globalmente.

// POST /api/auth/login
// Rota pública para autenticar e obter um token.
router.post('/login', authController.login);

// POST /api/auth/register
// Rota pública para registrar um novo usuário (se aplicável).
router.post('/register', authController.register);


// --- ROTAS PROTEGIDAS ---
// Estas rotas SÃO protegidas pelo authMiddleware.

// POST /api/auth/validate-password
// Rota protegida para validar a senha do usuário logado.
router.post('/validate-password', authMiddleware, authController.validatePassword);

// GET /api/auth/me 
// Rota protegida para buscar os dados do usuário com base no token.
// O apiClient.js chama esta rota, então ela é essencial.
//
// ====================================================================
// ESTA É A ROTA CORRIGIDA
// ====================================================================
router.get('/me', authMiddleware, async (req, res) => {
    // authMiddleware já decodificou o token e colocou em req.user (que tem o ID)
    const userId = req.user.id; 

    if (!userId) {
        return res.status(401).json({ error: 'Token inválido, ID do usuário não encontrado.' });
    }

    try {
        // Busca o usuário COMPLETO no banco de dados
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado no banco de dados.' });
        }

        // Remove a senha antes de enviar a resposta
        delete user.password; 

        // Converte os valores TINYINT(1) para booleanos, como o frontend espera
        const userProfile = {
            ...user,
            canAccessRefueling: user.canAccessRefueling === 1,
            // Adicione outras conversões de 0/1 para booleano se necessário
        };

        // Envia o perfil completo
        res.json(userProfile);

    } catch (error) {
        console.error('Erro ao buscar dados do usuário na rota /me:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});


module.exports = router;

