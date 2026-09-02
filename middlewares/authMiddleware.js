// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const db = require('../database'); // Importação necessária para verificar status em tempo real
const { canUserAccessPage, normalizePagePermissions } = require('../utils/permissions');

// ────────────────────────────────────────────────────────────────────────────
// Cache curto do registro do usuário.
//
// A revalidação no banco existe para que bloqueio/mudança de permissão tenham
// efeito imediato, e isso é mantido — mas ela roda a CADA request, e o
// frontend dispara várias chamadas em paralelo a cada troca de página. Com um
// pool de apenas 10 conexões, essa rajada competia por conexão com as queries
// que realmente carregam dados.
//
// O TTL é deliberadamente curto (5s): colapsa a rajada de um único page load,
// que é onde está a pressão, sem criar uma janela de revogação perceptível.
// Não há invalidação explícita de propósito — `users` é alterada em 11 pontos
// de 6 controllers, vários por `email` ou `employeeId` em vez de `id`, e um
// ponto esquecido deixaria um bloqueio sem efeito por mais tempo do que os 5s
// que o TTL já garante.
// ────────────────────────────────────────────────────────────────────────────
const USER_CACHE_TTL_MS = 5_000;
const userCache = new Map(); // id -> { row, expiresAt }

const fetchUserRow = async (id) => {
    const agora = Date.now();
    const cached = userCache.get(id);
    if (cached && cached.expiresAt > agora) return cached.row;

    const [users] = await db.query(
        'SELECT id, email, role, user_type, canAccessRefueling, canAccessAnaliseGerencial, bloqueado_abastecimento, page_permissions, can_create_hidden_orders FROM users WHERE id = ?',
        [id]
    );
    const row = users.length ? users[0] : null;
    userCache.set(id, { row, expiresAt: agora + USER_CACHE_TTL_MS });

    // Poda preguiçosa: sem isso o Map cresceria indefinidamente com ids antigos.
    if (userCache.size > 500) {
        for (const [k, v] of userCache) {
            if (v.expiresAt <= agora) userCache.delete(k);
        }
    }
    return row;
};

/** Descarta a entrada de cache de um usuário (efeito imediato antes do TTL). */
const invalidateUserCache = (id) => { userCache.delete(id); };

const authMiddleware = async (req, res, next) => {
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

        // 3. SEGURANÇA REFORÇADA:
        // Busca dados atualizados do usuário no banco para garantir que não foi bloqueado recentemente
        // e para pegar as flags de permissão de abastecimento mais recentes.
        const user = await fetchUserRow(decoded.id);

        if (!user) {
            return res.status(401).json({ error: 'Usuário não encontrado ou removido.' });
        }

        // Normaliza o papel do usuário (role ou user_type)
        const userRole = (user.role || user.user_type || '').toLowerCase();

        // 4. Anexar o payload atualizado à requisição
        req.user = {
            id: user.id,
            email: user.email,
            role: userRole,
            user_type: user.user_type || user.role,
            canAccessRefueling: user.canAccessRefueling === 1,
            canAccessAnaliseGerencial: user.canAccessAnaliseGerencial === 1,
            bloqueado_abastecimento: user.bloqueado_abastecimento === 1,
            can_create_hidden_orders: user.can_create_hidden_orders === 1,
            // Override individual de páginas — base para o cálculo de acesso efetivo.
            pagePermissions: normalizePagePermissions(user.page_permissions)
        };

        // 5. VERIFICAÇÃO DE ACESSO AO MÓDULO SUPERVISOR
        // As URLs "/supervisor" servem a página 'supervisor_dashboard'. Usa a fonte
        // única (canUserAccessPage) para não divergir do menu do front.
        if (req.originalUrl && req.originalUrl.includes('/supervisor')) {
            if (!canUserAccessPage(req.user, 'supervisor_dashboard')) {
                return res.status(403).json({
                    error: 'Acesso negado. Você não tem permissão para acessar este módulo.'
                });
            }
        }

        // 6. Continuar para a próxima função/rota
        next();
    } catch (err) {
        console.error("Erro authMiddleware:", err.message);
        // Distingue token EXPIRADO (renovável via refresh token) de token
        // realmente inválido/adulterado. O frontend usa o 401 + code para
        // disparar a renovação silenciosa em vez de deslogar o usuário.
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado.', code: 'TOKEN_EXPIRED' });
        }
        return res.status(403).json({ error: 'Token inválido.' });
    }
};

module.exports = authMiddleware;
module.exports.invalidateUserCache = invalidateUserCache;
