// controllers/comboioTransactionController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');
const { parseJsonSafe } = require('../utils/parseJsonSafe');
const crypto = require('crypto');

// Helpers de sanitização
const sanitize = (value) => (value === undefined || value === '' ? null : value);
const sanitizeNumber = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const number = parseFloat(value);
    return isNaN(number) ? null : number;
};

// --- FUNÇÃO AUXILIAR: Obter Preço Médio ---
const getAverageFuelPrice = async (connection, fuelType) => {
    const [rows] = await connection.execute(
        'SELECT AVG(price) as avgPrice FROM partner_fuel_prices WHERE fuelType = ? AND price > 0',
        [fuelType]
    );
    return rows[0].avgPrice ? parseFloat(rows[0].avgPrice) : 0;
};

// --- FUNÇÃO AUXILIAR: Gerenciar Despesa Mensal Agrupada ---
const manageMonthlyExpense = async ({ connection, obraId, obraName, date, fuelType, valueChange }) => {
    if (!obraId || !fuelType || valueChange === 0) return;

    const expenseDate = new Date(date);
    const month = expenseDate.getMonth() + 1;
    const year = expenseDate.getFullYear();
    // Data de referência: dia 1º do mês para facilitar agrupamento
    const referenceDate = new Date(year, month - 1, 1).toISOString().slice(0, 10); 
    
    const mesExtenso = expenseDate.toLocaleString('pt-BR', { month: 'long' });
    const capitalizedMonth = mesExtenso.charAt(0).toUpperCase() + mesExtenso.slice(1);
    const formattedFuel = fuelType === 'dieselS10' ? 'Diesel S10' : (fuelType === 'dieselComum' ? 'Diesel Comum' : fuelType);

    // Tenta encontrar despesa existente para este Mês, Ano, Obra e Combustível (Agrupado)
    const [existingExpenses] = await connection.execute(
        `SELECT id, amount FROM expenses 
         WHERE obraId = ? 
         AND fuelType = ? 
         AND category = 'Combustível' 
         AND expenseType = 'Automático'
         AND MONTH(createdAt) = ? 
         AND YEAR(createdAt) = ? 
         LIMIT 1`,
        [obraId, fuelType, month, year]
    );

    if (existingExpenses.length > 0) {
        // Atualiza soma
        const expense = existingExpenses[0];
        const newAmount = parseFloat(expense.amount) + valueChange;
        
        await connection.execute(
            'UPDATE expenses SET amount = ? WHERE id = ?',
            [newAmount, expense.id]
        );
    } else {
        // Cria novo agrupamento
        // Descrição padrão: Combustível: Diesel S10 - Comboio - Obra X (Dezembro/2025)
        const description = `Combustível: ${formattedFuel} - Comboio - ${obraName || 'Obra'} (${capitalizedMonth}/${year})`;
        const newId = crypto.randomUUID();
        
        await connection.execute(
            `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, fuelType, expenseType) 
             VALUES (?, ?, ?, ?, 'Combustível', ?, ?, 'Automático')`,
            [newId, obraId, description, valueChange, referenceDate, fuelType]
        );
    }
};

// --- CRUD ---

const getAllComboioTransactions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions ORDER BY date DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
};

const getComboioTransactionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Transação não encontrada' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar transação' });
    }
};

const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [transactionRows] = await connection.execute('SELECT * FROM comboio_transactions WHERE id = ?', [id]);
        const transaction = transactionRows[0];
        if (!transaction) {
            await connection.rollback();
            return res.status(404).json({ error: 'Transação não encontrada.' });
        }

        // Reverte Estoque e Despesas
        if (transaction.type === 'entrada') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
            // Reverte despesa de entrada (pagamento ao posto)
            if (transaction.valorTotal > 0) {
                await createOrUpdateWeeklyFuelExpense({
                    connection,
                    obraId: transaction.obraId,
                    date: new Date(transaction.date),
                    fuelType: transaction.fuelType,
                    partnerName: transaction.partnerName,
                    valueChange: -transaction.valorTotal, 
                });
            }
        } else if (transaction.type === 'saida') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
            
            // Reverte despesa da OBRA (Estorno do valor)
            const avgPrice = await getAverageFuelPrice(connection, transaction.fuelType);
            const valueToRevert = transaction.liters * avgPrice;
            
            await manageMonthlyExpense({
                connection,
                obraId: transaction.obraId,
                // Não precisa atualizar nome na reversão
                obraName: transaction.obraName, 
                date: new Date(transaction.date),
                fuelType: transaction.fuelType,
                valueChange: -valueToRevert 
            });

        } else if (transaction.type === 'drenagem') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.drainingVehicleId]
            );
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
        }
        
        await connection.execute('DELETE FROM comboio_transactions WHERE id = ?', [id]);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao deletar:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const createEntradaTransaction = async (req, res) => {
    const { comboioVehicleId, partnerId, employeeId, odometro, horimetro, obraId, liters, date, fuelType, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [priceRows] = await connection.execute(
            'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?',
            [partnerId, fuelType]
        );

        const price = (priceRows.length > 0 && priceRows[0].price) ? parseFloat(priceRows[0].price) : 0;
        const safeLiters = sanitizeNumber(liters) || 0;
        const valorTotal = safeLiters * price;

        const [partnerRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
        const partnerName = partnerRows[0]?.razaoSocial || 'Parceiro Desconhecido';

        // Busca nome da obra para registro
        let obraName = 'Obra Desconhecida';
        if (obraId) {
            const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
            if (obraRows.length > 0) obraName = obraRows[0].nome;
            else if (['Administração', 'Oficina', 'Pátio', 'Rampa', 'Diversos'].includes(obraId)) obraName = obraId;
        }

        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            type: 'entrada',
            date: new Date(date),
            comboioVehicleId,
            partnerId,
            partnerName,
            obraId,
            obraName, // Salva o nome da obra na transação para histórico
            liters: safeLiters,
            fuelType,
            valorTotal,
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            odometro: sanitizeNumber(odometro),
            horimetro: sanitizeNumber(horimetro),
            employeeId: sanitize(employeeId),
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);
        
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );
        
        if (price > 0) {
            // Entrada gera despesa de pagamento ao posto
            await createOrUpdateWeeklyFuelExpense({ connection, obraId, date: new Date(date), fuelType, partnerName: partnerName, valueChange: valorTotal });
        }

        await connection.commit();
        res.status(201).json({ message: 'Entrada registrada com sucesso.', refuelingOrder: { authNumber: 0, litrosAbastecidos: safeLiters } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro entrada:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const createSaidaTransaction = async (req, res) => {
    const { comboioVehicleId, receivingVehicleId, odometro, horimetro, horimetroDigital, liters, date, fuelType, obraId, employeeId, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const safeLiters = sanitizeNumber(liters) || 0;

        // Busca nome da obra para registro e despesa
        let obraName = 'Obra Desconhecida';
        if (obraId) {
            const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
            if (obraRows.length > 0) obraName = obraRows[0].nome;
            else if (['Administração', 'Oficina', 'Pátio', 'Rampa', 'Diversos'].includes(obraId)) obraName = obraId;
        }

        // Busca nome do veículo recebedor para histórico
        let receivingVehicleName = null;
        if (receivingVehicleId) {
            const [vRows] = await connection.execute('SELECT registroInterno FROM vehicles WHERE id = ?', [receivingVehicleId]);
            if (vRows.length > 0) receivingVehicleName = vRows[0].registroInterno;
        }

        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            type: 'saida',
            date: new Date(date),
            comboioVehicleId,
            receivingVehicleId,
            receivingVehicleName, // Salva para histórico
            obraId,
            obraName, // Salva para histórico
            employeeId: sanitize(employeeId),
            liters: safeLiters,
            fuelType,
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            odometro: sanitizeNumber(odometro), 
            horimetro: sanitizeNumber(horimetro),
            horimetroDigital: sanitizeNumber(horimetroDigital)
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );
        
        // Atualiza veículo recebedor
        const vehicleUpdateData = {};
        const safeOdo = sanitizeNumber(odometro);
        const safeHor = sanitizeNumber(horimetro);
        const safeHorDig = sanitizeNumber(horimetroDigital);

        if (safeOdo !== null) vehicleUpdateData.odometro = safeOdo;
        if (safeHor !== null) vehicleUpdateData.horimetro = safeHor;
        if (safeHorDig !== null) vehicleUpdateData.horimetroDigital = safeHorDig;

        if (Object.keys(vehicleUpdateData).length > 0) {
            const setClause = Object.keys(vehicleUpdateData).map(key => `${key} = ?`).join(', ');
            const setValues = Object.values(vehicleUpdateData);
            await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...setValues, receivingVehicleId]);
        }

        // --- GERA DESPESA PARA A OBRA (Valor Médio) ---
        const avgPrice = await getAverageFuelPrice(connection, fuelType);
        const expenseValue = safeLiters * avgPrice;

        if (expenseValue > 0) {
            await manageMonthlyExpense({
                connection,
                obraId,
                obraName,
                date: new Date(date),
                fuelType,
                valueChange: expenseValue
            });
        }
        
        await connection.commit();
        res.status(201).json({ message: 'Saída registrada com sucesso.', refuelingOrder: { authNumber: 0, litrosAbastecidos: safeLiters } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro saída:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const createDrenagemTransaction = async (req, res) => {
    // Mesma lógica anterior
    const { comboioVehicleId, drainingVehicleId, liters, date, fuelType, reason, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        let drainingVehicleName = null;
        if (drainingVehicleId) {
            const [vRows] = await connection.execute('SELECT registroInterno FROM vehicles WHERE id = ?', [drainingVehicleId]);
            if (vRows.length > 0) drainingVehicleName = vRows[0].registroInterno;
        }

        const safeLiters = sanitizeNumber(liters) || 0;
        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            type: 'drenagem',
            date: new Date(date),
            comboioVehicleId,
            drainingVehicleId,
            drainingVehicleName,
            liters: safeLiters,
            fuelType,
            reason: sanitize(reason),
            responsibleUserEmail: sanitize(createdBy?.userEmail),
        };

        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');

        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, drainingVehicleId]
        );
        
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );

        await connection.commit();
        res.status(201).json({ message: 'Drenagem registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const newData = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [oldRows] = await connection.execute('SELECT * FROM comboio_transactions WHERE id = ?', [id]);
        if (oldRows.length === 0) throw new Error("Transação não encontrada");
        const oldData = oldRows[0];

        // 1. Reversão Estoque
        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
        } else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
        }

        // 2. Reversão Despesa (Saída)
        if (oldData.type === 'saida') {
            const avgPriceOld = await getAverageFuelPrice(connection, oldData.fuelType);
            const valueToRevert = oldData.liters * avgPriceOld;
            await manageMonthlyExpense({
                connection,
                obraId: oldData.obraId,
                date: new Date(oldData.date),
                fuelType: oldData.fuelType,
                valueChange: -valueToRevert 
            });
        }

        // 3. Aplicação Novo Estoque
        const newLiters = sanitizeNumber(newData.liters) || 0;
        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.comboioVehicleId]);
        } else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.comboioVehicleId]);
        }

        // 4. Aplicação Nova Despesa (Saída)
        let newObraName = oldData.obraName;
        if (newData.obraId && newData.obraId !== oldData.obraId) {
             const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [newData.obraId]);
             if (obraRows.length > 0) newObraName = obraRows[0].nome;
             else if (['Administração', 'Oficina', 'Pátio', 'Rampa', 'Diversos'].includes(newData.obraId)) newObraName = newData.obraId;
        }

        if (oldData.type === 'saida') {
            const avgPriceNew = await getAverageFuelPrice(connection, newData.fuelType);
            const valueToAdd = newLiters * avgPriceNew;
            await manageMonthlyExpense({
                connection,
                obraId: newData.obraId || oldData.obraId,
                obraName: newObraName,
                date: new Date(newData.date),
                fuelType: newData.fuelType,
                valueChange: valueToAdd 
            });
        }

        // 5. Atualiza Registro
        await connection.execute(
            'UPDATE comboio_transactions SET liters = ?, date = ?, fuelType = ?, partnerId = ?, employeeId = ?, obraId = ?, obraName = ?, odometro = ?, horimetro = ? WHERE id = ?',
            [
                newLiters, 
                new Date(newData.date), 
                newData.fuelType, 
                sanitize(newData.partnerId) || oldData.partnerId, 
                sanitize(newData.employeeId) || oldData.employeeId, 
                sanitize(newData.obraId) || oldData.obraId, 
                newObraName, 
                sanitizeNumber(newData.odometro) || oldData.odometro, 
                sanitizeNumber(newData.horimetro) || oldData.horimetro, 
                id
            ]
        );

        await connection.commit();
        res.json({ message: "Atualizado com sucesso" });
    } catch (e) {
        await connection.rollback();
        console.error(e);
        res.status(500).json({ error: e.message });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllComboioTransactions,
    getComboioTransactionById,
    deleteTransaction,
    createEntradaTransaction,
    createSaidaTransaction,
    createDrenagemTransaction,
    updateTransaction
};