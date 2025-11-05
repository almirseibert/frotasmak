// controllers/vehicleController.js
const db = require('../database');
const { randomUUID } = require('crypto'); // Importar o gerador de UUID

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro (parseJsonSafe) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field; 
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        return null; 
    }
};

// --- Função Auxiliar para processar campos JSON de um veículo ---
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    return newVehicle;
};

// --- FUNÇÃO HELPER: Busca e retorna um veículo completo por ID ---
// Usada para retornar o objeto atualizado após uma mutação
const getFullVehicleById = async (vehicleId) => {
    const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);
    if (rows.length === 0) {
        throw new Error('Veículo não encontrado após a atualização.');
    }
    
    const vehicle = parseVehicleJsonFields(rows[0]);
    
    const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ? ORDER BY startDate DESC', [vehicleId]);
    vehicle.history = historyRows.map(h => ({
        ...h,
        details: parseJsonSafe(h.details, 'history.details')
    }));
    
    return vehicle;
};


// --- READ: Obter todos os veículos ---
const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history');
        
        const vehicles = rows.map(v => {
            const vehicle = parseVehicleJsonFields(v);
            vehicle.history = historyRows
                .filter(h => h.vehicleId === vehicle.id)
                .map(h => ({
                    ...h,
                    details: parseJsonSafe(h.details, 'history.details')
                }))
                .sort((a, b) => new Date(b.startDate) - new Date(a.startDate)); // Ordena
            return vehicle;
        });
        
        res.json(vehicles);
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

// --- READ: Obter um único veículo por ID ---
const getVehicleById = async (req, res) => {
    try {
        const vehicle = await getFullVehicleById(req.params.id);
        res.json(vehicle);
    } catch (error) {
        console.error('Erro ao buscar veículo:', error);
        if (error.message.includes('não encontrado')) {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

// --- CREATE: Criar um novo veículo ---
const createVehicle = async (req, res) => {
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    delete data.history; 

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        // Retorna o veículo recém-criado
        const newVehicle = await getFullVehicleById(result.insertId);
        res.status(201).json(newVehicle);
    } catch (error) {
        console.error('Erro ao criar veículo:', error);
        res.status(500).json({ error: 'Erro ao criar veículo' });
    }
};

// --- UPDATE: Atualizar um veículo existente ---
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

    try {
        await db.execute(query, [...values, id]);
        // Retorna o veículo atualizado
        const updatedVehicle = await getFullVehicleById(id);
        res.json(updatedVehicle);
    } catch (error) {
        console.error('Erro ao atualizar veículo:', error);
        res.status(500).json({ error: 'Erro ao atualizar veículo' });
    }
};

// --- DELETE: Deletar um veículo (com remoção em cascata) ---
const deleteVehicle = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [id]);
        if (revisions.length > 0) {
            await connection.execute('DELETE FROM revisions WHERE vehicleId = ?', [id]);
        }
        await connection.execute('DELETE FROM vehicles WHERE id = ?', [id]);
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


// -------------------------------------------------------------------------
// ROTAS DE ALOCAÇÃO (CORRIGIDAS PARA RETORNAR O OBJETO ATUALIZADO)
// -------------------------------------------------------------------------

const allocateToObra = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { obraId, employeeId, dataEntrada, readingType, readingValue } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
        const [employeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        const obra = obraRows[0];
        const employee = employeeRows[0];
        if (!obra || !employee) throw new Error("Dados de obra ou funcionário inválidos.");
        
        // 1. Cria 'vehicle_history'
        const newHistoryEntry = {
            vehicleId: id, historyType: 'obra', startDate: new Date(), endDate: null,
            details: JSON.stringify({
                obraId: obraId, obraNome: obra.nome, employeeId: employeeId, employeeName: employee.nome,
                [`${readingType}Entrada`]: readingValue,
            })
        };
        const historyFields = Object.keys(newHistoryEntry);
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyFields.map(() => '?').join(', ')})`,
            Object.values(newHistoryEntry)
        );
        
        // 2. Atualiza 'vehicles'
        const vehicleUpdateData = {
            obraAtualId: obraId, status: 'Em Obra', localizacaoAtual: obra.nome,
            operationalAssignment: null, maintenanceLocation: null,
            alocadoEm: JSON.stringify({ type: 'obra', id: obraId, nome: obra.nome }),
            [readingType]: readingValue,
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );
        
        // 3. Atualiza 'employees'
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        // 4. Grava 'obras_historico_veiculos'
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = vehicleRows[0];
        const newObraHistoryEntryData = {
            id: randomUUID(), obraId: obraId, veiculoId: vehicle.id, tipo: vehicle.tipo,
            registroInterno: vehicle.registroInterno, placa: vehicle.placa, modelo: `${vehicle.marca} ${vehicle.modelo}`,
            employeeId: employeeId, employeeName: employee.nome, dataEntrada: new Date(dataEntrada), dataSaida: null,
            odometroEntrada: readingType === 'odometro' ? readingValue : null, odometroSaida: null,
            horimetroEntrada: (readingType === 'horimetro' || readingType === 'horimetroDigital') ? readingValue : null, horimetroSaida: null
        };
        const obraHistoryFields = Object.keys(newObraHistoryEntryData);
        await connection.execute(
            `INSERT INTO obras_historico_veiculos (${obraHistoryFields.join(', ')}) VALUES (${obraHistoryFields.map(() => '?').join(', ')})`,
            Object.values(newObraHistoryEntryData)
        );

        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo:", error);
        res.status(500).json({ error: 'Falha ao alocar veículo.' });
    } finally {
        connection.release();
    }
};

const deallocateFromObra = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida);

        // 1. Atualiza 'vehicle_history'
        const [historyRows] = await connection.execute('SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL', [id, 'obra']);
        if (!historyRows || historyRows.length === 0) throw new Error('Nenhum histórico de alocação em obra ativo encontrado.');
        const activeHistory = historyRows[0];
        const historyDetails = parseJsonSafe(activeHistory?.details, 'history.details') || {};
        const obraIdFromHistory = historyDetails.obraId;
        const employeeIdFromHistory = historyDetails.employeeId;
        if (!obraIdFromHistory) throw new Error('ID da obra não encontrado no histórico ativo.');

        const newDetails = { ...historyDetails, [`${readingType}Saida`]: readingValue };
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
            [exitTimestamp, JSON.stringify(newDetails), activeHistory.id]
        );

        // 2. Atualiza 'vehicles'
        const vehicleUpdateData = {
            obraAtualId: null, status: 'Disponível', localizacaoAtual: location, 
            alocadoEm: null, [readingType]: readingValue,
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );

        // 3. Atualiza 'employees'
        if (employeeIdFromHistory) {
             await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdFromHistory]);
        }
        
        // 4. Atualiza 'obras_historico_veiculos'
        const obraHistoryUpdateFields = ['dataSaida = ?'];
        const obraHistoryUpdateValues = [exitTimestamp];
        if (readingType === 'odometro') {
            obraHistoryUpdateFields.push('odometroSaida = ?'); obraHistoryUpdateValues.push(readingValue);
        } else if (readingType === 'horimetro' || readingType === 'horimetroDigital') {
            obraHistoryUpdateFields.push('horimetroSaida = ?'); obraHistoryUpdateValues.push(readingValue);
        }
        obraHistoryUpdateValues.push(id); // vehicleId
        obraHistoryUpdateValues.push(obraIdFromHistory); // obraId

        await connection.execute(
            `UPDATE obras_historico_veiculos SET ${obraHistoryUpdateFields.join(', ')} WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
            obraHistoryUpdateValues
        );
        
        // 5. Finaliza 'obras' (se aplicável)
        if (shouldFinalizeObra) {
            await connection.execute(
                `UPDATE obras SET status = 'finalizada', dataFim = ? WHERE id = ?`,
                [new Date(dataFimObra), obraIdFromHistory]
            );
        }

        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

    } catch (error) {
        await connection.rollback();
        console.error("Erro ao desalocar veículo:", error);
        res.status(500).json({ error: 'Falha ao desalocar veículo.' });
    } finally {
        connection.release();
    }
};

const assignToOperational = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico anterior
        await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL', [now, id]);
        
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        const employeeName = selectedEmployeeRows[0]?.nome;
        if (!employeeName) throw new Error('Funcionário selecionado não encontrado.');
        
        // 2. Cria nova entrada de histórico
        const newHistoryEntry = {
            vehicleId: id, historyType: 'operacional', startDate: now, endDate: null,
            details: JSON.stringify({ subGroup, employeeId, employeeName, observacoes })
        };
        const historyFields = Object.keys(newHistoryEntry);
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyFields.map(() => '?').join(', ')})`,
            Object.values(newHistoryEntry)
        );
        
        // 3. Prepara dados da alocação para 'vehicles'
        const operationalAssignment = { subGroup, employeeId, employeeName, startDate: now };

        // 4. Atualiza 'vehicles'
        const vehicleUpdateData = {
            operationalAssignment: JSON.stringify(operationalAssignment), status: 'Em Operação',
            obraAtualId: null, maintenanceLocation: null,
            alocadoEm: JSON.stringify({ type: 'operacional', subGroup: subGroup, employeeName: employeeName }),
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );
        
        // 5. Atualiza 'employees'
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeId]);

        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo para operação:", error);
        res.status(500).json({ error: 'Falha ao alocar o veículo.' });
    } finally {
        connection.release();
    }
};

const unassignFromOperational = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();

        // 1. Busca funcionário
        const [historyRows] = await connection.execute('SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL', [id, 'operacional']);
        const activeHistory = historyRows[0];
        
        // 2. Finaliza histórico
        await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE id = ?', [now, activeHistory.id]);

        // 3. Atualiza 'vehicles'
        const vehicleUpdateData = { 
            operationalAssignment: null, status: 'Disponível', 
            localizacaoAtual: location, alocadoEm: null,
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );

        // 4. Atualiza 'employees'
        if (activeHistory?.details) {
             const details = parseJsonSafe(activeHistory.details, 'history.details');
             if (details?.employeeId) {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [details.employeeId]);
             }
        }
        
        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar alocação:", error);
        res.status(500).json({ error: 'Falha ao finalizar a alocação.' });
    } finally {
        connection.release();
    }
};

const startMaintenance = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { status, location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico anterior
        await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL', [now, id]);

        // 2. Cria nova entrada de histórico
        const newHistoryEntry = {
            vehicleId: id, historyType: 'manutencao', startDate: now, endDate: null,
            details: JSON.stringify({ status: status, location: location, details: `Entrada em manutenção (${status}) em ${location}` })
        };
        const historyFields = Object.keys(newHistoryEntry);
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyFields.map(() => '?').join(', ')})`,
            Object.values(newHistoryEntry)
        );
        
        // 3. Prepara dados da manutenção
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        // 4. Atualiza 'vehicles'
        const vehicleUpdateData = {
            status: status, maintenanceLocation: JSON.stringify(maintenanceLocation),
            obraAtualId: null, operationalAssignment: null,
            alocadoEm: JSON.stringify({ type: 'manutencao', location: location, status: status }),
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );

        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

    } catch (error) {
        await connection.rollback();
        console.error("Erro ao iniciar manutenção:", error);
        res.status(500).json({ error: 'Falha ao iniciar a manutenção.' });
    } finally {
        connection.release();
    }
};

const endMaintenance = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [now, id, 'manutencao']
        );

        // 2. Atualiza 'vehicles'
        const vehicleUpdateData = {
            status: 'Disponível', maintenanceLocation: null,
            localizacaoAtual: location, alocadoEm: null,
        };
        const updateFields = Object.keys(vehicleUpdateData);
        await connection.execute(
            `UPDATE vehicles SET ${updateFields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...Object.values(vehicleUpdateData), id]
        );

        await connection.commit();
        
        // *** CORREÇÃO: Busca e retorna o veículo atualizado ***
        const updatedVehicle = await getFullVehicleById(id);
        res.status(200).json(updatedVehicle);

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
    deleteVehicle,
    allocateToObra,
    deallocateFromObra,
    assignToOperational,
    unassignFromOperational,
    startMaintenance,
    endMaintenance
};