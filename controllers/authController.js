// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database'); // Importa a conexão do arquivo database.js

const register = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    }
    try {
        // Verifica se o usuário já existe
        const [existingUsers] = await db.execute('SELECT email FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ error: 'Este email já está registrado.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword]);
        res.status(201).json({ message: 'Usuário registrado com sucesso!' });
    } catch (error) {
        // Captura qualquer erro de banco de dados ou bcrypt
        console.error('Erro no registro:', error);
        res.status(500).json({ error: 'Erro interno ao registrar usuário' });
    }
};

const login = async (req, res) => {
    const { email, password } = req.body;
    try {
        // 1. Busca o usuário no banco de dados
        const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user) {
            // Mensagem genérica para segurança (usuário não encontrado)
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        // 2. Compara a senha (pode falhar se o hash for inválido, gerando 500 sem tratamento)
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            // Mensagem genérica para segurança (senha incorreta)
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        // 3. Gera o token e retorna sucesso
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (error) {
        // Captura qualquer erro de conexão com o DB, query, ou falha no bcrypt
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno ao fazer login' });
    }
};

// Exporta as funções
module.exports = {
    register,
    login,
};
