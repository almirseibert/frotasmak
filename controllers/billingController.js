const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// --- Listar logs por Obra (com filtros opcionais de data) ---
const getDailyLogs = async (req, res) => {
    const { obraId } = req.params;
    const { startDate, endDate, vehicleId } = req.query;

    // *** CORREÇÃO CRÍTICA AQUI ***
    // Alterado de 'e.employeeId' para 'e.id' (que é a chave primária correta da tabela employees)
    let query = `
        SELECT l.*, v.modelo, v.registroInterno, v.tipo, e.nome as employeeName 
        FROM daily_work_logs l
        JOIN vehicles v ON l.vehicleId = v.id
        LEFT JOIN employees e ON l.employeeId = e.id 
        WHERE l.obraId = ?
    `;
    
    const params = [obraId];

    if (startDate && endDate) {
        query += ' AND l.date BETWEEN ? AND ?';
        params.push(startDate, endDate);
    }
    
    if (vehicleId) {
        query += ' AND l.vehicleId = ?';
        params.push(vehicleId);
    }

    query += ' ORDER BY l.date DESC, v.registroInterno ASC';

    try {
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar logs diários:', error);
        res.status(500).json({ error: 'Erro interno ao buscar registros.' });
    }
};

// --- Criar ou Atualizar um Log Diário (Upsert) ---
const upsertDailyLog = async (req, res) => {
    const { 
        obraId, 
        vehicleId, 
        employeeId, 
        date, 
        morningStart, 
        morningEnd, 
        afternoonStart, 
        afternoonEnd, 
        totalHours, 
        observation 
    } = req.body;

    if (!obraId || !vehicleId || !date) {
        return res.status(400).json({ error: 'Dados obrigatórios faltando (Obra, Veículo ou Data).' });
    }

    try {
        // Verifica se já existe registro para este veículo nesta obra nesta data
        const [existing] = await db.query(
            'SELECT id FROM daily_work_logs WHERE obraId = ? AND vehicleId = ? AND date = ?',
            [obraId, vehicleId, date]
        );

        if (existing.length > 0) {
            // Atualizar
            const query = `
                UPDATE daily_work_logs 
                SET employeeId = ?, morningStart = ?, morningEnd = ?, afternoonStart = ?, afternoonEnd = ?, totalHours = ?, observation = ?
                WHERE id = ?
            `;
            await db.execute(query, [
                employeeId || null, 
                morningStart || null, 
                morningEnd || null, 
                afternoonStart || null, 
                afternoonEnd || null, 
                totalHours || 0, 
                observation || null,
                existing[0].id
            ]);
            
            // EMITIR EVENTO SOCKET.IO
            req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

            res.json({ message: 'Registro atualizado com sucesso.', id: existing[0].id });
        } else {
            // Criar
            const newId = uuidv4();
            const query = `
                INSERT INTO daily_work_logs (id, obraId, vehicleId, employeeId, date, morningStart, morningEnd, afternoonStart, afternoonEnd, totalHours, observation)
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
            req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

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
        req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });

        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar log:', error);
        res.status(500).json({ error: 'Erro ao deletar registro.' });
    }
};

module.exports = {
    getDailyLogs,
    upsertDailyLog,
    deleteDailyLog
};