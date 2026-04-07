const db = require('../database');

// 1. Listar todos os eventos do usuário logado (com suporte a filtros de data)
exports.getEventos = async (req, res) => {
    try {
        const userId = req.user.id; // Pegamos do authMiddleware
        const { start_date, end_date } = req.query;

        let query = 'SELECT * FROM user_agenda WHERE user_id = ?';
        const queryParams = [userId];

        // Filtros opcionais para o calendário carregar apenas o mês visualizado
        if (start_date && end_date) {
            query += ' AND event_datetime BETWEEN ? AND ?';
            queryParams.push(start_date, end_date);
        }

        query += ' ORDER BY event_datetime ASC';

        const [eventos] = await db.query(query, queryParams);
        res.status(200).json(eventos);
    } catch (error) {
        console.error('Erro ao buscar eventos da agenda:', error);
        res.status(500).json({ error: 'Erro interno ao buscar eventos.' });
    }
};

// 2. Criar um novo evento (Manual ou Automático)
exports.criarEvento = async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            title, description, event_datetime, reminder_time, 
            related_type, related_id, color_hex 
        } = req.body;

        if (!title || !event_datetime) {
            return res.status(400).json({ error: 'Título e Data/Hora são obrigatórios.' });
        }

        const query = `
            INSERT INTO user_agenda 
            (user_id, title, description, event_datetime, reminder_time, related_type, related_id, color_hex) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const values = [
            userId, title, description || null, event_datetime, 
            reminder_time || 0, related_type || null, related_id || null, color_hex || '#3B82F6'
        ];

        const [result] = await db.query(query, values);
        res.status(201).json({ message: 'Evento criado com sucesso!', id: result.insertId });
    } catch (error) {
        console.error('Erro ao criar evento na agenda:', error);
        res.status(500).json({ error: 'Erro interno ao criar evento.' });
    }
};

// 3. Atualizar um evento existente (Drag & Drop no calendário ou edição manual)
exports.atualizarEvento = async (req, res) => {
    try {
        const userId = req.user.id;
        const eventId = req.params.id;
        const { title, description, event_datetime, color_hex } = req.body;

        // Garante que o usuário só edite os próprios eventos
        const query = `
            UPDATE user_agenda 
            SET title = COALESCE(?, title), 
                description = COALESCE(?, description), 
                event_datetime = COALESCE(?, event_datetime), 
                color_hex = COALESCE(?, color_hex)
            WHERE id = ? AND user_id = ?
        `;

        const [result] = await db.query(query, [title, description, event_datetime, color_hex, eventId, userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Evento não encontrado ou acesso negado.' });
        }

        res.status(200).json({ message: 'Evento atualizado com sucesso!' });
    } catch (error) {
        console.error('Erro ao atualizar evento:', error);
        res.status(500).json({ error: 'Erro interno ao atualizar evento.' });
    }
};

// 4. Marcar como concluído / Desmarcar (Para a funcionalidade de Checklist)
exports.marcarConcluido = async (req, res) => {
    try {
        const userId = req.user.id;
        const eventId = req.params.id;
        const { is_completed } = req.body;

        const query = 'UPDATE user_agenda SET is_completed = ? WHERE id = ? AND user_id = ?';
        const [result] = await db.query(query, [is_completed, eventId, userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Evento não encontrado ou acesso negado.' });
        }

        res.status(200).json({ message: 'Status do evento atualizado!' });
    } catch (error) {
        console.error('Erro ao alterar status do evento:', error);
        res.status(500).json({ error: 'Erro interno ao alterar status.' });
    }
};

// 5. Excluir evento
exports.deletarEvento = async (req, res) => {
    try {
        const userId = req.user.id;
        const eventId = req.params.id;

        const query = 'DELETE FROM user_agenda WHERE id = ? AND user_id = ?';
        const [result] = await db.query(query, [eventId, userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Evento não encontrado ou acesso negado.' });
        }

        res.status(200).json({ message: 'Evento excluído com sucesso!' });
    } catch (error) {
        console.error('Erro ao excluir evento:', error);
        res.status(500).json({ error: 'Erro interno ao excluir evento.' });
    }
};

// 6. Buscar Notificações Pendentes (Sininho / Dashboard)
// Traz eventos de "hoje" e os que já passaram do reminder_time mas não foram concluídos
exports.getNotificacoesPendentes = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Pega eventos não concluídos que acontecem de hoje em diante, ou que já deveriam ter apitado
        const query = `
            SELECT id, title, event_datetime, related_type, related_id, color_hex
            FROM user_agenda 
            WHERE user_id = ? 
              AND is_completed = FALSE 
              AND event_datetime >= CURDATE()
            ORDER BY event_datetime ASC
            LIMIT 5
        `;

        const [notificacoes] = await db.query(query, [userId]);
        res.status(200).json(notificacoes);
    } catch (error) {
        console.error('Erro ao buscar notificações pendentes:', error);
        res.status(500).json({ error: 'Erro interno ao buscar notificações.' });
    }
};