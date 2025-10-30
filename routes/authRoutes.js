// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

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

// GET /api/auth/me (Exemplo de Rota "Get Me")
// Rota protegida para buscar os dados do usuário com base no token.
// O apiClient.js chama esta rota, então ela é essencial.
router.get('/me', authMiddleware, (req, res) => {
    // authMiddleware já decodificou o token e colocou em req.user
    // Aqui você buscaria os dados completos do usuário no DB
    // Esta é uma implementação SIMPLES, você DEVE ajustar
    if (req.user) {
        // Idealmente, busque no DB pelo req.user.id
        res.json({
            id: req.user.id,
            email: req.user.email,
            role: req.user.role,
            // Adicione outros dados do usuário aqui
        });
    } else {
        res.status(401).json({ error: 'Token inválido ou usuário não encontrado.' });
    }
});


module.exports = router;
