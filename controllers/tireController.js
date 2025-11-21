const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET: Listar Pneus
const getAllTires = async (req, res) => {
    try {
        const query = `
            SELECT t.*, v.placa as vehiclePlaca, v.registroInterno as vehicleRegistro 
            FROM tires t
            LEFT JOIN vehicles v ON t.currentVehicleId = v.id
            ORDER BY t.fireNumber ASC
        `;
        const [rows] = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar pneus:', error);
        res.status(500).json({ error: 'Erro ao buscar pneus.' });
    }
};

// POST: Cadastrar Pneu
const createTire = async (req, res) => {
    const data = req.body;
    if (!data.fireNumber || !data.brand || !data.size) {
        return res.status(400).json({ error: 'Marca de fogo, Marca e Tamanho são obrigatórios.' });
    }

    const id = uuidv4();
    const status = 'Estoque'; 

    const query = `
        INSERT INTO tires (id, fireNumber, brand, model, size, tireCondition, status, purchaseDate, price, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    try {
        await db.execute(query, [
            id, 
            data.fireNumber, 
            data.brand, 
            data.model || null, 
            data.size, 
            data.tireCondition || 'Novo', 
            status, 
            data.purchaseDate || null, 
            data.price || null, 
            'Almoxarifado'
        ]);
        res.status(201).json({ message: 'Pneu cadastrado com sucesso!' });
    } catch (error) {
        console.error('Erro ao criar pneu:', error);
        res.status(500).json({ error: 'Erro ao criar pneu. Verifique se a Marca de Fogo já existe.' });
    }
};

// PUT: Editar Pneu
const updateTire = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    // Remove campos que não devem ser editados diretamente via PUT simples
    delete data.id;
    delete data.currentVehicleId;
    delete data.position;
    // O status geralmente é controlado por transação, mas permitimos edição se necessário (cuidado)
    
    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');

    const query = `UPDATE tires SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Pneu atualizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar pneu.' });
    }
};

// POST: Movimentação (Instalar/Remover/Transferir/Manutenção/Sucata)
const registerTransaction = async (req, res) => {
    const { 
        tireId, 
        vehicleId = null, 
        type, // 'install', 'remove', 'transfer', 'maintenance', 'scrap', 'restock'
        position = null, 
        date = new Date(), 
        odometer = null, 
        horimeter = null, 
        observation = '',
        employeeName = null, 
        obraName = null,
        vendorName = null // Para recapagem
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        if (type === 'install') {
            if (!vehicleId || !position) throw new Error("Veículo e Posição são obrigatórios para instalação.");
            
            // Verifica ocupação
            const [occupied] = await connection.execute(
                'SELECT id FROM tires WHERE currentVehicleId = ? AND position = ?', 
                [vehicleId, position]
            );
            if (occupied.length > 0) {
                throw new Error(`A posição ${position} já possui um pneu instalado. Remova-o antes.`);
            }

            await connection.execute(
                `UPDATE tires SET status = 'Em Uso', currentVehicleId = ?, position = ?, location = 'Veículo' WHERE id = ?`,
                [vehicleId, position, tireId]
            );

        } else if (type === 'remove') {
            await connection.execute(
                `UPDATE tires SET status = 'Estoque', currentVehicleId = NULL, position = NULL, location = 'Almoxarifado' WHERE id = ?`,
                [tireId]
            );
        
        } else if (type === 'transfer') { 
            // Envio para Step/Reserva
            const locDesc = `Obra: ${obraName || 'N/A'} / Resp: ${employeeName || 'N/A'}`;
            await connection.execute(
                `UPDATE tires SET status = 'Step/Reserva', currentVehicleId = NULL, position = NULL, location = ? WHERE id = ?`,
                [locDesc, tireId]
            );

        } else if (type === 'maintenance') {
            // Envio para Recapagem
            const locDesc = `Fornecedor: ${vendorName || 'Externo'}`;
            await connection.execute(
                `UPDATE tires SET status = 'Recapagem', currentVehicleId = NULL, position = NULL, location = ?, tireCondition = 'Recapado' WHERE id = ?`,
                [locDesc, tireId]
            );

        } else if (type === 'scrap') {
            // Descarte / Sucata
            await connection.execute(
                `UPDATE tires SET status = 'Sucata', currentVehicleId = NULL, position = NULL, location = 'Descarte' WHERE id = ?`,
                [tireId]
            );

        } else if (type === 'restock') {
            // Retorno ao Estoque (vindo de Step, Recapagem, etc)
            await connection.execute(
                `UPDATE tires SET status = 'Estoque', currentVehicleId = NULL, position = NULL, location = 'Almoxarifado' WHERE id = ?`,
                [tireId]
            );
        }

        // Registra Histórico
        const transId = uuidv4();
        let finalObservation = observation || '';
        
        if (type === 'transfer') finalObservation = `Enviado para ${obraName} (Resp: ${employeeName}). ${observation}`;
        if (type === 'maintenance') finalObservation = `Enviado para Recapagem: ${vendorName}. ${observation}`;
        if (type === 'scrap') finalObservation = `Enviado para Sucata. ${observation}`;

        const transactionDate = date ? new Date(date) : new Date();

        await connection.execute(
            `INSERT INTO tire_transactions (id, tireId, vehicleId, type, position, date, odometer, horimeter, observation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                transId, 
                tireId, 
                vehicleId || null, 
                type, 
                position || null, 
                transactionDate, 
                odometer || null, 
                horimeter || null, 
                finalObservation
            ]
        );

        // Atualiza Leitura do Veículo (se aplicável)
        if (vehicleId) {
            if (odometer && !isNaN(parseFloat(odometer)) && parseFloat(odometer) > 0) {
                await connection.execute('UPDATE vehicles SET odometro = GREATEST(IFNULL(odometro, 0), ?) WHERE id = ?', [odometer, vehicleId]);
            }
            if (horimeter && !isNaN(parseFloat(horimeter)) && parseFloat(horimeter) > 0) {
                await connection.execute('UPDATE vehicles SET horimetro = GREATEST(IFNULL(horimetro, 0), ?) WHERE id = ?', [horimeter, vehicleId]);
            }
        }

        await connection.commit();
        res.json({ message: 'Movimentação registrada com sucesso!' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro na transação de pneu:', error);
        res.status(500).json({ error: error.message || 'Erro interno ao registrar movimentação.' });
    } finally {
        connection.release();
    }
};

// GET: Histórico de um Pneu
const getTireHistory = async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT tt.*, v.placa, v.registroInterno 
            FROM tire_transactions tt
            LEFT JOIN vehicles v ON tt.vehicleId = v.id
            WHERE tt.tireId = ?
            ORDER BY tt.date DESC
        `;
        const [rows] = await db.query(query, [id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico.' });
    }
};

// GET: Histórico de Pneus de um VEÍCULO
const getVehicleTireHistory = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const query = `
            SELECT tt.*, t.fireNumber, t.brand, t.model, t.size
            FROM tire_transactions tt
            JOIN tires t ON tt.tireId = t.id
            WHERE tt.vehicleId = ?
            ORDER BY tt.date DESC, tt.createdAt DESC
        `;
        const [rows] = await db.query(query, [vehicleId]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar histórico do veículo.' });
    }
};

module.exports = {
    getAllTires,
    createTire,
    updateTire,
    registerTransaction,
    getTireHistory,
    getVehicleTireHistory
};