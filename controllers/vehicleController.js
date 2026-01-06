const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs'); 
const path = require('path'); 

// --- FUNÇÕES AUXILIARES ---

const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; 
    
    if (typeof field === 'string' && (field.startsWith('{') || field.startsWith('['))) {
        try {
            const parsed = JSON.parse(field);
            return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
        } catch (e) {
            console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
            return defaultValue; 
        }
    }
    
    // Se for string simples e não parecer JSON, retorna o valor padrão (null) ou o próprio valor dependendo da lógica
    return defaultValue;
};

const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    
    return newVehicle;
};

// --- CRUD BÁSICO ---

const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        const vehicles = rows.map(parseVehicleJsonFields);
        res.json(vehicles);
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        
        const vehicle = parseVehicleJsonFields(rows[0]);
        
        // Carrega histórico unificado (limitado a 50 para performance)
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ? ORDER BY startDate DESC LIMIT 50', [req.params.id]);
        vehicle.history = historyRows.map(h => ({
            ...h,
            details: parseJsonSafe(h.details, 'history.details')
        }));
        
        res.json(vehicle);
    } catch (error) {
        console.error('Erro ao buscar veículo:', error);
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

const createVehicle = async (req, res) => {
    const data = req.body;
    
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    delete data.history; 

    data.id = randomUUID();
    
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        res.status(201).json({ ...req.body, id: data.id }); 
    } catch (error) {
        console.error('Erro ao criar veículo:', error);
        res.status(500).json({ error: 'Erro ao criar veículo' });
    }
};

const updateVehicle = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.maintenanceLocation) data.maintenanceLocation = JSON.stringify(data.maintenanceLocation);
    if (data.operationalAssignment) data.operationalAssignment = JSON.stringify(data.operationalAssignment);
    
    delete data.history;

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = fields.map(field => data[field]);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE vehicles SET ${setClause} WHERE id = ?`;
    
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum dado para atualizar.' });

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Veículo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar veículo:', error);
        res.status(500).json({ error: 'Erro ao atualizar veículo' });
    }
};

// --- UPLOAD DE IMAGEM ---

const uploadVehicleImage = async (req, res) => {
    const { id } = req.params; 
    
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
    }

    const fotoURL = `/uploads/${req.file.filename}`; 

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT fotoURL FROM vehicles WHERE id = ?', [id]);
        
        if (rows.length > 0 && rows[0].fotoURL) {
            const oldFotoURL = rows[0].fotoURL; 
            const oldLocalPath = path.resolve(process.cwd(), 'public', oldFotoURL.substring(1)); 

            try {
                if (fs.existsSync(oldLocalPath)) {
                    fs.unlinkSync(oldLocalPath); 
                }
            } catch (unlinkError) {
                console.warn(`[Upload] Aviso: Falha ao deletar imagem antiga.`, unlinkError.message);
            }
        }

        await connection.execute('UPDATE vehicles SET fotoURL = ? WHERE id = ?', [fotoURL, id]);
        
        await connection.commit();
        res.json({ message: 'Upload bem-sucedido!', fotoURL: fotoURL });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar URL da imagem no banco:', error);
        res.status(500).json({ error: 'Erro ao salvar a imagem.' });
    } finally {
        connection.release();
    }
};

const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [req.params.id]);
        if (revisions.length > 0) {
            const revisionIds = revisions.map(r => r.id);
            const placeholders = revisionIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM revisions_history WHERE revisionId IN (${placeholders})`, revisionIds);
            await connection.execute(`DELETE FROM revisions WHERE id IN (${placeholders})`, revisionIds);
        }
        
        await connection.execute('DELETE FROM vehicles WHERE id = ?', [req.params.id]);
        
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao deletar veículo:', error);
        res.status(500).json({ error: 'Erro ao deletar veículo' });
    } finally {
        connection.release();
    }
};

// --- ALOCAÇÃO EM OBRA ---

const allocateToObra = async (req, res) => {
    const { id } = req.params; 
    const { obraId, employeeId, dataEntrada, readingType, readingValue, observacoes } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
        const [employeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);

        const obra = obraRows[0];
        const employee = employeeRows[0];
        const vehicle = vehicleRows[0];

        if (!obra || !employee) throw new Error("Dados de Obra ou Funcionário inválidos.");
        
        // 1. Inserir no Histórico Geral (vehicle_history)
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: new Date(dataEntrada || new Date()),
            endDate: null,
            details: JSON.stringify({ 
                obraId: obraId,
                obraNome: obra.nome,
                employeeId: employeeId,
                employeeName: employee.nome,
                [`${readingType}Entrada`]: readingValue,
                observacoes: observacoes
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', '); 

        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        // 2. Atualizar Veículo (Status e Localização)
        const vehicleUpdateData = {
            obraAtualId: obraId,
            status: 'Em Obra',
            localizacaoAtual: obra.nome,
            operationalAssignment: null, 
            maintenanceLocation: null, 
            alocadoEm: JSON.stringify({
                type: 'obra',
                id: obraId,
                nome: obra.nome
            }),
            [readingType]: readingValue 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        // 3. Atualizar Funcionário
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        // 4. Inserir no Histórico de Obras (Relacional - Legado/Compatibilidade)
        const newObraHistoryEntryData = {
            id: randomUUID(),
            obraId: obraId,
            veiculoId: vehicle.id,
            tipo: vehicle.tipo,
            registroInterno: vehicle.registroInterno,
            placa: vehicle.placa,
            modelo: `${vehicle.marca} ${vehicle.modelo}`,
            employeeId: employeeId,
            employeeName: employee.nome,
            dataEntrada: new Date(dataEntrada || new Date()),
            dataSaida: null,
            odometroEntrada: readingType === 'odometro' ? readingValue : null,
            odometroSaida: null,
            horimetroEntrada: readingType === 'horimetro' ? readingValue : null,
            horimetroSaida: null,
            observacoes: observacoes
        };
        
        const obraHistoryFields = Object.keys(newObraHistoryEntryData);
        const obraHistoryValues = Object.values(newObraHistoryEntryData);
        const obraHistoryPlaceholders = obraHistoryFields.map(() => '?').join(', '); 

        await connection.execute(
            `INSERT INTO obras_historico_veiculos (${obraHistoryFields.join(', ')}) VALUES (${obraHistoryPlaceholders})`, 
            obraHistoryValues
        );

        await connection.commit();
        res.status(200).json({ message: 'Veículo alocado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo:", error);
        res.status(500).json({ error: 'Falha ao alocar veículo.', details: error.message });
    } finally {
        connection.release();
    }
};

// --- DESALOCAÇÃO DE OBRA (CORRIGIDA E ROBUSTA) ---
// AQUI ESTAVA O ERRO 500: O throw new Error foi removido e substituído por lógica tolerante a falhas

const deallocateFromObra = async (req, res) => {
    const { id } = req.params; 
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra, observacoes, obraId } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida || new Date());

        // 1. Identificar Obra Atual (Prioridade: Payload > Banco)
        let targetObraId = obraId;
        if (!targetObraId) {
            const [vRows] = await connection.execute('SELECT obraAtualId FROM vehicles WHERE id = ?', [id]);
            if (vRows.length > 0) targetObraId = vRows[0].obraAtualId;
        }

        // 2. Atualizar Histórico Geral (vehicle_history) - MODO ROBUSTO
        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'obra']
        );
        
        let employeeIdToRelease = null;

        if (historyRows && historyRows.length > 0) {
            const activeHistory = historyRows[0];
            const historyDetails = parseJsonSafe(activeHistory.details, 'history.details') || {};
            employeeIdToRelease = historyDetails.employeeId;

            // Se não tinhamos obraId, tenta pegar do histórico
            if (!targetObraId) targetObraId = historyDetails.obraId;

            const newDetails = {
                ...historyDetails,
                [`${readingType}Saida`]: readingValue,
                observacoesSaida: observacoes
            };
            
            await connection.execute(
                'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
                [exitTimestamp, JSON.stringify(newDetails), activeHistory.id]
            );
        } else {
            console.warn(`[Desalocação] Aviso: Nenhum histórico ativo encontrado em 'vehicle_history' para o veículo ${id}. Prosseguindo para limpeza das tabelas legadas.`);
        }

        // 3. Atualizar Veículo (Libera status)
        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location || 'Pátio', 
            alocadoEm: null,
            [readingType]: readingValue, 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        // 4. Liberar Funcionário (se encontrado)
        if (employeeIdToRelease) {
             await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdToRelease]);
        }
        
        // 5. Atualizar Histórico Relacional de Obras (obras_historico_veiculos)
        if (targetObraId) {
            const obraHistoryUpdateFields = ['dataSaida = ?'];
            const obraHistoryUpdateValues = [exitTimestamp];

            if (readingType === 'odometro') {
                obraHistoryUpdateFields.push('odometroSaida = ?');
                obraHistoryUpdateValues.push(readingValue);
            } else {
                obraHistoryUpdateFields.push('horimetroSaida = ?');
                obraHistoryUpdateValues.push(readingValue);
            }

            if (observacoes) {
                obraHistoryUpdateFields.push('observacoes = CONCAT(COALESCE(observacoes, ""), " | Saída: ", ?)');
                obraHistoryUpdateValues.push(observacoes);
            }

            obraHistoryUpdateValues.push(id); // WHERE veiculoId
            obraHistoryUpdateValues.push(targetObraId); // WHERE obraId

            await connection.execute(
                `UPDATE obras_historico_veiculos 
                 SET ${obraHistoryUpdateFields.join(', ')} 
                 WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
                obraHistoryUpdateValues
            );
        }
        
        // 6. Finalizar Obra (Se solicitado)
        if (shouldFinalizeObra && targetObraId) {
            const obraUpdate = { 
                status: 'finalizada', 
                dataFim: new Date(dataFimObra || new Date())
            };

            const obraUpdateFields = Object.keys(obraUpdate);
            const obraUpdateValues = Object.values(obraUpdate);
            const obraSetClause = obraUpdateFields.map(field => `${field} = ?`).join(', ');

            await connection.execute(
                `UPDATE obras SET ${obraSetClause} WHERE id = ?`,
                [...obraUpdateValues, targetObraId]
            );
        }

        await connection.commit();
        res.status(200).json({ message: 'Veículo desalocado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao desalocar veículo:", error);
        res.status(500).json({ error: 'Falha ao desalocar veículo.', details: error.message });
    } finally {
        connection.release();
    }
};

// --- OUTRAS ALOCAÇÕES (MANUTENÇÃO / OPERACIONAL) ---

const assignToOperational = async (req, res) => {
    const { id } = req.params; 
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        if (!employeeId) throw new Error('ID do funcionário não pode ser vazio.');

        const now = new Date();
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );
        
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        const employeeName = selectedEmployeeRows[0]?.nome;
        
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'operacional',
            startDate: now,
            endDate: null,
            details: JSON.stringify({
                subGroup,
                employeeId,
                employeeName,
                observacoes,
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        const operationalAssignment = { 
            subGroup, 
            employeeId, 
            employeeName, 
            startDate: now 
        };

        const vehicleUpdateData = {
            operationalAssignment: JSON.stringify(operationalAssignment),
            status: 'Em Operação',
            obraAtualId: null,
            maintenanceLocation: null,
            alocadoEm: JSON.stringify({
                type: 'operacional',
                subGroup: subGroup,
                employeeName: employeeName
            }),
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeId]);

        await connection.commit();
        res.status(200).json({ message: 'Veículo alocado para operação.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo para operação:", error); 
        res.status(500).json({ error: 'Falha ao alocar o veículo.' });
    } finally {
        connection.release();
    }
};

const unassignFromOperational = async (req, res) => {
    const { id } = req.params; 
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();

        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'operacional']
        );
        const activeHistory = historyRows[0];
        
        if (activeHistory) { 
            await connection.execute(
                'UPDATE vehicle_history SET endDate = ? WHERE id = ?',
                [now, activeHistory.id]
            );
        }

        const vehicleUpdateData = { 
            operationalAssignment: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
            alocadoEm: null,
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        if (activeHistory?.details) {
             const details = parseJsonSafe(activeHistory.details, 'history.details'); 
             if (details?.employeeId) {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [details.employeeId]);
             }
        }
        
        await connection.commit();
        res.status(200).json({ message: 'Alocação operacional finalizada.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar alocação:", error);
        res.status(500).json({ error: 'Falha ao finalizar a alocação.' });
    } finally {
        connection.release();
    }
};

const startMaintenance = async (req, res) => {
    const { id } = req.params; 
    const { status, location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );

        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'manutencao',
            startDate: now,
            endDate: null,
            details: JSON.stringify({
                status: status,
                location: location,
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        const vehicleUpdateData = {
            status: status,
            maintenanceLocation: JSON.stringify(maintenanceLocation),
            obraAtualId: null,
            operationalAssignment: null,
            alocadoEm: JSON.stringify({
                type: 'manutencao',
                location: location,
                status: status
            }),
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        await connection.commit();
        res.status(200).json({ message: 'Status de manutenção atualizado.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao iniciar manutenção:", error);
        res.status(500).json({ error: 'Falha ao iniciar a manutenção.' });
    } finally {
        connection.release();
    }
};

const endMaintenance = async (req, res) => {
    const { id } = req.params; 
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [now, id, 'manutencao']
        );

        const vehicleUpdateData = {
            status: 'Disponível',
            maintenanceLocation: null,
            localizacaoAtual: location,
            alocadoEm: null,
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        await connection.commit();
        res.status(200).json({ message: 'Manutenção finalizada.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar manutenção:", error);
        res.status(500).json({ error: 'Falha ao finalizar a manutenção.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllVehicles,
    getVehicleById,
    createVehicle,
    updateVehicle,
    uploadVehicleImage,
    deleteVehicle,
    allocateToObra,
    deallocateFromObra,
    assignToOperational,
    unassignFromOperational,
    startMaintenance,
    endMaintenance
};