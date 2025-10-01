// controllers/diarioDeBordoController.js
const db = require('../database');
const parseVehicleJsonFields = require('./vehicleController').parseVehicleJsonFields;
const parseEmployeeJsonFields = require('./employeeController').parseEmployeeJsonFields;

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro ---
const parseJsonSafe = (field, key) => {
    if (!field) return null;
    try {
        return JSON.parse(field);
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor:`, field);
        // Retorna null ou objeto vazio em caso de erro, evitando quebrar a aplicação
        return null; 
    }
};

const parseDiarioDeBordoJsonFields = (log) => {
    if (!log) return null;
    const newLog = { ...log };
    
    newLog.startReadings = parseJsonSafe(newLog.startReadings, 'startReadings');
    newLog.endReadings = parseJsonSafe(newLog.endReadings, 'endReadings');
    newLog.breaks = parseJsonSafe(newLog.breaks, 'breaks');
    newLog.createdBy = parseJsonSafe(newLog.createdBy, 'createdBy');
    
    return newLog;
};

// --- READ: Obter todos os logs com filtros de data (Correção de Undefined) ---
const getAllDiarioDeBordo = async (req, res) => {
    // Definindo datas padrão defensivas para evitar 'undefined' no DB.execute.
    // Se startDate/endDate não forem fornecidas, a query deve funcionar.
    // Assumindo que o frontend enviará ou que o uso de IS NOT NULL é melhor se não houver filtro.
    const { startDate, endDate } = req.query;
    
    try {
        let query = 'SELECT * FROM diario_de_bordo';
        let params = [];
        
        // Se ambos os filtros de data existirem, aplica a cláusula WHERE
        if (startDate && endDate) {
            query += ' WHERE logDate BETWEEN ? AND ?';
            params.push(startDate, endDate);
        }
        
        query += ' ORDER BY logDate DESC';

        const [rows] = await db.execute(query, params);
        res.json(rows.map(parseDiarioDeBordoJsonFields));
    } catch (error) {
        console.error('Erro ao buscar diário de bordo:', error);
        res.status(500).json({ error: 'Erro ao buscar diário de bordo' });
    }
};


// --- READ: Obter um único log por ID ---
const getDiarioDeBordoById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM diario_de_bordo WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Registro não encontrado' });
        }
        res.json(parseDiarioDeBordoJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar registro:', error);
        res.status(500).json({ error: 'Erro ao buscar registro' });
    }
};

// --- CREATE: Criar um novo log (offline sync) ---
const createDiarioDeBordo = async (req, res) => {
    const data = req.body;
    // O backend NÃO deve quebrar por dados corrompidos
    if (data.startReadings) data.startReadings = JSON.stringify(data.startReadings);
    if (data.endReadings) data.endReadings = JSON.stringify(data.endReadings);
    if (data.breaks) data.breaks = JSON.stringify(data.breaks);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO diario_de_bordo (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar registro de diário de bordo:', error);
        res.status(500).json({ error: 'Erro ao criar registro de diário de bordo' });
    }
};

// --- UPDATE: Atualizar um log existente ---
const updateDiarioDeBordo = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.startReadings) data.startReadings = JSON.stringify(data.startReadings);
    if (data.endReadings) data.endReadings = JSON.stringify(data.endReadings);
    if (data.breaks) data.breaks = JSON.stringify(data.breaks);
    if (data.createdBy) data.createdBy = JSON.stringify(data.createdBy);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE diario_de_bordo SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Registro de diário de bordo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar registro:', error);
        res.status(500).json({ error: 'Erro ao atualizar registro' });
    }
};

// --- DELETE: Deletar um log ---
const deleteDiarioDeBordo = async (req, res) => {
    try {
        await db.execute('DELETE FROM diario_de_bordo WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar registro:', error);
        res.status(500).json({ error: 'Erro ao deletar registro' });
    }
};


// -------------------------------------------------------------------------
// NOVAS ROTAS COM LÓGICA DE JORNADA
// -------------------------------------------------------------------------

// --- ROTA: Iniciar uma nova jornada ---
const startJourney = async (req, res) => {
    const { employeeId, vehicleId, obraId, startReadings, createdBy, logDate, status, startTime, obraName } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [lastLogRows] = await connection.execute('SELECT endTime FROM diario_de_bordo WHERE employeeId = ? AND status = "Fechado" ORDER BY endTime DESC LIMIT 1', [employeeId]);
        const lastLog = parseDiarioDeBordoJsonFields(lastLogRows[0]);
        if (lastLog) {
            const lastEndTime = new Date(lastLog.endTime);
            const now = new Date(startTime);
            const diffHours = (now.getTime() - lastEndTime.getTime()) / (1000 * 60 * 60);
            if (diffHours < 11) {
                await connection.rollback();
                return res.status(400).json({ error: `Você precisa de um descanso mínimo de 11 horas. Faltam ${Math.ceil(11 - diffHours)} horas para poder iniciar uma nova jornada.` });
            }
        }

        const newLog = {
            employeeId,
            vehicleId,
            obraId,
            logDate: new Date(logDate),
            status,
            startTime: new Date(startTime),
            startReadings: JSON.stringify(startReadings),
            createdBy: JSON.stringify(createdBy),
            createdAt: new Date(),
            obraName,
            employeeName: createdBy.userEmail, // Exemplo de uso
            vehicleName: createdBy.userEmail // Exemplo de uso
        };

        await connection.execute('INSERT INTO diario_de_bordo SET ?', [newLog]);

        await connection.commit();
        res.status(201).json({ message: 'Jornada iniciada com sucesso!' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao iniciar jornada:", error);
        res.status(500).json({ error: 'Falha ao iniciar a jornada.' });
    } finally {
        connection.release();
    }
};

// --- ROTA: Finalizar uma jornada ---
const endJourney = async (req, res) => {
    const { id } = req.params;
    const { endTime, endReadings, notes, vehicleUpdate } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [activeLogRows] = await connection.execute('SELECT startTime, vehicleId FROM diario_de_bordo WHERE id = ?', [id]);
        const activeLog = parseDiarioDeBordoJsonFields(activeLogRows[0]);
        if (!activeLog) {
            await connection.rollback();
            return res.status(404).json({ error: 'Registro de jornada não encontrado.' });
        }

        const journeyStart = new Date(activeLog.startTime);
        const now = new Date(endTime);
        const journeyMinutes = (now.getTime() - journeyStart.getTime()) / 60000;
        if (journeyMinutes < 15) {
            await connection.rollback();
            return res.status(400).json({ error: 'O tempo mínimo para finalizar a jornada é de 15 minutos.' });
        }

        const finalLogData = {
            status: 'Fechado',
            endTime: now,
            endReadings: JSON.stringify(endReadings),
            notes,
        };
        await connection.execute('UPDATE diario_de_bordo SET ? WHERE id = ?', [finalLogData, id]);

        if (Object.keys(vehicleUpdate).length > 0) {
            await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdate, activeLog.vehicleId]);
        }

        await connection.commit();
        res.status(200).json({ message: 'Jornada finalizada com sucesso!' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar jornada:", error);
        res.status(500).json({ error: 'Falha ao finalizar a jornada.' });
    } finally {
        connection.release();
    }
};

// --- ROTA: Iniciar intervalo ---
const startBreak = async (req, res) => {
    const { id } = req.params;
    const { lunchStartTime } = req.body;
    try {
        await db.execute('UPDATE diario_de_bordo SET status = "Em Almoço", lunchStartTime = ? WHERE id = ?', [new Date(lunchStartTime), id]);
        res.status(200).json({ message: 'Intervalo iniciado com sucesso.' });
    } catch (error) {
        console.error("Erro ao iniciar intervalo:", error);
        res.status(500).json({ error: 'Falha ao iniciar o intervalo.' });
    }
};

// --- ROTA: Finalizar intervalo ---
const endBreak = async (req, res) => {
    const { id } = req.params;
    const { breaks } = req.body;
    try {
        await db.execute('UPDATE diario_de_bordo SET status = "Aberto", breaks = ?, lunchStartTime = NULL WHERE id = ?', [JSON.stringify(breaks), id]);
        res.status(200).json({ message: 'Retorno do intervalo registrado com sucesso.' });
    } catch (error) {
        console.error("Erro ao finalizar intervalo:", error);
        res.status(500).json({ error: 'Falha ao finalizar o intervalo.' });
    }
};


module.exports = {
    getAllDiarioDeBordo,
    getDiarioDeBordoById,
    createDiarioDeBordo,
    updateDiarioDeBordo,
    deleteDiarioDeBordo,
    startJourney,
    endJourney,
    startBreak,
    endBreak
};
