// controllers/revisionController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// ... (parseJsonSafe se mantém igual) ...
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        return null;
    }
};


// --- GET: Obter todos os planos de revisão (CORRIGIDO) ---
// Normaliza os dados legados (Firebase) e novos (MySQL)
const getAllRevisionPlans = async (req, res) => {
    try {
        const [plans] = await db.query('SELECT * FROM revisions');
        const [historyRows] = await db.query('SELECT * FROM revisions_history ORDER BY data DESC');

        const revisions = plans.map(plan => {
            const ultimaAlteracao = parseJsonSafe(plan.ultimaAlteracao, 'ultimaAlteracao');

            // --- CORREÇÃO (Normalização de Dados Legados) ---
            // 1. Define o vehicleId correto
            // Se plan.vehicleId for nulo/vazio (dado legado), usa plan.id como vehicleId.
            const isImported = !plan.vehicleId;
            const effectiveVehicleId = isImported ? plan.id : plan.vehicleId;

            // 2. Renomeia 'tipo' (DB) para 'descricao' (Frontend)
            const { tipo, ...restOfPlan } = plan;

            // 3. Encontra o histórico (o revisionId no histórico SEMPRE aponta para o plan.id)
            const historico = historyRows.filter(h => h.revisionId === plan.id);
            
            return {
                ...restOfPlan,
                vehicleId: effectiveVehicleId, // Envia o vehicleId normalizado
                descricao: tipo, // Renomeia 'tipo' para 'descricao'
                ultimaAlteracao: ultimaAlteracao,
                historico: historico,
            };
            // --- Fim da Correção ---
        });
        
        res.json(revisions);
    } catch (error) {
        console.error('Erro ao buscar planos de revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar planos de revisão' });
    }
};

// ... (createRevisionPlan se mantém igual, pois ele só cria dados NOVOS) ...
const createRevisionPlan = async (req, res) => {
    // Esta função não é chamada pelo RevisionsPage, mas corrigida por precaução
    const { descricao, ...restOfBody } = req.body;
    const data = { 
        ...restOfBody, 
        tipo: descricao // Mapeia 'descricao' para 'tipo'
    };
    
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
// Acha o registro legado (por ID) ou novo (por VehicleID)
const updateRevisionPlan = async (req, res) => {
    // O ID da rota é o vehicleId (vindo do frontend)
    const { id: vehicleId } = req.params; 
    const { descricao, ...restOfBody } = req.body;
    const data = {
        ...restOfBody,
        tipo: descricao // Renomeia 'descricao' (frontend) para 'tipo' (DB)
    };

    const ultimaAlteracao = JSON.stringify({
        userId: req.user?.id || 'sistema',
        userEmail: req.user?.email || 'sistema',
        timestamp: new Date().toISOString()
    });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // --- CORREÇÃO (Achar registro legado OU novo) ---
        // Tenta encontrar o registro pelo vehicleId (novo) OU pelo id (legado)
        const [rows] = await connection.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );
        // --- Fim da Correção ---
        
        if (rows.length > 0) {
            // 2. SE EXISTE: Atualiza o plano existente
            const revisionId = rows[0].id; // Este é o PK (seja o uuid ou o id legado)
            
            delete data.id;
            delete data.vehicleId;
            delete data.historico;
            data.ultimaAlteracao = ultimaAlteracao; 

            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;

            await connection.execute(query, [...values, revisionId]);
        } else {
            // 3. SE NÃO EXISTE (ex: primeiro agendamento): Cria um novo plano
            const newRevisionId = uuidv4(); 
            
            const newPlan = {
                id: newRevisionId,
                vehicleId: vehicleId,
                ...data, // tipo, proximaRevisaoData, etc.
                ultimaAlteracao: ultimaAlteracao
            };
            
            delete newPlan.historico;

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

// ... (deleteRevisionPlan se mantém igual) ...
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

// ... (getConsolidatedRevisionPlan se mantém igual) ...
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
// Acha o histórico legado OU novo
const getRevisionHistoryByVehicle = async (req, res) => {
    const { vehicleId } = req.params;
    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId é obrigatório.' });
    }
    try {
        // --- CORREÇÃO (Achar histórico legado OU novo) ---
        // 1. Encontra o ID da revisão (seja legado ou novo)
        const [planRows] = await db.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );

        if (planRows.length === 0) {
             // Se não há plano, não pode haver histórico (baseado no FK)
             // No entanto, os dados legados podem não ter o plano, mas ter o histórico
             // Vamos checar o histórico DIRETAMENTE com o vehicleId (que era o revisionId legado)
             const [historyRowsLegacy] = await db.query('SELECT * FROM revisions_history WHERE revisionId = ? ORDER BY data DESC', [vehicleId]);
             if (historyRowsLegacy.length > 0) {
                return res.json(historyRowsLegacy);
             }
             return res.json([]); // Nenhum plano e nenhum histórico legado encontrado
        }

        const revisionId = planRows[0].id; // Este é o PK da tabela revisions

        // 2. Busca o histórico usando o PK (revisionId)
        // O .sql mostra que `revisions_history.revisionId` aponta para `revisions.id`
        const query = `
            SELECT h.* FROM revisions_history h
            WHERE h.revisionId = ? 
            ORDER BY h.data DESC
        `;
        const [rows] = await db.query(query, [revisionId]);
        res.json(rows);
        // --- Fim da Correção ---
    } catch (error) {
        console.error(`Erro ao buscar histórico do veículo ${vehicleId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico de revisões' });
    }
};

// --- POST: Concluir uma revisão (CORRIGIDO) ---
// Acha o registro legado (por ID) ou novo (por VehicleID)
const completeRevision = async (req, res) => {
    const { vehicleId, isHourBased, ...historyEntry } = req.body;
    
    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId é obrigatório.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // --- CORREÇÃO (Achar registro legado OU novo) ---
        // 1. Encontrar o 'revisionId' (PK da tabela 'revisions') usando o 'vehicleId'
        const [rows] = await connection.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );
        // --- Fim da Correção ---
        
        let revisionId;
        
        if (rows.length === 0) {
            // Se não houver plano, cria um (padrão novo)
            console.warn(`Nenhum plano de revisão encontrado para vehicleId: ${vehicleId}. Criando um novo plano para registrar o histórico.`);
            revisionId = uuidv4();
            const newPlanQuery = `INSERT INTO revisions (id, vehicleId, ultimaAlteracao) VALUES (?, ?, ?)`;
            const ultimaAlteracao = JSON.stringify({
                userId: req.user?.id || 'sistema',
                userEmail: req.user?.email || 'sistema',
                timestamp: new Date().toISOString(),
                action: 'Criação automática por conclusão de revisão'
            });
            await connection.execute(newPlanQuery, [revisionId, vehicleId, ultimaAlteracao]);
        } else {
             revisionId = rows[0].id; // Usa o PK encontrado
        }

        // 2. Adicionar o registro ao histórico (lógica mantida, estava correta)
        const historyQuery = `
            INSERT INTO revisions_history (
                revisionId, data, descricao, realizadaEm, realizadaPor, 
                odometro, horimetro
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const odometroValue = !isHourBased ? (historyEntry.leituraRealizada || null) : null;
        const horimetroValue = isHourBased ? (historyEntry.leituraRealizada || null) : null;

        await connection.execute(historyQuery, [
            revisionId,
            historyEntry.realizadaEm, 
            historyEntry.descricao,   
            historyEntry.realizadaEm, 
            historyEntry.realizadaPor,
            odometroValue,
            horimetroValue
        ]);

        // 3. Limpar (resetar) o plano de revisão (lógica mantida, 'tipo' estava correto)
        const resetQuery = `
            UPDATE revisions 
            SET 
                proximaRevisaoData = NULL, 
                proximaRevisaoOdometro = NULL, 
                proximaRevisaoHorimetro = NULL,
                avisoAntecedenciaKmHr = NULL,
                avisoAntecedenciaDias = NULL,
                tipo = NULL, 
                ultimaAlteracao = ?
            WHERE id = ?
        `;
        const ultimaAlteracaoReset = JSON.stringify({
             userId: req.user?.id || 'sistema',
             userEmail: req.user?.email || 'sistema',
             timestamp: new Date().toISOString(),
             action: 'Conclusão de Revisão'
        });
        await connection.execute(resetQuery, [ultimaAlteracaoReset, revisionId]);

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