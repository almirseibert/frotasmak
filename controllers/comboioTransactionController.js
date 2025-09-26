// controllers/comboioTransactionController.js
const db = require('../database');
const parseVehicleJsonFields = require('./vehicleController').parseVehicleJsonFields;
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController'); // Função auxiliar

const getAllComboioTransactions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar transações de comboio:', error);
        res.status(500).json({ error: 'Erro ao buscar transações de comboio' });
    }
};

const getComboioTransactionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Transação não encontrada' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar transação:', error);
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

        if (transaction.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
                `$.${transaction.fuelType}`,
                `$.${transaction.fuelType} - ?`,
                transaction.comboioVehicleId
            ]);
            await createOrUpdateWeeklyFuelExpense({
                connection,
                obraId: transaction.obraId,
                date: new Date(transaction.date),
                fuelType: transaction.fuelType,
                partnerName: transaction.partnerName,
                valueChange: -transaction.valorTotal,
            });
        } else if (transaction.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
                `$.${transaction.fuelType}`,
                `$.${transaction.fuelType} + ?`,
                transaction.comboioVehicleId
            ]);
        } else if (transaction.type === 'drenagem') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
                `$.${transaction.fuelType}`,
                `$.${transaction.fuelType} - ?`,
                transaction.comboioVehicleId
            ]);
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
                `$.${transaction.fuelType}`,
                `$.${transaction.fuelType} + ?`,
                transaction.drainingVehicleId
            ]);
        }
        
        await connection.execute('DELETE FROM comboio_transactions WHERE id = ?', [id]);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao deletar transação de comboio:', error);
        res.status(500).json({ error: 'Erro ao deletar transação de comboio' });
    } finally {
        connection.release();
    }
};

const createEntradaTransaction = async (req, res) => {
    const { comboioVehicleId, partnerId, employeeId, odometro, horimetro, obraId, liters, date, fuelType, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [partnerRows] = await connection.execute('SELECT fuel_prices FROM partners WHERE id = ?', [partnerId]);
        const prices = JSON.parse(partnerRows[0].fuel_prices);
        const price = prices?.[fuelType] || 0;
        if (price <= 0) {
            throw new Error(`Preço para ${fuelType} não encontrado.`);
        }
        const valorTotal = parseFloat(liters) * price;

        const transactionData = {
            type: 'entrada',
            date: new Date(date),
            comboioVehicleId,
            partnerId,
            obraId,
            liters: parseFloat(liters),
            fuelType,
            valorTotal,
            responsibleUserEmail: createdBy.userEmail,
            odometro,
            horimetro,
        };
        await connection.execute('INSERT INTO comboio_transactions SET ?', [transactionData]);
        
        await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
            `$.${fuelType}`,
            `COALESCE(JSON_EXTRACT(fuelLevels, "$.${fuelType}"), 0) + ?`,
            comboioVehicleId,
        ]);
        await connection.execute('UPDATE vehicles SET odometro = ?, horimetro = ? WHERE id = ?', [odometro, horimetro, comboioVehicleId]);
        
        await createOrUpdateWeeklyFuelExpense({ connection, obraId, date: new Date(date), fuelType, partnerName: 'Comboio', valueChange: valorTotal });

        await connection.commit();
        res.status(201).json({ message: 'Entrada registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar entrada de comboio:', error);
        res.status(500).json({ error: error.message || 'Falha ao registrar entrada de comboio.' });
    } finally {
        connection.release();
    }
};

const createSaidaTransaction = async (req, res) => {
    const { comboioVehicleId, receivingVehicleId, odometro, horimetro, horimetroDigital, liters, date, fuelType, obraId, employeeId, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [comboioVehicleRows] = await connection.execute('SELECT fuelLevels FROM vehicles WHERE id = ?', [comboioVehicleId]);
        const comboioFuelLevels = JSON.parse(comboioVehicleRows[0].fuelLevels);
        if (liters > comboioFuelLevels[fuelType]) {
            throw new Error('Litros solicitados excedem o saldo disponível no comboio.');
        }

        const transactionData = {
            type: 'saida',
            date: new Date(date),
            comboioVehicleId,
            receivingVehicleId,
            obraId,
            employeeId,
            liters: parseFloat(liters),
            fuelType,
            responsibleUserEmail: createdBy.userEmail,
        };
        await connection.execute('INSERT INTO comboio_transactions SET ?', [transactionData]);

        await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
            `$.${fuelType}`,
            `COALESCE(JSON_EXTRACT(fuelLevels, "$.${fuelType}"), 0) - ?`,
            comboioVehicleId,
        ]);
        
        const vehicleUpdateData = {};
        if (odometro) vehicleUpdateData.odometro = parseFloat(odometro);
        if (horimetro) vehicleUpdateData.horimetro = parseFloat(horimetro);
        if (horimetroDigital) vehicleUpdateData.horimetroDigital = parseFloat(horimetroDigital);

        await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, receivingVehicleId]);
        
        await connection.commit();
        res.status(201).json({ message: 'Saída registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar saída de comboio:', error);
        res.status(500).json({ error: error.message || 'Falha ao registrar saída de comboio.' });
    } finally {
        connection.release();
    }
};

const createDrenagemTransaction = async (req, res) => {
    const { comboioVehicleId, drainingVehicleId, liters, date, fuelType, reason, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [drainingVehicleRows] = await connection.execute('SELECT fuelLevels FROM vehicles WHERE id = ?', [drainingVehicleId]);
        const drainingFuelLevels = JSON.parse(drainingVehicleRows[0].fuelLevels);
        if (liters > drainingFuelLevels[fuelType]) {
            throw new Error('Litros solicitados excedem o saldo disponível no veículo de origem.');
        }

        const transactionData = {
            type: 'drenagem',
            date: new Date(date),
            comboioVehicleId,
            drainingVehicleId,
            liters: parseFloat(liters),
            fuelType,
            reason,
            responsibleUserEmail: createdBy.userEmail,
        };
        await connection.execute('INSERT INTO comboio_transactions SET ?', [transactionData]);

        await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
            `$.${fuelType}`,
            `COALESCE(JSON_EXTRACT(fuelLevels, "$.${fuelType}"), 0) - ?`,
            drainingVehicleId,
        ]);
        await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, ?) WHERE id = ?', [
            `$.${fuelType}`,
            `COALESCE(JSON_EXTRACT(fuelLevels, "$.${fuelType}"), 0) + ?`,
            comboioVehicleId,
        ]);

        await connection.commit();
        res.status(201).json({ message: 'Drenagem registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar drenagem:', error);
        res.status(500).json({ error: error.message || 'Falha ao registrar drenagem.' });
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
};