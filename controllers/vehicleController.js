// controllers/vehicleController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro (parseJsonSafe) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    
    // Se já for um objeto/array (por exemplo, se o driver do MySQL já parseou a coluna JSON)
    if (typeof field === 'object') return field; 
    
    // Garante que é uma string antes de tentar o parse
    if (typeof field !== 'string') return field;

    try {
        // Tenta fazer o parse da string
        const parsed = JSON.parse(field);
        
        // Verifica se o resultado do parse é um objeto/array válido
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        // Retorna null em caso de erro, impedindo a quebra da aplicação.
        return null; 
    }
};

// --- Funções Auxiliares para JSON ---
// CORREÇÃO: Removido o parse da coluna 'history', pois ela não existe em 'vehicles'.
// Adicionado parse para as novas colunas JSON.
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    
    return newVehicle;
};

// --- READ: Obter todos os veículos ---
// CORREÇÃO: Agora busca o histórico da tabela 'vehicle_history' e anexa aos veículos.
const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history');
        
        const vehicles = rows.map(v => {
            const vehicle = parseVehicleJsonFields(v);
            // Anexa o histórico relevante a este veículo
            // CORREÇÃO: Parse 'details' do histórico
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

// --- READ: Obter um único veículo por ID ---
// CORREÇÃO: Também busca o histórico da tabela 'vehicle_history'.
const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        
        const vehicle = parseVehicleJsonFields(rows[0]);
        
        // Busca o histórico para este veículo
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ?', [req.params.id]);
        // CORREÇÃO: Parse 'details' do histórico
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

// --- CREATE: Criar um novo veículo ---
// CORREÇÃO: Removida a lógica de 'history'
const createVehicle = async (req, res) => {
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    // Remove 'history' se ele for enviado acidentalmente
    delete data.history; 

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar veículo:', error);
        res.status(500).json({ error: 'Erro ao criar veículo' });
    }
};

// --- UPDATE: Atualizar um veículo existente ---
// CORREÇÃO: Removida a lógica de 'history'
const updateVehicle = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.maintenanceLocation) data.maintenanceLocation = JSON.stringify(data.maintenanceLocation);
    if (data.operationalAssignment) data.operationalAssignment = JSON.stringify(data.operationalAssignment);
    
    // Remove 'history' se ele for enviado acidentalmente
    delete data.history;

    const fields = Object.keys(data).filter(key => key !== 'id');
    // CORREÇÃO: Filtra 'id' dos valores também
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

// --- DELETE: Deletar um veículo (com remoção em cascata) ---
// Esta função está correta, pois o DB (com 'ON DELETE CASCADE') cuida do 'vehicle_history'
const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        // Remove revisões (se não tiver cascade)
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [req.params.id]);
        if (revisions.length > 0) {
            await connection.execute('DELETE FROM revisions WHERE vehicleId = ?', [req.params.id]);
        }
        // Deleta o veículo (vehicle_history será deletado pelo ON DELETE CASCADE)
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


// -------------------------------------------------------------------------
// ROTAS DE ALOCAÇÃO (CORRIGIDAS)
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

        if (!obra || !employee) {
            throw new Error("Dados de obra ou funcionário inválidos.");
        }
        
        // 1. Cria a nova entrada de histórico na tabela 'vehicle_history'
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: new Date(),
            endDate: null,
            details: JSON.stringify({ // 'details' é um campo JSON
                obraId: obraId,
                obraNome: obra.nome,
                employeeId: employeeId,
                employeeName: employee.nome,
                [`${readingType}Entrada`]: readingValue,
            })
        };
        
        // CORREÇÃO da Sintaxe SQL (ER_PARSE_ERROR)
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');

        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        // 2. Prepara a atualização do veículo
        const vehicleUpdateData = {
            obraAtualId: obraId,
            status: 'Em Obra',
            localizacaoAtual: obra.nome,
            operationalAssignment: null, // Limpa outra alocação
            maintenanceLocation: null, // Limpa outra alocação
            [readingType]: readingValue, // Atualiza a leitura principal
        };
        
        // CORREÇÃO da Sintaxe SQL (ER_PARSE_ERROR)
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        // 3. Atualiza o funcionário
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        // 4. (Lógica legada de 'obras_historico_veiculos' - mantida por segurança)
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = vehicleRows[0];
        const [obraDataRows] = await connection.execute('SELECT historicoVeiculos FROM obras WHERE id = ?', [obraId]);
        const obraData = obraDataRows[0];
        
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
        const updatedObraHistory = parseJsonSafe(obraData.historicoVeiculos, 'obra.historicoVeiculos') || [];
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
    const { id } = req.params; // vehicleId
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra, obraId } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida);

        // 1. Atualiza a entrada de histórico em 'vehicle_history'
        // Busca a entrada ativa para pegar os 'details' antigos
        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'obra']
        );
        const activeHistory = historyRows[0];
        const newDetails = {
            ...(parseJsonSafe(activeHistory?.details, 'history.details') || {}),
            [`${readingType}Saida`]: readingValue
        };
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ?, details = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [exitTimestamp, JSON.stringify(newDetails), id, 'obra']
        );

        // 2. Atualiza o veículo
        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
            [readingType]: readingValue, // Atualiza leitura principal
        };
        
        // CORREÇÃO da Sintaxe SQL
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        // 3. Atualiza funcionário (se houver)
        if (activeHistory?.details) {
             const details = parseJsonSafe(activeHistory.details, 'history.details');
             if (details?.employeeId) {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [details.employeeId]);
             }
        }
        
        // 4. Atualiza 'obras' (lógica legada)
        const [obraDataRows] = await connection.execute('SELECT historicoVeiculos FROM obras WHERE id = ?', [obraId]);
        const obraData = obraDataRows[0];
        const legacyHistorico = parseJsonSafe(obraData.historicoVeiculos, 'obra.historicoVeiculos') || [];
        
        const updatedLegacyHistorico = legacyHistorico.map(h => {
            if (h.veiculoId === id && !h.dataSaida) {
                return { ...h, dataSaida: exitTimestamp, [`${readingType}Saida`]: readingValue };
            }
            return h;
        });
        
        const obraUpdate = { historicoVeiculos: JSON.stringify(updatedLegacyHistorico) };
        if (shouldFinalizeObra) {
            obraUpdate.status = 'finalizada';
            obraUpdate.dataFim = new Date(dataFimObra);
        }

        // CORREÇÃO da Sintaxe SQL (ER_PARSE_ERROR)
        const obraUpdateFields = Object.keys(obraUpdate);
        const obraUpdateValues = Object.values(obraUpdate);
        const obraSetClause = obraUpdateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE obras SET ${obraSetClause} WHERE id = ?`,
            [...obraUpdateValues, obraId]
        );

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
    const { id } = req.params; // vehicleId
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico anterior (se houver)
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );
        
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        const employeeName = selectedEmployeeRows[0]?.nome;
        
        if (!employeeName) {
            throw new Error('Funcionário selecionado não encontrado.');
        }
        
        // 2. Cria nova entrada de histórico
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
        
        // CORREÇÃO da Sintaxe SQL (ER_PARSE_ERROR)
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        // 3. Prepara dados da alocação para 'vehicles'
        const operationalAssignment = { 
            subGroup, 
            employeeId, 
            employeeName, 
            startDate: now 
        };

        // 4. Atualiza 'vehicles' (CORREÇÃO: sem 'history', sintaxe corrigida)
        const vehicleUpdateData = {
            operationalAssignment: JSON.stringify(operationalAssignment),
            status: 'Em Operação',
            obraAtualId: null,
            maintenanceLocation: null,
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        // 5. Atualiza 'employees'
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
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();

        // 1. Busca funcionário alocado antes de limpar
        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'operacional']
        );
        const activeHistory = historyRows[0];
        
        // 2. Finaliza histórico
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [now, id, 'operacional']
        );

        // 3. Atualiza 'vehicles' (CORREÇÃO: sintaxe corrigida)
        const vehicleUpdateData = { 
            operationalAssignment: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        // 4. Atualiza 'employees'
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

        // 2. Cria nova entrada de histórico
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'manutencao',
            startDate: now,
            endDate: null,
            details: JSON.stringify({ // Salva como JSON
                status: status,
                location: location,
                details: `Entrada em manutenção (${status}) em ${location}`
            })
        };
        
        // CORREÇÃO da Sintaxe SQL (ER_PARSE_ERROR)
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        // 3. Prepara dados da manutenção para 'vehicles'
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        // 4. Atualiza 'vehicles' (CORREÇÃO: sem 'history', sintaxe corrigida)
        const vehicleUpdateData = {
            status: status,
            maintenanceLocation: JSON.stringify(maintenanceLocation),
            obraAtualId: null,
            operationalAssignment: null,
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
    const { id } = req.params; // vehicleId
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico de manutenção
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [now, id, 'manutencao']
        );

        // 2. Atualiza 'vehicles' (CORREÇÃO: sem 'history', sintaxe corrigida)
        const vehicleUpdateData = {
            status: 'Disponível',
            maintenanceLocation: null,
            localizacaoAtual: location,
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
    deleteVehicle,
    allocateToObra,
    deallocateFromObra,
    assignToOperational,
    unassignFromOperational,
    startMaintenance,
    endMaintenance
};
