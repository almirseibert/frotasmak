// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware'); // Importar o middleware

// Rota de registro de novo usuário
router.post('/register', authController.register);

// Rota de login
router.post('/login', authController.login);

// Rota protegida para VALIDAR A SENHA do usuário logado (usado pelo PasswordConfirmationModal)
// Exige um token válido no header e a senha no corpo (body) da requisição.
router.post('/validatePassword', authMiddleware, authController.validatePassword);

// Exemplo de rota protegida que só pode ser acessada com um token válido
router.get('/protected', authMiddleware, (req, res) => {
    res.json({ message: `Bem-vindo, ${req.user.email}! Você tem acesso.`, user: req.user });
});

module.exports = router;
