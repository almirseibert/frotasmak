const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// --- Listar logs por Obra (com filtros opcionais de data) ---
const getDailyLogs = async (req, res) => {
    // Tenta pegar do params (/obra/:id) ou da query string (?obraId=...)
    let obraId = req.params.obraId || req.query.obraId;
    const { startDate, endDate, vehicleId } = req.query;

    try {
        let query = `
            SELECT l.*, v.modelo, v.registroInterno, v.tipo, e.nome as employeeName 
            FROM daily_work_logs l
            JOIN vehicles v ON l.vehicleId = v.id
            LEFT JOIN employees e ON l.employeeId = e.id 
        `;
        
        const params = [];
        const conditions = [];

        // Lógica para filtrar por Obra (ou ignorar se for 'all')
        if (obraId && obraId !== 'all') {
            conditions.push('l.obraId = ?');
            params.push(obraId);
        }

        if (startDate && endDate) {
            conditions.push('l.date BETWEEN ? AND ?');
            params.push(startDate, endDate);
        }
        
        if (vehicleId) {
            conditions.push('l.vehicleId = ?');
            params.push(vehicleId);
        }

        // Adiciona WHERE apenas se houver condições
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY l.date DESC, v.registroInterno ASC';

        const [rows] = await db.query(query, params);
        res.json(rows);

    } catch (error) {
        console.error('Erro ao buscar logs diários:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const upsertDailyLog = async (req, res) => {
    const data = req.body;
    
    // Validação básica
    if (!data.obraId || !data.vehicleId || !data.date) {
        return res.status(400).json({ error: 'Campos obrigatórios faltando (Obra, Veículo, Data).' });
    }

    try {
        // Se tem ID, é atualização
        if (data.id) {
            const query = `
                UPDATE daily_work_logs 
                SET vehicleId = ?, employeeId = ?, date = ?, 
                    morningStart = ?, morningEnd = ?, afternoonStart = ?, afternoonEnd = ?, 
                    totalHours = ?, observation = ?
                WHERE id = ?
            `;
            await db.execute(query, [
                data.vehicleId, 
                data.employeeId || null, 
                data.date, 
                data.morningStart || null, 
                data.morningEnd || null, 
                data.afternoonStart || null, 
                data.afternoonEnd || null, 
                data.totalHours || 0, 
                data.observation || null,
                data.id
            ]);
            
            // EMITIR EVENTO SOCKET.IO
            if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

            res.json({ message: 'Registro atualizado com sucesso.' });

        } else {
            // Criação
            const newId = uuidv4();
            const { 
                obraId, vehicleId, employeeId, date, 
                morningStart, morningEnd, afternoonStart, afternoonEnd, totalHours, observation 
            } = data;

            const query = `
                INSERT INTO daily_work_logs 
                (id, obraId, vehicleId, employeeId, date, morningStart, morningEnd, afternoonStart, afternoonEnd, totalHours, observation)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await db.execute(query, [
                newId, 
                obraId, 
                vehicleId, 
                employeeId || null, 
                date, 
                morningStart || null, 
                morningEnd || null, 
                afternoonStart || null, 
                afternoonEnd || null, 
                totalHours || 0, 
                observation || null
            ]);
            
            // EMITIR EVENTO SOCKET.IO
            if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

            res.status(201).json({ message: 'Registro criado com sucesso.', id: newId });
        }
    } catch (error) {
        console.error('Erro ao salvar log diário:', error);
        res.status(500).json({ error: 'Erro ao salvar registro.' });
    }
};

const deleteDailyLog = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM daily_work_logs WHERE id = ?', [id]);
        
        // EMITIR EVENTO SOCKET.IO
        if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar log:', error);
        res.status(500).json({ error: 'Erro ao deletar.' });
    }
};

module.exports = {
    getDailyLogs,
    upsertDailyLog,
    deleteDailyLog
};