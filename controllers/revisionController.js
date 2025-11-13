// controllers/revisionController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid'); // Para gerar IDs

// --- Função Auxiliar para Conversão de JSON (Mantida) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        // Não loga aviso, pois o campo 'historico' não existe no BD
        // console.warn(`[JSON Parse Error] Falha ao analisar o campo '${key}'. Valor:`, field);
        return null;
    }
};

// --- GET: Obter todos os planos de revisão (CORRIGIDO) ---
// Busca os planos e o histórico, e junta os dois.
const getAllRevisionPlans = async (req, res) => {
    try {
        // 1. Busca todos os planos de revisão
        const [plans] = await db.query('SELECT * FROM revisions');
        
        // 2. Busca todo o histórico de revisões
        const [historyRows] = await db.query('SELECT * FROM revisions_history ORDER BY data DESC');

        // 3. Mapeia os planos e injeta o histórico correspondente
        const revisions = plans.map(plan => {
            // O 'historico' que o frontend espera é o 'revisions_history'
            const historico = historyRows.filter(h => h.revisionId === plan.id);
            
            // Tenta parsear 'ultimaAlteracao' (que existe no .sql)
            const ultimaAlteracao = parseJsonSafe(plan.ultimaAlteracao, 'ultimaAlteracao');

            return {
                ...plan,
                ultimaAlteracao: ultimaAlteracao,
                historico: historico, // Injeta o array de histórico
            };
        });
        
        res.json(revisions);
    } catch (error) {
        console.error('Erro ao buscar planos de revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar planos de revisão' });
    }
};

// --- POST: Criar um novo plano de revisão (Não usado pelo frontend, mas mantido) ---
const createRevisionPlan = async (req, res) => {
    const data = { ...req.body };
    
    // Adiciona o ID gerado (já que é varchar)
    if (!data.id) data.id = uuidv4();
    
    // Remove 'historico' se ele foi enviado acidentalmente
    delete data.historico; 
    
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

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

// --- PUT: Atualizar um plano de revisão (CORRIGIDO) ---
// Usa "UPSERT" (Update or Insert) baseado no vehicleId.
const updateRevisionPlan = async (req, res) => {
    // O ID da rota é o vehicleId
    const { id: vehicleId } = req.params; 
    const data = { ...req.body };

    // Pega o usuário logado
    const ultimaAlteracao = JSON.stringify({
        userId: req.user?.id || 'sistema',
        userEmail: req.user?.email || 'sistema',
        timestamp: new Date().toISOString()
    });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Verifica se já existe um plano para este veículo
        const [rows] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [vehicleId]);
        
        if (rows.length > 0) {
            // 2. SE EXISTE: Atualiza o plano existente
            const revisionId = rows[0].id;
            
            // Remove campos que não podem ser atualizados pelo frontend
            delete data.id;
            delete data.vehicleId;
            delete data.historico;

            data.ultimaAlteracao = ultimaAlteracao; // Adiciona info de alteração

            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;

            await connection.execute(query, [...values, revisionId]);
        } else {
            // 3. SE NÃO EXISTE: Cria um novo plano
            const newRevisionId = uuidv4(); // Cria um ID para a tabela 'revisions'
            
            const newPlan = {
                id: newRevisionId,
                vehicleId: vehicleId,
                ...data, // tipo, proximaRevisaoData, etc.
                ultimaAlteracao: ultimaAlteracao
            };
            
            delete newPlan.historico; // Garante que o campo de array não seja salvo

            const fields = Object.keys(newPlan);
            const values = Object.values(newPlan);
            const placeholders = fields.map(() => '?').join(', ');
            const query = `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`;

            await connection.execute(query, values);
        }

        await connection.commit();
        res.json({ message: 'Agendamento de revisão salvo com sucesso' });
    } catch (error)
    {
        await connection.rollback();
        console.error('Erro ao salvar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao salvar plano de revisão' });
    } finally {
        connection.release();
    }
};

// --- DELETE: Deletar um plano de revisão (Mantido) ---
const deleteRevisionPlan = async (req, res) => {
    try {
        // Assume que o ID aqui é o REVISION ID, não o vehicleId
        await db.execute('DELETE FROM revisions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao deletar plano de revisão' });
    }
};

// --- GET: Obter o plano consolidado (Mantido, embora não usado pelo RevisionsPage) ---
const getConsolidatedRevisionPlan = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM revisions WHERE proximaRevisaoData IS NOT NULL');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar plano consolidado:', error);
        res.status(500).json({ error: 'Erro ao buscar plano consolidado de revisões' });
    }
};

// --- GET: Obter o histórico de um veículo (CORRIGIDO) ---
const getRevisionHistoryByVehicle = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        // Consulta corrigida para buscar o histórico baseado no vehicleId (usando JOIN)
        const query = `
            SELECT h.* FROM revisions_history h
            JOIN revisions r ON h.revisionId = r.id
            WHERE r.vehicleId = ? 
            ORDER BY h.data DESC
        `;
        const [rows] = await db.query(query, [vehicleId]);
        res.json(rows);
    } catch (error) {
        console.error(`Erro ao buscar histórico do veículo ${vehicleId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico de revisões' });
    }
};

// --- POST: Concluir uma revisão (CORRIGIDO) ---
const completeRevision = async (req, res) => {
    // O frontend envia { vehicleId, leituraRealizada, realizadaEm, realizadaPor, descricao }
    const { vehicleId, ...historyEntry } = req.body;
    
    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId é obrigatório.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Encontrar o 'revisionId' (PK da tabela 'revisions') usando o 'vehicleId'
        const [rows] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [vehicleId]);
        
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Nenhum plano de revisão encontrado para este veículo.' });
        }
        const revisionId = rows[0].id;

        // 2. Adicionar o registro ao histórico (tabela 'revisions_history')
        // O .sql (linha 694) espera: id (AI), revisionId, data, odometro, horimetro, descricao, realizadaEm, realizadaPor
        // O frontend envia: leituraRealizada, realizadaEm, realizadaPor, descricao
        // Vamos assumir que 'leituraRealizada' deve ir para 'odometro' ou 'horimetro'
        // Simples: vamos salvar o que o frontend enviou.
        const historyData = {
            revisionId: revisionId,
            data: historyEntry.realizadaEm, // Mapeia 'realizadaEm' para 'data' (ou o campo correto do .sql)
            // odometro: ??? (o .sql tem, mas o frontend não envia)
            // horimetro: ??? (o .sql tem, mas o frontend não envia)
            descricao: historyEntry.descricao,
            realizadaEm: historyEntry.realizadaEm,
            realizadaPor: historyEntry.realizadaPor
            // Adicionando a leitura no campo 'odometro' por padrão, já que 'leituraRealizada' não existe no .sql
            // odometro: historyEntry.leituraRealizada 
        };
        // Vamos verificar o .sql (linha 694)
        // `revisions_history` (id, revisionId, data, odometro, horimetro, descricao, realizadaEm, realizadaPor)
        // O frontend (linha 279) envia: { leituraRealizada, realizadaEm, realizadaPor, descricao }
        
        // Vamos adaptar a inserção para o .sql
        const historyQuery = `
            INSERT INTO revisions_history (revisionId, data, descricao, realizadaEm, realizadaPor, odometro) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        await connection.execute(historyQuery, [
            revisionId,
            historyEntry.realizadaEm, // 'data'
            historyEntry.descricao,
            historyEntry.realizadaEm, // 'realizadaEm'
            historyEntry.realizadaPor,
            historyEntry.leituraRealizada // 'odometro' (assumindo)
        ]);

        // 3. Limpar (resetar) o plano de revisão agendado na tabela 'revisions'
        const resetQuery = `
            UPDATE revisions 
            SET 
                proximaRevisaoData = NULL, 
                proximaRevisaoOdometro = NULL, 
                proximaRevisaoHorimetro = NULL,
                avisoAntecedenciaKmHr = NULL,
                avisoAntecedenciaDias = NULL,
                descricao = NULL,
                ultimaAlteracao = ?
            WHERE id = ?
        `;
        const ultimaAlteracao = JSON.stringify({
             userId: req.user?.id || 'sistema',
             userEmail: req.user?.email || 'sistema',
             timestamp: new Date().toISOString(),
             action: 'Conclusão de Revisão'
        });
        await connection.execute(resetQuery, [ultimaAlteracao, revisionId]);

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