// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
    // 1. Obter o token do cabeçalho
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        // Se não houver cabeçalho, nega acesso
        return res.status(401).json({ error: 'Token não fornecido. Acesso negado.' });
    }

    // O formato é 'Bearer [token]', então dividimos e pegamos o token
    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Formato do token inválido.' });
    }

    try {
        // 2. Verificar e decodificar o token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 3. Anexar o payload do usuário à requisição para uso nas rotas
        req.user = decoded; 
        
        // 4. Continuar para a próxima função/rota
        next();
    } catch (err) {
        // Se o token for inválido, expirado, ou a verificação falhar
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
};

module.exports = authMiddleware;