// controllers/revisionController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// Helper para parsear JSON de forma segura
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
    const data = { ...restOfBody, tipo: descricao };
    
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
    const data = { ...restOfBody, tipo: descricao };

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
            const newPlan = { id: newRevisionId, vehicleId: vehicleId, ...data, ultimaAlteracao: ultimaAlteracao };
            delete newPlan.historico;
            const fields = Object.keys(newPlan);
            const values = Object.values(newPlan);
            const placeholders = fields.map(() => '?').join(', ');
            const query = `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`;
            await connection.execute(query, values);
        }
        await connection.commit();
        res.json({ message: 'Agendamento de revisão salvo com sucesso' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar plano de revisão:', error);
        res.status(500).json({ error: 'Erro ao salvar plano de revisão' });
    } finally {
        connection.release();
    }
};

// --- POST: Concluir Revisão (Novo - Unificado) ---
const completeRevision = async (req, res) => {
    const { id: vehicleId } = req.params;
    const { 
        realizadaEm, 
        realizadaPor, 
        leituraRealizada, // Valor da leitura (Km ou Hr) - Unificado
        descricao, 
        custo, 
        notaFiscal,
        proximaRevisaoData,
        proximaRevisaoLeitura // Meta para a próxima
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Identificar a Revisão e o Veículo
        const [revRows] = await connection.execute('SELECT * FROM revisions WHERE vehicleId = ?', [vehicleId]);
        if (revRows.length === 0) throw new Error('Plano de revisão não encontrado.');
        const revision = revRows[0];

        const [vehRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);
        if (vehRows.length === 0) throw new Error('Veículo não encontrado.');
        const vehicle = vehRows[0];

        // 2. Registrar no Histórico
        const historyId = uuidv4();
        const historyData = {
            id: historyId,
            revisionId: revision.id,
            data: realizadaEm,
            descricao: descricao || 'Revisão Concluída',
            km: leituraRealizada, // Salva o valor genérico (seja km ou hr)
            realizadaPor: realizadaPor,
            custo: parseFloat(custo) || 0,
            notaFiscal: notaFiscal
        };

        const histFields = Object.keys(historyData);
        const histValues = Object.values(historyData);
        const histPlaceholders = histFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO revisions_history (${histFields.join(', ')}) VALUES (${histPlaceholders})`, 
            histValues
        );

        // 3. Atualizar Plano para a Próxima
        // Regra Unificada:
        // Se vehicle.mediaCalculo === 'horimetro' -> Atualiza proximaRevisaoHorimetro
        // Caso contrário (padrão) -> Atualiza proximaRevisaoOdometro
        
        let updatePlanQuery = 'UPDATE revisions SET proximaRevisaoData = ?';
        const updatePlanParams = [proximaRevisaoData];

        const isHourBased = vehicle.mediaCalculo === 'horimetro';
        
        if (isHourBased) {
            updatePlanQuery += ', proximaRevisaoHorimetro = ?';
            updatePlanParams.push(proximaRevisaoLeitura);
        } else {
            updatePlanQuery += ', proximaRevisaoOdometro = ?';
            updatePlanParams.push(proximaRevisaoLeitura);
        }
        
        // Atualiza metadata
        const ultimaAlteracao = JSON.stringify({
             userId: req.user?.id || 'sistema',
             userEmail: req.user?.email || 'sistema',
             timestamp: new Date().toISOString(),
             action: 'Conclusão de Revisão'
        });
        
        updatePlanQuery += ', ultimaAlteracao = ? WHERE id = ?';
        updatePlanParams.push(ultimaAlteracao);
        updatePlanParams.push(revision.id);

        await connection.execute(updatePlanQuery, updatePlanParams);

        // 4. Atualizar Leitura do Veículo (Unificado)
        // Ao concluir revisão, assumimos que a leitura informada é a real atual e atualizamos o veículo
        let updateVehicleQuery = '';
        const readingVal = parseFloat(leituraRealizada);

        if (isHourBased) {
            // Atualiza horimetro e LIMPA os campos legados para evitar conflito
            updateVehicleQuery = 'UPDATE vehicles SET horimetro = ?, horimetroDigital = NULL, horimetroAnalogico = NULL WHERE id = ?';
        } else {
            updateVehicleQuery = 'UPDATE vehicles SET odometro = ? WHERE id = ?';
        }

        if (!isNaN(readingVal) && readingVal > 0) {
            await connection.execute(updateVehicleQuery, [readingVal, vehicleId]);
        }

        await connection.commit();
        res.json({ message: 'Revisão concluída e veículo atualizado com sucesso!' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao concluir revisão:', error);
        res.status(500).json({ error: error.message });
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

module.exports = {
    getAllRevisionPlans,
    createRevisionPlan,
    updateRevisionPlan,
    completeRevision,
    deleteRevisionPlan
};