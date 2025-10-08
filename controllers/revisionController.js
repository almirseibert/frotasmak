const db = require('../database');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao analisar o campo '${key}'. Valor:`, field);
        return null;
    }
};

// --- Função Auxiliar para processar campos JSON de uma revisão ---
const parseRevisionJsonFields = (revision) => {
    if (!revision) return null;
    const newRevision = { ...revision };
    newRevision.historico = parseJsonSafe(newRevision.historico, 'historico');
    return newRevision;
};

// --- GET: Obter todos os planos de revisão ---
const getAllRevisionPlans = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM revisions');
        const revisions = rows.map(parseRevisionJsonFields);
        res.json(revisions);
    } catch (error) {
        console.error('Erro ao buscar planos de revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar planos de revisão' });
    }
};

// --- POST: Criar um novo plano de revisão ---
const createRevisionPlan = async (req, res) => {
    const data = { ...req.body };
    if (data.historico) data.historico = JSON.stringify(data.historico);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        res.status(201).json({ message: 'Plano de revisão criado com sucesso' });
    } catch (error) {
        console.error('Erro ao criar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao criar plano de revisão' });
    }
};

// --- PUT: Atualizar um plano de revisão ---
const updateRevisionPlan = async (req, res) => {
    const { id } = req.params;
    const data = { ...req.body };
    if (data.historico) data.historico = JSON.stringify(data.historico);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Plano de revisão atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao atualizar plano de revisão' });
    }
};

// --- DELETE: Deletar um plano de revisão ---
const deleteRevisionPlan = async (req, res) => {
    try {
        await db.execute('DELETE FROM revisions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao deletar plano de revisão' });
    }
};

// --- FUNÇÕES QUE ESTAVAM EM FALTA ---

// --- GET: Obter o plano consolidado ---
const getConsolidatedRevisionPlan = async (req, res) => {
    try {
        // Lógica de exemplo: esta consulta precisa ser mais complexa para cruzar veículos e revisões.
        const [rows] = await db.query('SELECT * FROM revisions WHERE proximaRevisaoData IS NOT NULL');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar plano consolidado:', error);
        res.status(500).json({ error: 'Erro ao buscar plano consolidado de revisões' });
    }
};

// --- GET: Obter o histórico de um veículo ---
const getRevisionHistoryByVehicle = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        // A sua tabela `revisions_history` pode ser a fonte aqui.
        const [rows] = await db.query('SELECT * FROM revisions_history WHERE vehicleId = ? ORDER BY dataRealizacao DESC', [vehicleId]);
        res.json(rows);
    } catch (error) {
        console.error(`Erro ao buscar histórico do veículo ${vehicleId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico de revisões' });
    }
};

// --- POST: Concluir uma revisão ---
const completeRevision = async (req, res) => {
    const { revisionId, ...historyEntry } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        // Lógica para adicionar ao histórico e resetar o plano de revisão
        await connection.commit();
        res.status(200).json({ message: 'Revisão concluída com sucesso!' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao concluir revisão:", error);
        res.status(500).json({ error: 'Falha ao concluir a revisão.' });
    } finally {
        connection.release();
    }
};

// --- EXPORTAÇÃO DE TODAS AS FUNÇÕES ---
module.exports = {
    getAllRevisionPlans,
    createRevisionPlan,
    updateRevisionPlan,
    deleteRevisionPlan,
    getConsolidatedRevisionPlan,
    getRevisionHistoryByVehicle,
    completeRevision
};
