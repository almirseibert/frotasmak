// controllers/vehicleController.js
const db = require('../database');

// --- Funções Auxiliares para JSON ---
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    if (newVehicle.fuelLevels) newVehicle.fuelLevels = JSON.parse(newVehicle.fuelLevels);
    if (newVehicle.alocadoEm) newVehicle.alocadoEm = JSON.parse(newVehicle.alocadoEm);
    if (newVehicle.history) newVehicle.history = JSON.parse(newVehicle.history);
    return newVehicle;
};

// --- READ: Obter todos os veículos ---
const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        res.json(rows.map(parseVehicleJsonFields));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

// --- READ: Obter um único veículo por ID ---
const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        const vehicle = rows[0];
        if (vehicle.fuelLevels) vehicle.fuelLevels = JSON.parse(vehicle.fuelLevels);
        if (vehicle.alocadoEm) vehicle.alocadoEm = JSON.parse(vehicle.alocadoEm);
        if (vehicle.history) vehicle.history = JSON.parse(vehicle.history);
        res.json(vehicle);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

// --- CREATE: Criar um novo veículo ---
const createVehicle = async (req, res) => {
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.history) data.history = JSON.stringify(data.history);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar veículo' });
    }
};

// --- UPDATE: Atualizar um veículo existente ---
const updateVehicle = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.history) data.history = JSON.stringify(data.history);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE vehicles SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Veículo atualizado com sucesso' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar veículo' });
    }
};

// --- DELETE: Deletar um veículo (com remoção em cascata) ---
const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [req.params.id]);
        if (revisions.length > 0) {
            await connection.execute('DELETE FROM revisions WHERE vehicleId = ?', [req.params.id]);
        }
        await connection.execute('DELETE FROM vehicles WHERE id = ?', [req.params.id]);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Erro ao deletar veículo' });
    } finally {
        connection.release();
    }
};


// -------------------------------------------------------------------------
// NOVAS ROTAS COM LÓGICA DE TRANSAÇÃO
// -------------------------------------------------------------------------

const allocateToObra = async (req, res) => {
    const { id } = req.params;
    const { obraId, employeeId, dataEntrada, readingType, readingValue } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);
        const obraRows = await connection.execute('SELECT * FROM obras WHERE id = ?', [obraId]);
        const obra = JSON.parse(JSON.stringify(obraRows[0][0]));
        const employeeRows = await connection.execute('SELECT * FROM employees WHERE id = ?', [employeeId]);
        const employee = JSON.parse(JSON.stringify(employeeRows[0][0]));

        if (!vehicle || !obra || !employee) {
            throw new Error("Dados de veículo, obra ou funcionário inválidos.");
        }

        const newHistoryEntry = {
            type: 'obra',
            startDate: new Date(),
            endDate: null,
            details: {
                obraId: obra.id,
                obraNome: obra.nome,
                employeeId: employee.id,
                employeeName: employee.nome,
                [`${readingType}Entrada`]: readingValue,
            }
        };

        const updatedHistory = vehicle.history || [];
        const lastEntry = updatedHistory.find(h => !h.endDate);
        if (lastEntry) {
            lastEntry.endDate = new Date();
        }
        updatedHistory.push(newHistoryEntry);
        
        const vehicleUpdateData = {
            obraAtualId: obraId,
            status: 'Em Obra',
            localizacaoAtual: obra.nome,
            operationalAssignment: null,
            maintenanceLocation: null,
            history: JSON.stringify(updatedHistory),
        };
        vehicleUpdateData[readingType] = readingValue;
        
        await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, id]);
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        const legacyHistoryEntry = { 
            veiculoId: vehicle.id, 
            placa: vehicle.placa, 
            tipo: vehicle.tipo, 
            registroInterno: vehicle.registroInterno, 
            modelo: `${vehicle.marca} ${vehicle.modelo}`, 
            dataEntrada: new Date(dataEntrada),
            dataSaida: null, 
            [`${readingType}Entrada`]: readingValue,
            [`${readingType}Saida`]: null,
            employeeId,
            employeeName: employee.nome,
        };
        const updatedObraHistory = obra.historicoVeiculos || [];
        updatedObraHistory.push(legacyHistoryEntry);
        await connection.execute('UPDATE obras SET historicoVeiculos = ? WHERE id = ?', [JSON.stringify(updatedObraHistory), obraId]);

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

const deallocateFromObra = async (req, res) => {
    const { id } = req.params;
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra, obraId } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);

        const exitTimestamp = new Date(dataSaida);

        const updatedHistory = (vehicle.history || []).map(h => {
            if (h.type === 'obra' && !h.endDate) {
                return { ...h, endDate: exitTimestamp, details: {...h.details, [`${readingType}Saida`]: readingValue} };
            }
            return h;
        });

        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
            history: JSON.stringify(updatedHistory),
        };
        vehicleUpdateData[readingType] = readingValue;
        
        await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, id]);

        const activeAssignment = (vehicle.history || []).find(h => h.type === 'obra' && !h.endDate);
        if (activeAssignment?.details?.employeeId) {
            await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [activeAssignment.details.employeeId]);
        }
        
        const [obraRows] = await connection.execute('SELECT * FROM obras WHERE id = ?', [obraId]);
        const obraData = JSON.parse(JSON.stringify(obraRows[0]));
        
        const legacyHistorico = obraData.historicoVeiculos || [];
        const updatedLegacyHistorico = legacyHistorico.map(h => {
            if (h.veiculoId === vehicle.id && !h.dataSaida) {
                return { ...h, dataSaida: exitTimestamp, [`${readingType}Saida`]: readingValue };
            }
            return h;
        });
        
        const obraUpdate = { historicoVeiculos: JSON.stringify(updatedLegacyHistorico) };
        if (shouldFinalizeObra) {
            obraUpdate.status = 'finalizada';
            obraUpdate.dataFim = new Date(dataFimObra);
        }
        await connection.execute('UPDATE obras SET ? WHERE id = ?', [obraUpdate, obraId]);

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

const assignToOperational = async (req, res) => {
    const { id } = req.params;
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);

        const now = new Date();
        const history = vehicle.history || [];
        const updatedHistory = history.map(h => {
            if (!h.endDate) { 
                return { ...h, endDate: now };
            }
            return h;
        });

        const selectedEmployee = await connection.execute('SELECT * FROM employees WHERE id = ?', [employeeId]);
        const employeeName = selectedEmployee[0][0].nome;
        
        const newHistoryEntry = {
            type: 'operacional',
            startDate: now,
            endDate: null,
            details: {
                subGroup,
                employeeId,
                employeeName,
                observacoes,
            }
        };
        updatedHistory.push(newHistoryEntry);
        
        const operationalAssignment = { 
            subGroup, 
            employeeId, 
            employeeName, 
            startDate: now 
        };

        await connection.execute('UPDATE vehicles SET operationalAssignment = ?, status = ?, obraAtualId = NULL, maintenanceLocation = NULL, history = ? WHERE id = ?', [
            JSON.stringify(operationalAssignment),
            'Em Operação',
            JSON.stringify(updatedHistory),
            id
        ]);
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeId]);

        await connection.commit();
        res.status(200).json({ message: 'Veículo alocado para operação com sucesso.' });
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
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);
        const now = new Date();
        
        const updatedHistory = (vehicle.history || []).map(h => {
            if (h.type === 'operacional' && !h.endDate) {
                return { ...h, endDate: now };
            }
            return h;
        });

        await connection.execute('UPDATE vehicles SET operationalAssignment = NULL, status = ?, localizacaoAtual = ?, history = ? WHERE id = ?', [
            'Disponível',
            location,
            JSON.stringify(updatedHistory),
            id
        ]);

        if (vehicle.operationalAssignment?.employeeId) {
            await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [vehicle.operationalAssignment.employeeId]);
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
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);
        const now = new Date();
        
        const history = vehicle.history || [];
        const updatedHistory = history.map(h => {
            if (!h.endDate) { 
                return { ...h, endDate: now };
            }
            return h;
        });

        const newHistoryEntry = {
            type: 'manutencao',
            startDate: now,
            endDate: null,
            details: `Entrada em manutenção (${status}) em ${location}`
        };
        updatedHistory.push(newHistoryEntry);
        
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        await connection.execute('UPDATE vehicles SET status = ?, maintenanceLocation = ?, history = ?, obraAtualId = NULL, operationalAssignment = NULL WHERE id = ?', [
            status,
            JSON.stringify(maintenanceLocation),
            JSON.stringify(updatedHistory),
            id
        ]);

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
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);
        const now = new Date();
        
        const history = vehicle.history || [];
        const updatedHistory = history.map(h => {
            if (h.type === 'manutencao' && !h.endDate) {
                return { ...h, endDate: now };
            }
            return h;
        });

        await connection.execute('UPDATE vehicles SET status = ?, maintenanceLocation = NULL, localizacaoAtual = ?, history = ? WHERE id = ?', [
            'Disponível',
            location,
            JSON.stringify(updatedHistory),
            id
        ]);

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
    deleteVehicle,
    allocateToObra,
    deallocateFromObra,
    assignToOperational,
    unassignFromOperational,
    startMaintenance,
    endMaintenance
};