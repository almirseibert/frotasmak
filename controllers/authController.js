const db = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ====================================================================
// FUNÇÃO DE LOGIN
// OBJETIVO: Autenticar um usuário e retornar um token JWT.
// ====================================================================
const login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }

    try {
        // Encontra o usuário pelo e-mail no banco de dados
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user) {
            // Resposta genérica para não informar se o e-mail existe ou não
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Compara a senha fornecida com a senha criptografada armazenada
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Se as credenciais estiverem corretas, gera o token JWT
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' } // Token expira em 24 horas
        );

        res.json({ token });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ====================================================================
// FUNÇÃO DE REGISTRO
// OBJETIVO: Registrar um novo usuário (exemplo, pode ser ajustado para o seu fluxo de "pedido de registro").
// ====================================================================
const register = async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
    }

    try {
        // Verifica se o e-mail já está cadastrado
        const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ message: 'Este e-mail já está em uso.' });
        }

        // Criptografa a senha antes de salvar no banco
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insere o novo usuário com um role padrão.
        await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, 'viewer'] // 'viewer' como role padrão
        );

        res.status(201).json({ message: 'Usuário registrado com sucesso.' });

    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ====================================================================
// FUNÇÃO PARA VALIDAR A SENHA (A QUE ESTAVA FALTANDO)
// OBJETIVO: Confirmar a senha do usuário logado para ações sensíveis.
// ====================================================================
const validatePassword = async (req, res) => {
    // O ID do usuário vem do token, que foi verificado pelo authMiddleware
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ message: 'A senha é obrigatória para validação.' });
    }

    try {
        // Busca a senha criptografada do usuário no banco
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) {
            // Esta verificação é uma segurança extra
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // Compara a senha fornecida com a senha armazenada
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Senha incorreta.' });
        }

        // Se a senha estiver correta, retorna uma resposta de sucesso
        res.status(200).json({ message: 'Senha validada com sucesso.' });

    } catch (error) {
        console.error('Erro ao validar senha:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// Exporta todas as funções para que o authRoutes.js possa usá-las
module.exports = {
    login,
    register,
    validatePassword
};

