const db = require('../database');

// Função auxiliar para extrair o ID do usuário de forma segura
const getUserId = (req) => {
    return req.user?.id || req.userId || req.user?.userId || (typeof req.user === 'number' ? req.user : null);
};

// Função auxiliar para evitar o erro de "undefined" no mysql2
const safeParam = (param) => param === undefined ? null : param;

exports.getEventos = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const [eventos] = await db.query('SELECT * FROM user_agenda WHERE user_id = ? ORDER BY event_datetime ASC', [userId]);
        res.status(200).json(eventos);
    } catch (error) {
        console.error('Erro DB (getEventos):', error);
        res.status(500).json({ error: 'Erro interno ao buscar eventos.' });
    }
};

exports.criarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { title, description, event_datetime, reminder_time, related_type, related_id, color_hex } = req.body;

        if (!title || !event_datetime) {
            return res.status(400).json({ error: 'Título e Data/Hora são obrigatórios.' });
        }

        const query = `
            INSERT INTO user_agenda 
            (user_id, title, description, event_datetime, reminder_time, related_type, related_id, color_hex) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        // Usando safeParam e new Date() para garantir tipos compatíveis com o MySQL
        const values = [
            userId, 
            title, 
            safeParam(description), 
            new Date(event_datetime), 
            safeParam(reminder_time) || 0, 
            safeParam(related_type), 
            safeParam(related_id), 
            safeParam(color_hex) || '#3B82F6'
        ];

        const [result] = await db.query(query, values);
        res.status(201).json({ message: 'Evento criado com sucesso!', id: result.insertId });
    } catch (error) {
        console.error('Erro DB (criarEvento):', error);
        res.status(500).json({ error: 'Erro interno ao criar evento no banco de dados.' });
    }
};

exports.atualizarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;
        const { title, description, event_datetime, color_hex } = req.body;

        // Construção dinâmica da query para atualizar apenas o que foi enviado (evita sobreposição nula)
        let updateFields = [];
        let values = [];

        if (title !== undefined) { updateFields.push('title = ?'); values.push(title); }
        if (description !== undefined) { updateFields.push('description = ?'); values.push(description); }
        if (event_datetime !== undefined) { updateFields.push('event_datetime = ?'); values.push(new Date(event_datetime)); }
        if (color_hex !== undefined) { updateFields.push('color_hex = ?'); values.push(color_hex); }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'Nenhum campo enviado para atualização.' });
        }

        const query = `UPDATE user_agenda SET ${updateFields.join(', ')} WHERE id = ? AND user_id = ?`;
        values.push(eventId, userId); // Adiciona os IDs no final dos valores

        const [result] = await db.query(query, values);
        
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado ou você não tem permissão.' });
        res.status(200).json({ message: 'Evento atualizado com sucesso!' });
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

        // Força a conversão correta para TINYINT do MySQL (1 ou 0)
        const isCompletedValue = (is_completed === true || is_completed === 'true' || is_completed === 1) ? 1 : 0;

        const [result] = await db.query('UPDATE user_agenda SET is_completed = ? WHERE id = ? AND user_id = ?', [isCompletedValue, eventId, userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Status atualizado!' });
    } catch (error) {
        console.error('Erro DB (marcarConcluido):', error);
        res.status(500).json({ error: 'Erro interno ao alterar status.' });
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
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const query = `
            SELECT id, title, event_datetime, related_type, related_id, color_hex
            FROM user_agenda 
            WHERE user_id = ? AND is_completed = FALSE AND event_datetime >= CURDATE()
            ORDER BY event_datetime ASC LIMIT 5
        `;
        const [notificacoes] = await db.query(query, [userId]);
        res.status(200).json(notificacoes);
    } catch (error) {
        console.error('Erro DB (getNotificacoes):', error);
        res.status(500).json({ error: 'Erro interno ao buscar notificações.' });
    }
};