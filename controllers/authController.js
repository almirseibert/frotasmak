const db = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ====================================================================
// FUNÇÃO DE LOGIN
// ====================================================================
const login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // --- VERIFICAÇÃO DE STATUS ---
        // Verifica o campo 'status' para ver se está ativo
        // Aceita 'ativo' (minúsculo ou maiúsculo) para compatibilidade
        const status = user.status ? user.status.toLowerCase() : '';
        
        if (status === 'inativo') {
            return res.status(403).json({ message: 'Sua conta aguarda aprovação do administrador.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Gera token com permissões
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                role: user.role || user.user_type, 
                canAccessRefueling: user.canAccessRefueling === 1
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, user: { 
            name: user.name, 
            email: user.email, 
            role: user.role || user.user_type,
            canAccessRefueling: user.canAccessRefueling === 1
        }});

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ====================================================================
// FUNÇÃO DE REGISTRO (Solicitação de Cadastro)
// ====================================================================
const register = async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
    }

    try {
        const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ message: 'Este e-mail já está em uso.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUserId = uuidv4();

        // Insere na tabela USERS com status INATIVO
        // CORREÇÃO: Removido 'user_status' que não existe na tabela. Usamos apenas 'status'.
        await db.query(
            `INSERT INTO users (
                id, name, email, password, 
                role, user_type, 
                status, 
                canAccessRefueling, 
                data_criacao
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                newUserId, name, email, hashedPassword, 
                'guest', 'guest', // Role e User Type inicial como guest
                'inativo', // Status inativo
                0 // canAccessRefueling false
            ] 
        );

        res.status(201).json({ message: 'Solicitação enviada! Aguarde a liberação do administrador.' });

    } catch (error) {
        console.error('Erro no registro:', error);
        // Log detalhado do erro SQL se disponível
        if (error.sqlMessage) console.error('SQL Error:', error.sqlMessage);
        
        res.status(500).json({ message: 'Erro ao processar cadastro. Tente novamente.' });
    }
};

// ====================================================================
// VALIDAR SENHA
// ====================================================================
const validatePassword = async (req, res) => {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) return res.status(400).json({ message: 'Senha obrigatória.' });

    try {
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'Senha incorreta.' });

        res.status(200).json({ message: 'Senha validada.' });
    } catch (error) {
        console.error('Erro validação senha:', error);
        res.status(500).json({ message: 'Erro interno.' });
    }
};

// ====================================================================
// TROCAR SENHA
// ====================================================================
const changePassword = async (req, res) => {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Preencha a senha atual e a nova senha.' });
    }

    try {
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(401).json({ message: 'A senha atual está incorreta.' });

        const salt = await bcrypt.genSalt(10);
        const hashedNewPassword = await bcrypt.hash(newPassword, salt);

        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, userId]);

        res.status(200).json({ message: 'Senha alterada com sucesso.' });

    } catch (error) {
        console.error('Erro ao trocar senha:', error);
        res.status(500).json({ message: 'Erro ao trocar senha.' });
    }
};

module.exports = {
    login,
    register,
    validatePassword,
    changePassword
};