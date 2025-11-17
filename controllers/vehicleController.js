// controllers/vehicleController.js
const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs'); // File System para deletar imagem antiga se houver
const path = require('path'); // Importar o Path

// ... (parseJsonSafe está correto, sem mudanças) ...
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; // Já é um objeto
    
    if (typeof field === 'string' && (field.startsWith('{') || field.startsWith('['))) {
        try {
            const parsed = JSON.parse(field);
            return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
        } catch (e) {
            console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
            return defaultValue; 
        }
    }
    
    if (typeof field === 'string') {
        return defaultValue;
    }
    
    return defaultValue;
};

// ... (parseVehicleJsonFields está correto, sem mudanças) ...
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    
    return newVehicle;
};

// ... (getAllVehicles está correto, sem mudanças) ...
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
                }));
            return vehicle;
        });
        
        res.json(vehicles);
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

// ... (getVehicleById está correto, sem mudanças) ...
const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        
        const vehicle = parseVehicleJsonFields(rows[0]);
        
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ?', [req.params.id]);
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

// ... (createVehicle está correto, sem mudanças) ...
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

// ... (updateVehicle está correto, sem mudanças) ...
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
        res.json({ message: 'Veículo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar veículo:', error);
        res.status(500).json({ error: 'Erro ao atualizar veículo' });
    }
};

// --- NOVA FUNÇÃO: Upload de Imagem ---
const uploadVehicleImage = async (req, res) => {
    const { id } = req.params; // ID do veículo
    
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
    }

    // O multer salvou o arquivo em 'public/uploads'
    // O nome do arquivo é req.file.filename
    // Precisamos salvar o *caminho do URL* no banco
    const fotoURL = `/uploads/${req.file.filename}`; // Ex: /uploads/vehicle-123456789.jpg

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. (Opcional) Busca a foto antiga para deletar do servidor
        const [rows] = await connection.execute('SELECT fotoURL FROM vehicles WHERE id = ?', [id]);
        
        if (rows.length > 0 && rows[0].fotoURL) {
            const oldFotoURL = rows[0].fotoURL; // Ex: /uploads/old-image.jpg
            
            // --- CORREÇÃO DE PATH ---
            // Usa process.cwd() para garantir o caminho absoluto a partir da raiz do projeto
            const oldLocalPath = path.resolve(process.cwd(), 'public', oldFotoURL.substring(1)); 
            // --- FIM DA CORREÇÃO ---

            try {
                if (fs.existsSync(oldLocalPath)) {
                    fs.unlinkSync(oldLocalPath); 
                    console.log(`[Upload] Imagem antiga ${oldLocalPath} deletada.`);
                }
            } catch (unlinkError) {
                console.warn(`[Upload] Aviso: Falha ao deletar imagem antiga ${oldLocalPath}.`, unlinkError.message);
            }
        }

        // 2. Atualiza o banco com o novo URL
        await connection.execute('UPDATE vehicles SET fotoURL = ? WHERE id = ?', [fotoURL, id]);
        
        await connection.commit();
        
        // Retorna o novo URL para o frontend atualizar o estado
        res.json({ message: 'Upload bem-sucedido!', fotoURL: fotoURL });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar URL da imagem no banco:', error);
        res.status(500).json({ error: 'Erro ao salvar a imagem.' });
    } finally {
        connection.release();
    }
};


// ... (deleteVehicle está correto, sem mudanças) ...
const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', [req.params.id, req.params.id]);
        if (revisions.length > 0) {
            const revisionIds = revisions.map(r => r.id);
            await connection.execute(`DELETE FROM revisions_history WHERE revisionId IN (?)`, [revisionIds]);
            await connection.execute(`DELETE FROM revisions WHERE id IN (?)`, [revisionIds]);
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

// ... (allocateToObra está correto, sem mudanças) ...
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

        if (!obra || !employee) {
            throw new Error("Dados de obra ou funcionário inválidos.");
        }
        
        // 1. 'vehicle_history'
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: new Date(),
            endDate: null,
            details: JSON.stringify({ 
                obraId: obraId,
                obraNome: obra.nome,
                employeeId: employeeId,
                employeeName: employee.nome,
                [`${readingType}Entrada`]: readingValue,
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', '); 

        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        // 2. 'vehicles'
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
            [readingType]: readingValue, 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        // 3. 'employees'
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        // 4. 'obras_historico_veiculos'
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = vehicleRows[0];
        
        const newObraHistoryEntryData = {
            id: randomUUID(), // Correto
            obraId: obraId,
            veiculoId: vehicle.id,
            tipo: vehicle.tipo,
            registroInterno: vehicle.registroInterno,
            placa: vehicle.placa,
            modelo: `${vehicle.marca} ${vehicle.modelo}`,
            employeeId: employeeId,
            employeeName: employee.nome,
            dataEntrada: new Date(dataEntrada),
            dataSaida: null,
            odometroEntrada: readingType === 'odometro' ? readingValue : null,
            odometroSaida: null,
            horimetroEntrada: (readingType === 'horimetro' || readingType === 'horimetroDigital') ? readingValue : null,
            horimetroSaida: null
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
        res.status(500).json({ error: 'Falha ao alocar veículo.' });
    } finally {
        connection.release();
    }
};

// ... (deallocateFromObra está correto, sem mudanças) ...
const deallocateFromObra = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida);

        // 1. 'vehicle_history'
        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'obra']
        );
        
        if (!historyRows || historyRows.length === 0) {
            throw new Error('Nenhum histórico de alocação em obra ativo encontrado para este veículo.');
        }

        const activeHistory = historyRows[0];
        const historyDetails = parseJsonSafe(activeHistory?.details, 'history.details') || {};
        
        const obraIdFromHistory = historyDetails.obraId;
        const employeeIdFromHistory = historyDetails.employeeId;

        if (!obraIdFromHistory) {
            throw new Error('Não foi possível encontrar o ID da obra no histórico ativo. A desalocação falhou.');
        }

        const newDetails = {
            ...historyDetails,
            [`${readingType}Saida`]: readingValue
        };
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
            [exitTimestamp, JSON.stringify(newDetails), activeHistory.id]
        );

        // 2. 'vehicles'
        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
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

        // 3. 'employees'
        if (employeeIdFromHistory) {
             await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdFromHistory]);
        }
        
        // 4. 'obras_historico_veiculos'
        const obraHistoryUpdateFields = ['dataSaida = ?'];
        const obraHistoryUpdateValues = [exitTimestamp];

        if (readingType === 'odometro') {
            obraHistoryUpdateFields.push('odometroSaida = ?');
            obraHistoryUpdateValues.push(readingValue);
        } else if (readingType === 'horimetro' || readingType === 'horimetroDigital') {
            obraHistoryUpdateFields.push('horimetroSaida = ?');
            obraHistoryUpdateValues.push(readingValue);
        }

        obraHistoryUpdateValues.push(id); 
        obraHistoryUpdateValues.push(obraIdFromHistory); 

        await connection.execute(
            `UPDATE obras_historico_veiculos 
             SET ${obraHistoryUpdateFields.join(', ')} 
             WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
            obraHistoryUpdateValues
        );
        
        // 5. 'obras'
        if (shouldFinalizeObra) {
            const obraUpdate = { 
                status: 'finalizada', 
                dataFim: new Date(dataFimObra)
            };

            const obraUpdateFields = Object.keys(obraUpdate);
            const obraUpdateValues = Object.values(obraUpdate);
            const obraSetClause = obraUpdateFields.map(field => `${field} = ?`).join(', ');

            await connection.execute(
                `UPDATE obras SET ${obraSetClause} WHERE id = ?`,
                [...obraUpdateValues, obraIdFromHistory]
            );
        }

        await connection.commit();
        res.status(200).json({ message: 'Veículo desalocado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao desalocar veículo:", error);
        res.status(500).json({ error: 'Falha ao desalocar veículo.' });
    } finally {
        connection.release();
    }
};

// ... (assignToOperational está correto, sem mudanças) ...
const assignToOperational = async (req, res) => {
    const { id } = req.params; 
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        if (!employeeId) {
            throw new Error('ID do funcionário não pode ser vazio.');
        }

        const now = new Date();
        
        // 1. Finaliza histórico anterior
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );
        
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        
        if (!selectedEmployeeRows || selectedEmployeeRows.length === 0) {
            console.error(`Falha ao alocar: Funcionário com ID ${employeeId} não encontrado.`);
            throw new Error('Funcionário selecionado não encontrado no banco de dados.');
        }
        const employeeName = selectedEmployeeRows[0]?.nome;
        
        // 2. 'vehicle_history'
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
        
        // 3. 'vehicles' (operationalAssignment)
        const operationalAssignment = { 
            subGroup, 
            employeeId, 
            employeeName, 
            startDate: now 
        };

        // 4. 'vehicles' (status)
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
        
        // 5. 'employees'
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeId]);

        await connection.commit();
        res.status(200).json({ message: 'Veículo alocado para operação com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo para operação:", error.message); 
        res.status(500).json({ error: 'Falha ao alocar o veículo.', message: error.message });
    } finally {
        connection.release();
    }
};

// ... (unassignFromOperational está correto, sem mudanças) ...
const unassignFromOperational = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();

        // 1. 'vehicle_history'
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

        // 2. 'vehicles'
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

        // 3. 'employees'
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

// ... (startMaintenance está correto, sem mudanças) ...
const startMaintenance = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { status, location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico anterior
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );

        // 2. 'vehicle_history'
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
        
        // 3. 'vehicles' (maintenanceLocation)
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        // 4. 'vehicles' (status)
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
        res.status(500).json({ error: 'Falha ao iniciar a manutenção.', message: error.message });
    } finally {
        connection.release();
    }
};

// ... (endMaintenance está correto, sem mudanças) ...
const endMaintenance = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. 'vehicle_history'
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [now, id, 'manutencao']
        );

        // 2. 'vehicles'
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