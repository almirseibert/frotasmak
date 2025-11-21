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


// --- GET: Obter todos os planos de revisão ---
const getAllRevisionPlans = async (req, res) => {
    try {
        const [plans] = await db.query('SELECT * FROM revisions');
        const [historyRows] = await db.query('SELECT * FROM revisions_history ORDER BY data DESC');

        const revisions = plans.map(plan => {
            const ultimaAlteracao = parseJsonSafe(plan.ultimaAlteracao, 'ultimaAlteracao');

            const isImported = !plan.vehicleId;
            const effectiveVehicleId = isImported ? plan.id : plan.vehicleId;

            const { tipo, ...restOfPlan } = plan;
            const historico = historyRows.filter(h => h.revisionId === plan.id);
            
            return {
                ...restOfPlan,
                vehicleId: effectiveVehicleId,
                descricao: tipo, 
                ultimaAlteracao: ultimaAlteracao,
                historico: historico,
            };
        });
        
        res.json(revisions);
    } catch (error) {
        console.error('Erro ao buscar planos de revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar planos de revisão' });
    }
};

// --- POST: Criar Plano ---
const createRevisionPlan = async (req, res) => {
    const { descricao, ...restOfBody } = req.body;
    const data = { 
        ...restOfBody, 
        tipo: descricao 
    };
    
    if (!data.id) data.id = uuidv4();
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


// --- PUT: Atualizar Plano ---
const updateRevisionPlan = async (req, res) => {
    const { id: vehicleId } = req.params; 
    const { descricao, ...restOfBody } = req.body;
    const data = {
        ...restOfBody,
        tipo: descricao 
    };

    const ultimaAlteracao = JSON.stringify({
        userId: req.user?.id || 'sistema',
        userEmail: req.user?.email || 'sistema',
        timestamp: new Date().toISOString()
    });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );
        
        if (rows.length > 0) {
            const revisionId = rows[0].id;
            
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
            const newRevisionId = uuidv4(); 
            
            const newPlan = {
                id: newRevisionId,
                vehicleId: vehicleId,
                ...data, 
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

// --- DELETE: Deletar Plano ---
const deleteRevisionPlan = async (req, res) => {
    try {
        await db.execute('DELETE FROM revisions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao deletar plano de revisão' });
    }
};

// --- GET: Consolidado ---
const getConsolidatedRevisionPlan = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM revisions WHERE proximaRevisaoData IS NOT NULL');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar plano consolidado:', error);
        res.status(500).json({ error: 'Erro ao buscar plano consolidado de revisões' });
    }
};


// --- GET: Histórico ---
const getRevisionHistoryByVehicle = async (req, res) => {
    const { vehicleId } = req.params;
    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId é obrigatório.' });
    }
    try {
        const [planRows] = await db.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );

        if (planRows.length === 0) {
             const [historyRowsLegacy] = await db.query('SELECT * FROM revisions_history WHERE revisionId = ? ORDER BY data DESC', [vehicleId]);
             if (historyRowsLegacy.length > 0) {
                return res.json(historyRowsLegacy);
             }
             return res.json([]); 
        }

        const revisionId = planRows[0].id; 

        const query = `
            SELECT h.* FROM revisions_history h
            WHERE h.revisionId = ? 
            ORDER BY h.data DESC
        `;
        const [rows] = await db.query(query, [revisionId]);
        res.json(rows);
    } catch (error) {
        console.error(`Erro ao buscar histórico do veículo ${vehicleId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar histórico de revisões' });
    }
};

// --- POST: Concluir uma revisão (ATUALIZADO COM UPDATE DO VEÍCULO) ---
const completeRevision = async (req, res) => {
    const { vehicleId, isHourBased, ...historyEntry } = req.body;
    
    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId é obrigatório.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Encontrar o 'revisionId'
        const [rows] = await connection.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );
        
        let revisionId;
        
        if (rows.length === 0) {
            console.warn(`Nenhum plano de revisão encontrado para vehicleId: ${vehicleId}. Criando um novo plano.`);
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
             revisionId = rows[0].id;
        }

        // 2. Adicionar o registro ao histórico
        const historyQuery = `
            INSERT INTO revisions_history (
                revisionId, data, descricao, realizadaEm, realizadaPor, 
                odometro, horimetro
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const leituraValue = historyEntry.leituraRealizada || 0;
        const odometroValue = !isHourBased ? leituraValue : null;
        const horimetroValue = isHourBased ? leituraValue : null;
        const dataRevisao = new Date(historyEntry.realizadaEm);

        await connection.execute(historyQuery, [
            revisionId,
            dataRevisao,              
            historyEntry.descricao,   
            dataRevisao,              
            historyEntry.realizadaPor,
            odometroValue,
            horimetroValue
        ]);

        // 3. Limpar (resetar) o plano de revisão
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

        // 4. ATUALIZAR O VEÍCULO COM A NOVA LEITURA (NOVO!)
        // Atualiza o campo correto (horimetro ou odometro) com a leitura realizada na revisão.
        // Assume-se que a validação de consistência (se é menor ou maior) já foi feita no frontend (Modal com Senha).
        let updateVehicleQuery = '';
        if (isHourBased) {
            updateVehicleQuery = 'UPDATE vehicles SET horimetro = ? WHERE id = ?';
        } else {
            updateVehicleQuery = 'UPDATE vehicles SET odometro = ? WHERE id = ?';
        }
        
        await connection.execute(updateVehicleQuery, [leituraValue, vehicleId]);

        await connection.commit();
        res.status(200).json({ message: 'Revisão concluída e veículo atualizado com sucesso!' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao concluir revisão:", error);
        res.status(500).json({ error: 'Falha ao concluir a revisão.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllRevisionPlans,
    createRevisionPlan,
    updateRevisionPlan,
    deleteRevisionPlan,
    getConsolidatedRevisionPlan,
    getRevisionHistoryByVehicle,
    completeRevision
};