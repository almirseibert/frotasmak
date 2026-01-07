const db = require('../database');
const { v4: uuidv4 } = require('uuid'); // Restaurado UUID pois o banco não é Auto-Increment

// --- Helper para parsear JSON de forma segura ---
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

// --- Helper de Sanitização (Corrige Erro 500 de String Vazia) ---
const sanitize = (val) => {
    if (val === '' || val === undefined || val === 'undefined') return null;
    return val;
};

// --- GET: Obter todos os planos de revisão ---
const getAllRevisionPlans = async (req, res) => {
    try {
        const [plans] = await db.query('SELECT * FROM revisions');
        const [historyRows] = await db.query('SELECT * FROM revisions_history ORDER BY data DESC');

        const revisions = plans.map(plan => {
            const ultimaAlteracao = parseJsonSafe(plan.ultimaAlteracao, 'ultimaAlteracao');
            // Se não tem vehicleId explícito, assume que o ID do plano é o vehicleId (migração antiga)
            const isImported = !plan.vehicleId;
            const effectiveVehicleId = isImported ? plan.id : plan.vehicleId;
            const { tipo, ...restOfPlan } = plan;
            
            // Processa o histórico para unificar a leitura visualmente para o frontend
            const historico = historyRows
                .filter(h => h.revisionId === plan.id)
                .map(h => ({
                    ...h,
                    // CRIAÇÃO DO CAMPO VIRTUAL 'km':
                    // O frontend espera 'h.km', então preenchemos com odometro ou horimetro dependendo do que existir
                    km: h.odometro || h.horimetro || 0 
                }));
            
            return {
                ...restOfPlan,
                vehicleId: effectiveVehicleId,
                // Prioriza a coluna 'descricao' se existir, senão usa 'tipo' (legado)
                descricao: plan.descricao || tipo || '', 
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
    // Sanitização e Preparação dos Dados
    const data = { 
        ...req.body,
        id: uuidv4(), // Gera ID manualmente
        // Sanitização dos campos numéricos/data para evitar erro de string vazia
        proximaRevisaoData: sanitize(req.body.proximaRevisaoData),
        proximaRevisaoOdometro: sanitize(req.body.proximaRevisaoOdometro),
        proximaRevisaoHorimetro: sanitize(req.body.proximaRevisaoHorimetro),
        avisoAntecedenciaKmHr: sanitize(req.body.avisoAntecedenciaKmHr),
        avisoAntecedenciaDias: sanitize(req.body.avisoAntecedenciaDias)
    };
    
    // Remove campos que não são colunas do banco
    delete data.historico; 
    
    // Campo tipo mantido para retrocompatibilidade se necessário
    if (!data.tipo && data.descricao) data.tipo = data.descricao;

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

// --- PUT: Atualizar Plano (Agendamento/Edição) ---
const updateRevisionPlan = async (req, res) => {
    const { id: vehicleId } = req.params; 
    
    // Sanitização completa
    const data = { 
        ...req.body,
        proximaRevisaoData: sanitize(req.body.proximaRevisaoData),
        proximaRevisaoOdometro: sanitize(req.body.proximaRevisaoOdometro),
        proximaRevisaoHorimetro: sanitize(req.body.proximaRevisaoHorimetro),
        avisoAntecedenciaKmHr: sanitize(req.body.avisoAntecedenciaKmHr),
        avisoAntecedenciaDias: sanitize(req.body.avisoAntecedenciaDias)
    };

    // Remove campos que não devem ir para o update/insert
    delete data.id; 
    delete data.vehicleId; 
    delete data.historico;

    // Garante que 'tipo' tenha valor se for usado no banco
    if (!data.tipo && data.descricao) data.tipo = data.descricao;

    const ultimaAlteracao = JSON.stringify({
        userId: req.user?.id || 'sistema',
        userEmail: req.user?.email || 'sistema',
        timestamp: new Date().toISOString()
    });
    data.ultimaAlteracao = ultimaAlteracao;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Verifica se já existe plano para este veículo
        const [rows] = await connection.execute(
            'SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', 
            [vehicleId, vehicleId]
        );
        
        if (rows.length > 0) {
            // Atualiza existente
            const revisionId = rows[0].id;
            
            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            
            if (fields.length > 0) {
                const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;
                await connection.execute(query, [...values, revisionId]);
            }
        } else {
            // Cria novo se não existir (ID Manual)
            const newPlan = { 
                id: uuidv4(), // Gera ID manualmente
                vehicleId: vehicleId, 
                ...data
            };
            
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

// --- POST: Concluir Revisão ---
const completeRevision = async (req, res) => {
    const vehicleId = req.params.id || req.body.vehicleId || req.body.id;

    if (!vehicleId) {
        console.error('Erro 400: vehicleId não fornecido.', req.body);
        return res.status(400).json({ error: 'ID do veículo é obrigatório.' });
    }

    const { 
        realizadaEm, 
        realizadaPor, 
        leituraRealizada, 
        descricao, 
        custo, 
        notaFiscal,
        proximaRevisaoData,
        proximaRevisaoLeitura,
        avisoAntecedenciaKmHr,
        avisoAntecedenciaDias
    } = req.body;

    // Sanitização
    const sanitizedProximaData = sanitize(proximaRevisaoData);
    const sanitizedProximaLeitura = sanitize(proximaRevisaoLeitura);
    const sanitizedAvisoKmHr = sanitize(avisoAntecedenciaKmHr);
    const sanitizedAvisoDias = sanitize(avisoAntecedenciaDias);

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Identificar ou Criar o Plano de Revisão
        let revisionId;
        const [revRows] = await connection.execute('SELECT * FROM revisions WHERE vehicleId = ?', [vehicleId]);
        
        if (revRows.length > 0) {
            revisionId = revRows[0].id;
        } else {
            // Criação de plano (ID Manual)
            revisionId = uuidv4(); // Gera ID manualmente
            const initialPlan = {
                id: revisionId,
                vehicleId: vehicleId,
                tipo: 'Manutenção Inicial',
                descricao: 'Manutenção Inicial', // Salva descrição também
                proximaRevisaoData: sanitizedProximaData,
                proximaRevisaoOdometro: null,
                proximaRevisaoHorimetro: null,
                avisoAntecedenciaKmHr: sanitizedAvisoKmHr,
                avisoAntecedenciaDias: sanitizedAvisoDias,
                ultimaAlteracao: JSON.stringify({ userId: 'sistema', action: 'Auto-create on complete' })
            };

            const fields = Object.keys(initialPlan);
            const values = Object.values(initialPlan);
            const placeholders = fields.map(() => '?').join(', ');
            
            await connection.execute(
                `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`, 
                values
            );
        }

        const [vehRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);
        if (vehRows.length === 0) throw new Error('Veículo não encontrado.');
        const vehicle = vehRows[0];

        const isHourBased = vehicle.mediaCalculo === 'horimetro';

        // 2. Registrar no Histórico
        // ALTERADO: Removido 'id: uuidv4()' pois causava 'Data truncated' em bancos onde 'id' é INT/Auto-Increment
        const historyData = {
            revisionId: revisionId,
            data: realizadaEm,
            descricao: descricao || 'Revisão Concluída',
            realizadaPor: realizadaPor
            // custo e notaFiscal removidos até que as colunas existam
        };

        if (isHourBased) {
            historyData.horimetro = leituraRealizada;
        } else {
            historyData.odometro = leituraRealizada;
        }

        const histFields = Object.keys(historyData);
        const histValues = Object.values(historyData);
        const histPlaceholders = histFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO revisions_history (${histFields.join(', ')}) VALUES (${histPlaceholders})`, 
            histValues
        );

        // 3. Atualizar Plano para a Próxima
        let updatePlanQuery = 'UPDATE revisions SET proximaRevisaoData = ?';
        const updatePlanParams = [sanitizedProximaData];

        if (isHourBased) {
            updatePlanQuery += ', proximaRevisaoHorimetro = ?';
            updatePlanParams.push(sanitizedProximaLeitura);
        } else {
            updatePlanQuery += ', proximaRevisaoOdometro = ?';
            updatePlanParams.push(sanitizedProximaLeitura);
        }

        if (req.body.avisoAntecedenciaKmHr !== undefined) {
            updatePlanQuery += ', avisoAntecedenciaKmHr = ?';
            updatePlanParams.push(sanitizedAvisoKmHr);
        }
        if (req.body.avisoAntecedenciaDias !== undefined) {
            updatePlanQuery += ', avisoAntecedenciaDias = ?';
            updatePlanParams.push(sanitizedAvisoDias);
        }
        
        // Atualiza também a descrição no plano principal para refletir o último agendamento/status
        if (descricao) {
            updatePlanQuery += ', descricao = ?';
            updatePlanParams.push(descricao);
        }

        const ultimaAlteracao = JSON.stringify({
             userId: req.user?.id || 'sistema',
             userEmail: req.user?.email || 'sistema',
             timestamp: new Date().toISOString(),
             action: 'Conclusão de Revisão'
        });
        
        updatePlanQuery += ', ultimaAlteracao = ? WHERE id = ?';
        updatePlanParams.push(ultimaAlteracao);
        updatePlanParams.push(revisionId);

        await connection.execute(updatePlanQuery, updatePlanParams);

        // 4. Atualizar Leitura do Veículo (REGRA GLOBAL 8, 10, 11)
        const readingVal = parseFloat(leituraRealizada);
        
        if (!isNaN(readingVal) && readingVal > 0) {
            let updateVehicleQuery = '';
            
            if (isHourBased) {
                // Atualiza horimetro e LIMPA legados para evitar conflito futuro
                updateVehicleQuery = `
                    UPDATE vehicles 
                    SET horimetro = ?, 
                        horimetroDigital = NULL, 
                        horimetroAnalogico = NULL 
                    WHERE id = ?`;
                await connection.execute(updateVehicleQuery, [readingVal, vehicleId]);
            } else {
                updateVehicleQuery = 'UPDATE vehicles SET odometro = ? WHERE id = ?';
                await connection.execute(updateVehicleQuery, [readingVal, vehicleId]);
            }
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