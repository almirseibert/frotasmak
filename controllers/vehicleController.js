// controllers/vehicleController.js
const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs'); // File System para deletar imagem antiga se houver
const path = require('path'); // <-- 1. IMPORTAR O PATH

// --- CORREÇÃO DE BUG 2: Função parseJsonSafe substituída ---
// Esta versão é mais robusta e não tentará parsear strings simples.
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; // Já é um objeto
    
    // Verifica se é uma string e se PARECE um JSON antes de tentar
    if (typeof field === 'string' && (field.startsWith('{') || field.startsWith('['))) {
        try {
            const parsed = JSON.parse(field);
            return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
        } catch (e) {
            console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
            return defaultValue; // Retorna nulo se o parse falhar
        }
    }
    
    // Se for uma string que não parece JSON (ex: "Entrada em manutenção..."), retorna nulo
    if (typeof field === 'string') {
        return defaultValue;
    }
    
    return defaultValue; // Retorna nulo para tipos inesperados (números, etc.)
};
// --- FIM DA CORREÇÃO ---


// ... (parseVehicleJsonFields se mantém igual) ...
const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    
    return newVehicle;
};

// ... (getAllVehicles se mantém igual) ...
const getAllVehicles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles');
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history');
        
        const vehicles = rows.map(v => {
            const vehicle = parseVehicleJsonFields(v);
            // Anexa o histórico relevante a este veículo
            vehicle.history = historyRows
                .filter(h => h.vehicleId === vehicle.id)
                .map(h => ({
                    ...h,
                    details: parseJsonSafe(h.details, 'history.details') // Agora usa a nova função
                }));
            return vehicle;
        });
        
        res.json(vehicles);
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

// ... (getVehicleById se mantém igual) ...
const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        
        const vehicle = parseVehicleJsonFields(rows[0]);
        
        // Busca o histórico para este veículo
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ?', [req.params.id]);
        vehicle.history = historyRows.map(h => ({
            ...h,
            details: parseJsonSafe(h.details, 'history.details') // Agora usa a nova função
        }));
        
        res.json(vehicle);
    } catch (error) {
        console.error('Erro ao buscar veículo:', error);
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

// --- CREATE: Criar um novo veículo ---
const createVehicle = async (req, res) => {
    const data = req.body;
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    delete data.history; 

    // --- Adiciona ID gerado pelo Node ---
    // O frontend não envia mais o ID
    data.id = randomUUID();

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        // Retorna o objeto completo com o novo ID
        res.status(201).json({ ...req.body, id: data.id }); 
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
        
        // --- CORREÇÃO DE BUG (PATH RELATIVO) ---
        if (rows.length > 0 && rows[0].fotoURL) {
            const oldFotoURL = rows[0].fotoURL; // Ex: /uploads/old-image.jpg
            
            // Resolve o caminho absoluto: 'public' + '/uploads/old-image.jpg'
            // O substring(1) remove o '/' inicial de '/uploads'
            const oldLocalPath = path.resolve('public', oldFotoURL.substring(1)); 

            // Usa try...catch para que uma falha na deleção (ex: arquivo não existe)
            // NÃO cancele a transação de upload.
            try {
                if (fs.existsSync(oldLocalPath)) {
                    fs.unlinkSync(oldLocalPath); // Usa Sync para aguardar a deleção
                    console.log(`[Upload] Imagem antiga ${oldLocalPath} deletada.`);
                }
            } catch (unlinkError) {
                console.warn(`[Upload] Aviso: Falha ao deletar imagem antiga ${oldLocalPath}.`, unlinkError.message);
            }
        }
        // --- FIM DA CORREÇÃO ---

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


// ... (deleteVehicle se mantém igual) ...
const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        // ... (lógica de delete) ...
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ? OR id = ?', [req.params.id, req.params.id]);
        if (revisions.length > 0) {
            const revisionIds = revisions.map(r => r.id);
            // Deleta o histórico primeiro
            await connection.execute(`DELETE FROM revisions_history WHERE revisionId IN (?)`, [revisionIds]);
            // Deleta os planos
            await connection.execute(`DELETE FROM revisions WHERE id IN (?)`, [revisionIds]);
        }
        
        // Deleta o veículo (que deleta o histórico de alocação em cascata)
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

// ... (Rotas de Alocação, allocateToObra, deallocateFromObra, etc. se mantêm iguais) ...
// ... (Nenhuma mudança necessária neles para esta task) ...
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
        // (ID é AUTO_INCREMENT, então não passamos)
        const newHistoryEntry = {
            // id: randomUUID(), // REMOVIDO (Correto)
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
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', '); // Variável para a tabela 1

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
            alocadoEm: JSON.stringify({
                type: 'obra',
                id: obraId,
                nome: obra.nome
            }),
            [readingType]: readingValue, // Atualiza a leitura principal
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        // 3. Atualiza o funcionário
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeId]);

        // 4. (Lógica migrada) Grava na tabela 'obras_historico_veiculos'
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);
        const vehicle = vehicleRows[0];
        
        const newObraHistoryEntryData = {
            // --- CORREÇÃO DE BUG (Mantida): Esta tabela precisa de ID ---
            id: randomUUID(),
            // --- FIM DA CORREÇÃO ---
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
        const obraHistoryPlaceholders = obraHistoryFields.map(() => '?').join(', '); // Variável para a tabela 2

        // A correção da variável (obraHistoryPlaceholders) da última vez está mantida
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

const deallocateFromObra = async (req, res) => {
    const { id } = req.params; // vehicleId
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida);

        // 1. Atualiza a entrada de histórico em 'vehicle_history'
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

        // 2. Atualiza o veículo
        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
            alocadoEm: null,
            [readingType]: readingValue, // Atualiza leitura principal
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        // 3. Atualiza funcionário (se houver)
        if (employeeIdFromHistory) {
             await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdFromHistory]);
        }
        
        // 4. (Lógica migrada) Atualiza 'obras_historico_veiculos'
        const obraHistoryUpdateFields = ['dataSaida = ?'];
        const obraHistoryUpdateValues = [exitTimestamp];

        if (readingType === 'odometro') {
            obraHistoryUpdateFields.push('odometroSaida = ?');
            obraHistoryUpdateValues.push(readingValue);
        } else if (readingType === 'horimetro' || readingType === 'horimetroDigital') {
            obraHistoryUpdateFields.push('horimetroSaida = ?');
            obraHistoryUpdateValues.push(readingValue);
        }

        obraHistoryUpdateValues.push(id); // vehicleId
        obraHistoryUpdateValues.push(obraIdFromHistory); // obraId

        await connection.execute(
            `UPDATE obras_historico_veiculos 
             SET ${obraHistoryUpdateFields.join(', ')} 
             WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
            obraHistoryUpdateValues
        );
        
        // 5. (Lógica separada) Atualiza 'obras' se 'shouldFinalizeObra' for verdadeiro
        if (shouldFinalizeObra) {
            const obraUpdate = { 
                status: 'finalizada', // Ajuste para 'Finalizada' se for o caso
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

const assignToOperational = async (req, res) => {
    const { id } = req.params; // vehicleId
    
    // --- CORREÇÃO (Mantida) ---
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    // --- FIM DA CORREÇÃO ---

    await connection.beginTransaction();

    try {
        // --- CORREÇÃO DE BUG (Mantida) ---
        if (!employeeId) {
            throw new Error('ID do funcionário não pode ser vazio.');
        }
        // --- FIM DA CORREÇÃO ---

        const now = new Date();
        
        // 1. Finaliza histórico anterior (se houver)
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );
        
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        
        // --- CORREÇÃO DE BUG (Mantida) ---
        if (!selectedEmployeeRows || selectedEmployeeRows.length === 0) {
            console.error(`Falha ao alocar: Funcionário com ID ${employeeId} não encontrado.`);
            throw new Error('Funcionário selecionado não encontrado no banco de dados.');
        }
        const employeeName = selectedEmployeeRows[0]?.nome;
        // --- FIM DA CORREÇÃO ---
        
        // 2. Cria nova entrada de histórico
        // (ID é AUTO_INCREMENT, então não passamos)
        const newHistoryEntry = {
            // id: randomUUID(), // REMOVIDO (Correto)
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
        
        // 3. Prepara dados da alocação para 'vehicles'
        const operationalAssignment = { 
            subGroup, 
            employeeId, 
            employeeName, 
            startDate: now 
        };

        // 4. Atualiza 'vehicles'
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
        
        // 5. Atualiza 'employees'
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeId]);

        await connection.commit();
        res.status(200).json({ message: 'Veículo alocado para operação com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar veículo para operação:", error.message); // Log mais claro
        res.status(500).json({ error: 'Falha ao alocar o veículo.', message: error.message });
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
        if (activeHistory) { // Adiciona verificação se histórico existe
            await connection.execute(
                'UPDATE vehicle_history SET endDate = ? WHERE id = ?',
                [now, activeHistory.id]
            );
        }

        // 3. Atualiza 'vehicles'
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

        // 4. Atualiza 'employees'
        if (activeHistory?.details) {
             const details = parseJsonSafe(activeHistory.details, 'history.details'); // Agora usa a nova função
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
    
    // --- CORREÇÃO (Mantida) ---
    const { status, location } = req.body;
    const connection = await db.getConnection();
    // --- FIM DA CORREÇÃO ---

    await connection.beginTransaction();

    try {
        const now = new Date();
        
        // 1. Finaliza histórico anterior
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );

        // 2. Cria nova entrada de histórico
        // (ID é AUTO_INCREMENT, então não passamos)
        const newHistoryEntry = {
            // id: randomUUID(), // REMOVIDO (Correto)
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
        
        // 3. Prepara dados da manutenção para 'vehicles'
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        // 4. Atualiza 'vehicles'
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

        // 2. Atualiza 'vehicles'
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