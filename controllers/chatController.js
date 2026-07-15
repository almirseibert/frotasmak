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

// Registro de auditoria (fire-and-forget) — não bloqueia a resposta.
const logAudit = (actorId, peerId, action, messageId = null) => {
    db.query(
        'INSERT INTO chat_audit_log (id, actor_id, peer_id, action, message_id) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), actorId, peerId || null, action, messageId]
    ).catch(() => { /* auditoria nunca derruba o fluxo principal */ });
};

// Verifica se há bloqueio em qualquer direção entre dois usuários.
const isBlockedBetween = async (a, b) => {
    const [rows] = await db.query(
        'SELECT 1 FROM chat_blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?) LIMIT 1',
        [a, b, b, a]
    );
    return rows.length > 0;
};

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

        // Contatos que eu bloqueei.
        const [blocks] = await db.query('SELECT blocked_id FROM chat_blocks WHERE user_id = ?', [me]);
        const blockedSet = new Set(blocks.map(b => String(b.blocked_id)));

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
                blocked: blockedSet.has(String(u.id)),
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
        // Paginação para scroll infinito: `before` = ISO da mensagem mais antiga
        // já carregada; retorna a página anterior a ela.
        const before = req.query.before ? new Date(req.query.before) : null;
        const params = [me, other, other, me];
        let beforeClause = '';
        if (before && !isNaN(before.getTime())) {
            beforeClause = ' AND created_at < ?';
            params.push(before);
        }
        params.push(limit);
        const [rows] = await db.query(
            `SELECT id, sender_id, recipient_id, body, type, reply_to,
                    read_at, delivered_at, edited_at, deleted_at,
                    pinned_at, pinned_by, client_msg_id, created_at,
                    attachment_url, attachment_name, attachment_mime, attachment_size
               FROM messages
              WHERE ((sender_id = ? AND recipient_id = ?)
                 OR (sender_id = ? AND recipient_id = ?))${beforeClause}
              ORDER BY created_at DESC
              LIMIT ?`,
            params
        );

        // Reações de todas as mensagens carregadas.
        const ids = rows.map(r => r.id);
        let reactionsByMsg = {};
        if (ids.length) {
            const [reacts] = await db.query(
                `SELECT message_id, user_id, emoji FROM message_reactions
                  WHERE message_id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            reactionsByMsg = reacts.reduce((acc, r) => {
                (acc[r.message_id] = acc[r.message_id] || []).push({ userId: r.user_id, emoji: r.emoji });
                return acc;
            }, {});
        }
        const enriched = rows.map(r => ({
            ...r,
            body: r.deleted_at ? null : r.body,
            attachment_url: r.deleted_at ? null : r.attachment_url,
            attachment_name: r.deleted_at ? null : r.attachment_name,
            attachment_mime: r.deleted_at ? null : r.attachment_mime,
            attachment_size: r.deleted_at ? null : r.attachment_size,
            reactions: reactionsByMsg[r.id] || [],
        }));

        // Marca como lidas as que ele me enviou.
        const [upd] = await db.query(
            `UPDATE messages SET read_at = NOW()
              WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`,
            [me, other]
        );
        if (upd.affectedRows > 0 && req.io) {
            req.io.to('user:' + other).emit('chat:read', { by: me });
        }

        res.json(enriched.reverse()); // ordem cronológica ascendente
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
        const ALLOWED_TYPES = ['text', 'nudge', 'card'];
        const type = ALLOWED_TYPES.includes(req.body.type) ? req.body.type : 'text';
        const clientMsgId = req.body.clientMsgId ? String(req.body.clientMsgId).slice(0, 64) : null;
        const replyTo = req.body.replyTo ? String(req.body.replyTo).slice(0, 36) : null;
        let body = (req.body.body || '').toString().trim();

        // Anexo (opcional) — reusa o resultado de POST /api/upload.
        const att = req.body.attachment || null;
        const attachment = att && att.url ? {
            url: String(att.url).slice(0, 500),
            name: (att.name ? String(att.name) : '').slice(0, 255) || null,
            mime: (att.mime ? String(att.mime) : '').slice(0, 100) || null,
            size: Number.isFinite(+att.size) ? +att.size : null,
        } : null;

        if (!recipientId || recipientId === String(me)) return res.status(400).json({ error: 'Destinatário inválido.' });
        if (type === 'nudge' && !body) body = 'Chamou sua atenção!';
        // Mensagem só é válida se tiver texto, anexo ou for um card (body=JSON).
        if (!body && !attachment) return res.status(400).json({ error: 'Mensagem vazia.' });
        if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

        // Idempotência: reenvio da fila offline usa o mesmo clientMsgId. Se já
        // existe, devolve o registro salvo em vez de duplicar (e reemite o eco).
        if (clientMsgId) {
            const [dup] = await db.query(
                `SELECT id, sender_id, recipient_id, body, type, read_at, delivered_at, client_msg_id, created_at
                   FROM messages WHERE sender_id = ? AND client_msg_id = ? LIMIT 1`,
                [me, clientMsgId]
            );
            if (dup.length) {
                const existing = dup[0];
                if (req.io) req.io.to('user:' + me).emit('chat:message', existing);
                return res.status(200).json(existing);
            }
        }

        // Destinatário precisa existir e ser de escritório.
        const [urows] = await db.query(
            `SELECT u.id, u.name, u.display_name FROM users u WHERE u.id = ? AND ${OFFICE_FILTER}`,
            [recipientId]
        );
        if (urows.length === 0) return res.status(404).json({ error: 'Destinatário não encontrado.' });

        // Bloqueio em qualquer direção impede o envio.
        if (await isBlockedBetween(me, recipientId)) {
            return res.status(403).json({ error: 'Não é possível enviar: conversa bloqueada.' });
        }

        // Nome de exibição do remetente (para o payload).
        const [srows] = await db.query('SELECT name, display_name FROM users WHERE id = ?', [me]);
        const senderName = (srows[0] && (srows[0].display_name || srows[0].name)) || req.user.email || 'Usuário';

        // Se o destinatário está conectado, já nasce "entregue".
        const online = presence.isConnected(recipientId);
        const id = randomUUID();
        const createdAt = new Date();
        const deliveredAt = online ? createdAt : null;
        try {
            await db.query(
                `INSERT INTO messages (id, sender_id, recipient_id, body, type, reply_to, client_msg_id, delivered_at, created_at,
                                       attachment_url, attachment_name, attachment_mime, attachment_size)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, me, recipientId, body, type, replyTo, clientMsgId, deliveredAt, createdAt,
                 attachment?.url || null, attachment?.name || null, attachment?.mime || null, attachment?.size || null]
            );
        } catch (insErr) {
            // Corrida: dois reenvios simultâneos com o mesmo clientMsgId.
            if (insErr.code === 'ER_DUP_ENTRY' && clientMsgId) {
                const [dup2] = await db.query(
                    `SELECT id, sender_id, recipient_id, body, type, read_at, delivered_at, client_msg_id, created_at
                       FROM messages WHERE sender_id = ? AND client_msg_id = ? LIMIT 1`,
                    [me, clientMsgId]
                );
                if (dup2.length) return res.status(200).json(dup2[0]);
            }
            throw insErr;
        }

        const payload = {
            id,
            sender_id: me,
            recipient_id: recipientId,
            senderName,
            body,
            type,
            reply_to: replyTo,
            reactions: [],
            attachment_url: attachment?.url || null,
            attachment_name: attachment?.name || null,
            attachment_mime: attachment?.mime || null,
            attachment_size: attachment?.size || null,
            client_msg_id: clientMsgId,
            read_at: null,
            delivered_at: deliveredAt,
            created_at: createdAt,
        };

        if (req.io) {
            req.io.to('user:' + recipientId).emit('chat:message', payload);
            req.io.to('user:' + me).emit('chat:message', payload); // eco p/ outras abas do remetente
            if (type === 'nudge') {
                req.io.to('user:' + recipientId).emit('chat:nudge', { from: me, senderName });
            }
            // Confirma entrega imediata ao remetente (destinatário conectado).
            if (online) req.io.to('user:' + me).emit('chat:delivered', { id, to: recipientId });
        }

        logAudit(me, recipientId, 'send', id);

        // Offline → push mobile (infra já existente).
        if (!online && pushService) {
            pushService.pushToUsers([recipientId], {
                title: senderName,
                body: type === 'nudge' ? 'Chamou sua atenção!'
                    : (body ? body.slice(0, 120) : (attachment ? '📎 Anexo' : (type === 'card' ? '📇 Cartão' : ''))),
                data: { kind: 'chat', from: me },
            }).catch(() => {});
        }

        res.status(201).json(payload);
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao enviar mensagem.' });
    }
};

// Helper: carrega a mensagem e valida participação do usuário. Retorna a linha
// ou null. `other` é o outro participante da conversa 1:1.
const loadOwnedMessage = async (id, me) => {
    const [rows] = await db.query(
        'SELECT id, sender_id, recipient_id, deleted_at, created_at FROM messages WHERE id = ? LIMIT 1',
        [id]
    );
    if (!rows.length) return null;
    const m = rows[0];
    const isSender = String(m.sender_id) === String(me);
    const isRecipient = String(m.recipient_id) === String(me);
    if (!isSender && !isRecipient) return null;
    m.other = isSender ? m.recipient_id : m.sender_id;
    m.isSender = isSender;
    return m;
};

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 min para editar/apagar

// PUT /api/chat/messages/:id { body } — edita (só o autor, dentro da janela).
const editMessage = async (req, res) => {
    try {
        const me = req.user.id;
        const m = await loadOwnedMessage(req.params.id, me);
        if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        if (!m.isSender) return res.status(403).json({ error: 'Só o autor pode editar.' });
        if (m.deleted_at) return res.status(400).json({ error: 'Mensagem apagada.' });
        if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) {
            return res.status(400).json({ error: 'Janela de edição expirada.' });
        }
        let body = (req.body.body || '').toString().trim();
        if (!body) return res.status(400).json({ error: 'Mensagem vazia.' });
        if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

        await db.query('UPDATE messages SET body = ?, edited_at = NOW() WHERE id = ?', [body, m.id]);
        logAudit(me, m.other, 'edit', m.id);
        const payload = { id: m.id, body, edited_at: new Date() };
        if (req.io) {
            req.io.to('user:' + m.other).emit('chat:edited', payload);
            req.io.to('user:' + me).emit('chat:edited', payload);
        }
        res.json(payload);
    } catch (error) {
        console.error('❌ Erro ao editar mensagem:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao editar mensagem.' });
    }
};

// DELETE /api/chat/messages/:id — soft delete (mantém no banco p/ auditoria).
const deleteMessage = async (req, res) => {
    try {
        const me = req.user.id;
        const m = await loadOwnedMessage(req.params.id, me);
        if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        if (!m.isSender) return res.status(403).json({ error: 'Só o autor pode apagar.' });
        if (m.deleted_at) return res.json({ id: m.id, deleted_at: m.deleted_at });

        await db.query('UPDATE messages SET deleted_at = NOW() WHERE id = ?', [m.id]);
        logAudit(me, m.other, 'delete', m.id);
        const payload = { id: m.id, deleted_at: new Date() };
        if (req.io) {
            req.io.to('user:' + m.other).emit('chat:deleted', payload);
            req.io.to('user:' + me).emit('chat:deleted', payload);
        }
        res.json(payload);
    } catch (error) {
        console.error('❌ Erro ao apagar mensagem:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao apagar mensagem.' });
    }
};

// POST /api/chat/messages/:id/reaction { emoji } — alterna a reação do usuário.
const toggleReaction = async (req, res) => {
    try {
        const me = req.user.id;
        const emoji = (req.body.emoji || '').toString().slice(0, 16);
        if (!emoji) return res.status(400).json({ error: 'Emoji inválido.' });
        const m = await loadOwnedMessage(req.params.id, me);
        if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });

        const [existing] = await db.query(
            'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? LIMIT 1',
            [m.id, me, emoji]
        );
        let action;
        if (existing.length) {
            await db.query('DELETE FROM message_reactions WHERE id = ?', [existing[0].id]);
            action = 'remove';
        } else {
            await db.query(
                'INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)',
                [randomUUID(), m.id, me, emoji]
            );
            action = 'add';
        }
        const payload = { messageId: m.id, userId: me, emoji, action };
        if (req.io) {
            req.io.to('user:' + m.other).emit('chat:reaction', payload);
            req.io.to('user:' + me).emit('chat:reaction', payload);
        }
        res.json(payload);
    } catch (error) {
        console.error('❌ Erro na reação:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao reagir.' });
    }
};

// POST /api/chat/messages/:id/pin — alterna fixação (qualquer participante).
const togglePin = async (req, res) => {
    try {
        const me = req.user.id;
        const [rows] = await db.query('SELECT id, sender_id, recipient_id, pinned_at FROM messages WHERE id = ? LIMIT 1', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        const m = rows[0];
        const other = String(m.sender_id) === String(me) ? m.recipient_id
            : (String(m.recipient_id) === String(me) ? m.sender_id : null);
        if (other === null) return res.status(403).json({ error: 'Sem acesso.' });

        const pin = !m.pinned_at;
        await db.query(
            'UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?',
            [pin ? new Date() : null, pin ? me : null, m.id]
        );
        const payload = { id: m.id, pinned: pin, pinned_by: pin ? me : null };
        if (req.io) {
            req.io.to('user:' + other).emit('chat:pin', payload);
            req.io.to('user:' + me).emit('chat:pin', payload);
        }
        res.json(payload);
    } catch (error) {
        console.error('❌ Erro ao fixar:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao fixar mensagem.' });
    }
};

// GET /api/chat/search?q=&with= — busca no histórico (opcionalmente com um contato).
const searchMessages = async (req, res) => {
    try {
        const me = req.user.id;
        const q = (req.query.q || '').toString().trim();
        if (q.length < 2) return res.json([]);
        const withUser = req.query.with ? String(req.query.with) : null;
        const like = `%${q}%`;
        const params = [me, me, like];
        let scope = '';
        if (withUser) {
            scope = ' AND (sender_id = ? OR recipient_id = ?)';
            params.push(withUser, withUser);
        }
        const [rows] = await db.query(
            `SELECT id, sender_id, recipient_id, body, type, created_at
               FROM messages
              WHERE (sender_id = ? OR recipient_id = ?)
                AND deleted_at IS NULL AND type = 'text' AND body LIKE ?${scope}
              ORDER BY created_at DESC
              LIMIT 50`,
            params
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro na busca:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro na busca.' });
    }
};

// POST /api/chat/block { userId } — bloqueia um contato.
const blockUser = async (req, res) => {
    try {
        const me = req.user.id;
        const other = (req.body.userId ?? '').toString();
        if (!other || other === String(me)) return res.status(400).json({ error: 'Contato inválido.' });
        await db.query(
            'INSERT IGNORE INTO chat_blocks (user_id, blocked_id) VALUES (?, ?)',
            [me, other]
        );
        logAudit(me, other, 'block');
        res.json({ ok: true, blocked: true });
    } catch (error) {
        console.error('❌ Erro ao bloquear:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao bloquear.' });
    }
};

// POST /api/chat/unblock { userId } — desbloqueia.
const unblockUser = async (req, res) => {
    try {
        const me = req.user.id;
        const other = (req.body.userId ?? '').toString();
        if (!other) return res.status(400).json({ error: 'Contato inválido.' });
        await db.query('DELETE FROM chat_blocks WHERE user_id = ? AND blocked_id = ?', [me, other]);
        logAudit(me, other, 'unblock');
        res.json({ ok: true, blocked: false });
    } catch (error) {
        console.error('❌ Erro ao desbloquear:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao desbloquear.' });
    }
};

// POST /api/chat/report { userId, reason? } — registra uma denúncia (auditoria).
const reportUser = async (req, res) => {
    try {
        const me = req.user.id;
        const other = (req.body.userId ?? '').toString();
        if (!other || other === String(me)) return res.status(400).json({ error: 'Contato inválido.' });
        logAudit(me, other, 'report');
        console.warn(`🚨 [chat] Denúncia: ${me} → ${other} | motivo: ${(req.body.reason || '').toString().slice(0, 200)}`);
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Erro ao reportar:', error.message);
        res.status(500).json({ error: 'Erro ao reportar.' });
    }
};

// GET /api/chat/export/:userId — exporta o histórico da conversa em PDF.
const exportConversation = async (req, res) => {
    try {
        const me = req.user.id;
        const other = req.params.userId;
        if (!other || String(other) === String(me)) return res.status(400).json({ error: 'Contato inválido.' });

        const [meRows] = await db.query('SELECT name, display_name FROM users WHERE id = ?', [me]);
        const [otherRows] = await db.query('SELECT name, display_name FROM users WHERE id = ?', [other]);
        const meName = (meRows[0] && (meRows[0].display_name || meRows[0].name)) || 'Eu';
        const otherName = (otherRows[0] && (otherRows[0].display_name || otherRows[0].name)) || 'Contato';

        const [rows] = await db.query(
            `SELECT sender_id, body, type, deleted_at, created_at,
                    attachment_name
               FROM messages
              WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
              ORDER BY created_at ASC
              LIMIT 5000`,
            [me, other, other, me]
        );

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="conversa-${String(otherName).replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
        doc.pipe(res);

        doc.fontSize(16).text(`Conversa: ${meName} × ${otherName}`, { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(9).fillColor('#888').text(`Exportado em ${new Date().toLocaleString('pt-BR')} · ${rows.length} mensagens`, { align: 'center' });
        doc.moveDown(1).fillColor('#000');

        let lastDay = '';
        rows.forEach(m => {
            const dt = new Date(m.created_at);
            const day = dt.toLocaleDateString('pt-BR');
            if (day !== lastDay) {
                lastDay = day;
                doc.moveDown(0.5).fontSize(9).fillColor('#0846b8').text(day, { align: 'center' }).fillColor('#000');
            }
            const who = String(m.sender_id) === String(me) ? meName : otherName;
            const time = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            let text;
            if (m.deleted_at) text = '(mensagem apagada)';
            else if (m.type === 'nudge') text = '(chamou a atenção)';
            else if (m.type === 'card') text = '(cartão de contexto)';
            else text = m.body || (m.attachment_name ? `(anexo: ${m.attachment_name})` : '');
            doc.fontSize(10).fillColor('#333').text(`[${time}] `, { continued: true })
               .fillColor('#0a6cff').text(`${who}: `, { continued: true })
               .fillColor('#000').text(text);
        });

        doc.end();
    } catch (error) {
        console.error('❌ Erro ao exportar conversa:', error.code, '|', error.sqlMessage || error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Erro ao exportar conversa.' });
    }
};

// POST /api/chat/read { fromUserId } — marca como lidas as mensagens recebidas
// de `fromUserId` (endpoint dedicado; getMessages ainda marca por conveniência).
const markRead = async (req, res) => {
    try {
        const me = req.user.id;
        const other = (req.body.fromUserId ?? '').toString();
        if (!other || other === String(me)) return res.status(400).json({ error: 'Contato inválido.' });

        const [upd] = await db.query(
            `UPDATE messages SET read_at = NOW()
              WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`,
            [me, other]
        );
        if (upd.affectedRows > 0 && req.io) {
            req.io.to('user:' + other).emit('chat:read', { by: me });
        }
        res.json({ ok: true, updated: upd.affectedRows });
    } catch (error) {
        console.error('❌ Erro ao marcar leitura:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao marcar leitura.' });
    }
};

module.exports = {
    getContacts, getMessages, postMessage, markRead,
    editMessage, deleteMessage, toggleReaction, togglePin, searchMessages,
    blockUser, unblockUser, reportUser, exportConversation,
};
