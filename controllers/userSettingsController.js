// controllers/userSettingsController.js
// Configurações do usuário logado — perfil de chat (nome de exibição, status MSN,
// recado pessoal). Consumido pelo modal de Configurações no frontend.
const db = require('../database');
const presence = require('../services/presenceService');

const VALID_STATUS = ['disponivel', 'ausente', 'ocupado', 'volto_logo', 'invisivel', 'offline'];

// mysql2 pode devolver JSON já parseado (objeto) ou como string, conforme versão.
const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

// GET /api/users/me/settings
const getMySettings = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT id, name, display_name, chat_status, chat_status_msg, chat_notif_prefs FROM users WHERE id = ?',
            [req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        const u = rows[0];
        res.json({
            id: u.id,
            name: u.name,
            displayName: u.display_name || u.name || '',
            chatStatus: u.chat_status || 'disponivel',
            chatStatusMsg: u.chat_status_msg || '',
            chatNotifPrefs: parseJson(u.chat_notif_prefs),
        });
    } catch (error) {
        console.error('❌ Erro ao carregar configurações:', error.message);
        res.status(500).json({ error: 'Erro ao carregar configurações.' });
    }
};

// PUT /api/users/me/settings { displayName?, chatStatus?, chatStatusMsg? }
const updateMySettings = async (req, res) => {
    try {
        const me = req.user.id;
        const fields = [];
        const params = [];

        if (req.body.displayName !== undefined) {
            const dn = String(req.body.displayName).trim().slice(0, 120);
            fields.push('display_name = ?');
            params.push(dn || null);
        }
        if (req.body.chatStatus !== undefined) {
            const st = String(req.body.chatStatus).toLowerCase();
            if (!VALID_STATUS.includes(st)) return res.status(400).json({ error: 'Status inválido.' });
            fields.push('chat_status = ?');
            params.push(st);
        }
        if (req.body.chatStatusMsg !== undefined) {
            const msg = String(req.body.chatStatusMsg).trim().slice(0, 140);
            fields.push('chat_status_msg = ?');
            params.push(msg || null);
        }
        if (req.body.chatNotifPrefs !== undefined) {
            let json = null;
            try {
                const obj = typeof req.body.chatNotifPrefs === 'string'
                    ? JSON.parse(req.body.chatNotifPrefs) : req.body.chatNotifPrefs;
                if (obj && typeof obj === 'object') json = JSON.stringify(obj);
            } catch { /* ignora payload inválido */ }
            fields.push('chat_notif_prefs = ?');
            params.push(json);
        }

        if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });

        params.push(me);
        await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);

        // Se o usuário estiver conectado e mudou status/recado, propaga presença.
        if ((req.body.chatStatus !== undefined || req.body.chatStatusMsg !== undefined) && presence.isConnected(me)) {
            const entry = presence.setStatus(
                me,
                req.body.chatStatus !== undefined ? String(req.body.chatStatus).toLowerCase() : undefined,
                req.body.chatStatusMsg !== undefined ? (String(req.body.chatStatusMsg).trim().slice(0, 140) || null) : undefined,
            );
            if (req.io && entry) {
                req.io.emit('presence:update', {
                    userId: me,
                    status: presence.publicStatus(me),
                    statusMsg: presence.publicStatusMsg(me),
                });
            }
        }

        const [rows] = await db.query(
            'SELECT id, name, display_name, chat_status, chat_status_msg, chat_notif_prefs FROM users WHERE id = ?',
            [me]
        );
        const u = rows[0];
        res.json({
            id: u.id,
            name: u.name,
            displayName: u.display_name || u.name || '',
            chatStatus: u.chat_status || 'disponivel',
            chatStatusMsg: u.chat_status_msg || '',
            chatNotifPrefs: parseJson(u.chat_notif_prefs),
        });
    } catch (error) {
        console.error('❌ Erro ao salvar configurações:', error.message);
        res.status(500).json({ error: 'Erro ao salvar configurações.' });
    }
};

module.exports = { getMySettings, updateMySettings };
