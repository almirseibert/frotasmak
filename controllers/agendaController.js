const db = require('../database');

const getUserId = (req) => {
    const id = req.user?.uid || req.user?.id || req.user?.userId || req.userId || req.uid;
    if (id) return id;
    if (typeof req.user === 'string' || typeof req.user === 'number') return req.user;
    return null;
};

const safeParam = (param) => param === undefined ? null : param;

exports.getEventos = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        // Solução Mágica de Fuso: DATE_FORMAT obriga o MySQL a devolver como texto exato
        const query = `
            SELECT id, user_id, title, description, 
            DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime, 
            color_hex, is_completed 
            FROM user_agenda 
            WHERE user_id = ? ORDER BY event_datetime ASC
        `;
        const [eventos] = await db.query(query, [userId]);
        res.status(200).json(eventos || []);
    } catch (error) {
        console.error('Erro DB (getEventos):', error);
        res.status(500).json({ error: 'Erro interno ao buscar eventos.' });
    }
};

exports.criarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { title, description, event_datetime, color_hex, reminders } = req.body;

        if (!title || !event_datetime) {
            return res.status(400).json({ error: 'Título e Data/Hora são obrigatórios.' });
        }

        const [result] = await db.query(
            `INSERT INTO user_agenda (user_id, title, description, event_datetime, color_hex) VALUES (?, ?, ?, ?, ?)`, 
            [userId, title, safeParam(description), event_datetime, safeParam(color_hex) || '#3B82F6']
        );
        const agendaId = result.insertId;

        // Salva os N lembretes na nova tabela
        if (reminders && Array.isArray(reminders)) {
            for (const r of reminders) {
                await db.query(
                    `INSERT INTO agenda_reminders (agenda_id, minutes_before, is_sent) VALUES (?, ?, FALSE)`,
                    [agendaId, r.minutes]
                );
            }
        }

        res.status(201).json({ message: 'Evento criado com sucesso!', id: agendaId });
    } catch (error) {
        console.error('Erro DB (criarEvento):', error);
        res.status(500).json({ error: 'Erro interno ao criar evento.' });
    }
};

exports.atualizarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;
        const { title, description, event_datetime, color_hex } = req.body;

        let updateFields = [];
        let values = [];

        if (title !== undefined) { updateFields.push('title = ?'); values.push(title); }
        if (description !== undefined) { updateFields.push('description = ?'); values.push(description); }
        if (event_datetime !== undefined) { updateFields.push('event_datetime = ?'); values.push(event_datetime); }
        if (color_hex !== undefined) { updateFields.push('color_hex = ?'); values.push(color_hex); }

        if (updateFields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualização.' });

        const query = `UPDATE user_agenda SET ${updateFields.join(', ')} WHERE id = ? AND user_id = ?`;
        values.push(eventId, userId);

        const [result] = await db.query(query, values);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Evento atualizado!' });
    } catch (error) {
        console.error('Erro DB (atualizarEvento):', error);
        res.status(500).json({ error: 'Erro interno ao atualizar.' });
    }
};

exports.marcarConcluido = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;
        const { is_completed } = req.body;

        const isCompletedValue = (is_completed === true || is_completed === 'true' || is_completed === 1) ? 1 : 0;
        const [result] = await db.query('UPDATE user_agenda SET is_completed = ? WHERE id = ? AND user_id = ?', [isCompletedValue, eventId, userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Status atualizado!' });
    } catch (error) {
        console.error('Erro DB (marcarConcluido):', error);
        res.status(500).json({ error: 'Erro ao alterar status.' });
    }
};

exports.deletarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;

        const [result] = await db.query('DELETE FROM user_agenda WHERE id = ? AND user_id = ?', [eventId, userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Evento excluído!' });
    } catch (error) {
        console.error('Erro DB (deletarEvento):', error);
        res.status(500).json({ error: 'Erro ao excluir evento.' });
    }
};

exports.getNotificacoesPendentes = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Não autenticado.' });

        const [notificacoes] = await db.query(`
            SELECT id, title, DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime, color_hex
            FROM user_agenda 
            WHERE user_id = ? AND is_completed = FALSE AND event_datetime >= CURDATE()
            ORDER BY event_datetime ASC LIMIT 5
        `, [userId]);
        res.status(200).json(notificacoes || []);
    } catch (error) {
        console.error('Erro DB (getNotificacoes):', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
};