// controllers/chatController.js
// Mensageiro interno (chat 1:1 estilo MSN) entre usuários de escritório.
// Operadores (user_type = 'operador') ficam de fora do chat.
const db = require('../database');
const { randomUUID } = require('crypto');
const presence = require('../services/presenceService');

let pushService = null;
try { pushService = require('../services/pushService'); } catch { /* opcional */ }

// Usuários que participam do chat: todos menos operadores e inativos.
const OFFICE_FILTER = `LOWER(COALESCE(u.user_type, u.role, '')) <> 'operador'
                       AND (u.status IS NULL OR LOWER(u.status) = 'ativo')`;

const MAX_BODY = 4000;

// GET /api/chat/contacts — lista de contatos (usuários de escritório) com
// nome de exibição, status atual (presença em memória), última mensagem trocada
// e contagem de não-lidas.
const getContacts = async (req, res) => {
    try {
        const me = req.user.id;
        const [users] = await db.query(
            `SELECT u.id, u.name, u.display_name, u.email,
                    u.user_type, u.role, u.chat_status, u.chat_status_msg, u.chat_last_seen
               FROM users u
              WHERE u.id <> ? AND ${OFFICE_FILTER}
              ORDER BY COALESCE(NULLIF(u.display_name, ''), u.name) ASC`,
            [me]
        );

        // Última mensagem + não-lidas por contato (em relação a `me`).
        const [lasts] = await db.query(
            `SELECT
                CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id,
                MAX(created_at) AS last_at
             FROM messages
             WHERE sender_id = ? OR recipient_id = ?
             GROUP BY other_id`,
            [me, me, me]
        );
        const lastByOther = new Map(lasts.map(r => [String(r.other_id), r.last_at]));

        const [unreads] = await db.query(
            `SELECT sender_id AS other_id, COUNT(*) AS n
               FROM messages
              WHERE recipient_id = ? AND read_at IS NULL
              GROUP BY sender_id`,
            [me]
        );
        const unreadByOther = new Map(unreads.map(r => [String(r.other_id), Number(r.n)]));

        const contacts = users.map(u => {
            const connected = presence.isConnected(u.id);
            return {
                id: u.id,
                name: u.name,
                displayName: u.display_name || u.name,
                role: (u.user_type || u.role || '').toLowerCase(),
                // Presença em tempo real quando conectado; senão 'offline'.
                status: connected ? presence.publicStatus(u.id) : 'offline',
                statusMsg: connected ? presence.publicStatusMsg(u.id) : (u.chat_status_msg || null),
                lastSeen: u.chat_last_seen,
                lastMessageAt: lastByOther.get(String(u.id)) || null,
                unread: unreadByOther.get(String(u.id)) || 0,
            };
        });

        res.json(contacts);
    } catch (error) {
        console.error('❌ Erro ao listar contatos do chat:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao carregar contatos.' });
    }
};

// GET /api/chat/messages/:userId — histórico com um contato. Marca como lidas
// as mensagens recebidas dele e avisa o remetente (chat:read).
const getMessages = async (req, res) => {
    try {
        const me = req.user.id;
        const other = req.params.userId;
        if (!other || String(other) === String(me)) return res.status(400).json({ error: 'Contato inválido.' });

        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const [rows] = await db.query(
            `SELECT id, sender_id, recipient_id, body, type, read_at, created_at
               FROM messages
              WHERE (sender_id = ? AND recipient_id = ?)
                 OR (sender_id = ? AND recipient_id = ?)
              ORDER BY created_at DESC
              LIMIT ?`,
            [me, other, other, me, limit]
        );

        // Marca como lidas as que ele me enviou.
        const [upd] = await db.query(
            `UPDATE messages SET read_at = NOW()
              WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`,
            [me, other]
        );
        if (upd.affectedRows > 0 && req.io) {
            req.io.to('user:' + other).emit('chat:read', { by: me });
        }

        res.json(rows.reverse()); // ordem cronológica ascendente
    } catch (error) {
        console.error('❌ Erro ao carregar mensagens:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao carregar mensagens.' });
    }
};

// POST /api/chat/messages { recipientId, body, type? } — envia mensagem.
// Emite em tempo real ao destinatário (e ecoa ao remetente para sincronizar
// outras abas). Se o destinatário estiver offline, dispara push.
const postMessage = async (req, res) => {
    try {
        const me = req.user.id;
        const recipientId = (req.body.recipientId ?? '').toString();
        const type = req.body.type === 'nudge' ? 'nudge' : 'text';
        let body = (req.body.body || '').toString().trim();

        if (!recipientId || recipientId === String(me)) return res.status(400).json({ error: 'Destinatário inválido.' });
        if (type === 'nudge' && !body) body = 'Chamou sua atenção!';
        if (!body) return res.status(400).json({ error: 'Mensagem vazia.' });
        if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

        // Destinatário precisa existir e ser de escritório.
        const [urows] = await db.query(
            `SELECT u.id, u.name, u.display_name FROM users u WHERE u.id = ? AND ${OFFICE_FILTER}`,
            [recipientId]
        );
        if (urows.length === 0) return res.status(404).json({ error: 'Destinatário não encontrado.' });

        // Nome de exibição do remetente (para o payload).
        const [srows] = await db.query('SELECT name, display_name FROM users WHERE id = ?', [me]);
        const senderName = (srows[0] && (srows[0].display_name || srows[0].name)) || req.user.email || 'Usuário';

        const id = randomUUID();
        const createdAt = new Date();
        await db.query(
            `INSERT INTO messages (id, sender_id, recipient_id, body, type, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, me, recipientId, body, type, createdAt]
        );

        const payload = {
            id,
            sender_id: me,
            recipient_id: recipientId,
            senderName,
            body,
            type,
            read_at: null,
            created_at: createdAt,
        };

        if (req.io) {
            req.io.to('user:' + recipientId).emit('chat:message', payload);
            req.io.to('user:' + me).emit('chat:message', payload); // eco p/ outras abas do remetente
            if (type === 'nudge') {
                req.io.to('user:' + recipientId).emit('chat:nudge', { from: me, senderName });
            }
        }

        // Offline → push mobile (infra já existente).
        if (!presence.isConnected(recipientId) && pushService) {
            pushService.pushToUsers([recipientId], {
                title: senderName,
                body: type === 'nudge' ? 'Chamou sua atenção!' : body.slice(0, 120),
                data: { kind: 'chat', from: me },
            }).catch(() => {});
        }

        res.status(201).json(payload);
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao enviar mensagem.' });
    }
};

module.exports = { getContacts, getMessages, postMessage };
