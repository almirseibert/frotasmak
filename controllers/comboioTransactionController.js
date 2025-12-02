// controllers/comboioTransactionController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');
const { parseJsonSafe } = require('../utils/parseJsonSafe');
const crypto = require('crypto'); // Para gerar UUIDs se necessário

// Função auxiliar para garantir que undefined vire null (para o MySQL)
const sanitize = (value) => (value === undefined ? null : value);

const getAllComboioTransactions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions ORDER BY date DESC');
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

        // Reverte a lógica da transação
        if (transaction.type === 'entrada') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
            // Reverte a despesa (valor negativo)
            await createOrUpdateWeeklyFuelExpense({
                connection,
                obraId: transaction.obraId,
                date: new Date(transaction.date),
                fuelType: transaction.fuelType,
                partnerName: transaction.partnerName,
                valueChange: -transaction.valorTotal, 
            });
        } else if (transaction.type === 'saida') {
            // Devolve ao comboio
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
        } else if (transaction.type === 'drenagem') {
            // Devolve ao veículo, Tira do comboio
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
        const [priceRows] = await connection.execute(
            'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?',
            [partnerId, fuelType]
        );

        const price = (priceRows.length > 0 && priceRows[0].price) ? parseFloat(priceRows[0].price) : 0;
        const valorTotal = parseFloat(liters) * price;

        const [partnerRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
        const partnerName = partnerRows[0]?.razaoSocial || 'Parceiro Desconhecido';

        const transactionData = {
            id: req.body.id || crypto.randomUUID(), // Gera ID se não vier no body
            type: 'entrada',
            date: new Date(date),
            comboioVehicleId,
            partnerId,
            partnerName,
            obraId,
            liters: parseFloat(liters),
            fuelType,
            valorTotal,
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            odometro: sanitize(odometro),
            horimetro: sanitize(horimetro),
            employeeId: sanitize(employeeId),
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);
        
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );
        
        if(odometro || horimetro) {
            await connection.execute('UPDATE vehicles SET odometro = ?, horimetro = ? WHERE id = ?', [sanitize(odometro), sanitize(horimetro), comboioVehicleId]);
        }
        
        if (price > 0) {
            await createOrUpdateWeeklyFuelExpense({ connection, obraId, date: new Date(date), fuelType, partnerName: partnerName, valueChange: valorTotal });
        }

        await connection.commit();
        res.status(201).json({ message: 'Entrada registrada com sucesso.', refuelingOrder: { authNumber: 0, litrosAbastecidos: liters } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar entrada:', error);
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
        const [comboioRows] = await connection.execute('SELECT fuelLevels FROM vehicles WHERE id = ?', [comboioVehicleId]);
        // Verificação de saldo opcional aqui, já que o frontend valida, mas bom manter try/catch
        
        const transactionData = {
            id: req.body.id || crypto.randomUUID(), // Gera ID se necessário
            type: 'saida',
            date: new Date(date),
            comboioVehicleId,
            receivingVehicleId,
            obraId,
            employeeId: sanitize(employeeId),
            liters: parseFloat(liters),
            fuelType,
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            odometro: sanitize(odometro), 
            horimetro: sanitize(horimetro),
            horimetroDigital: sanitize(horimetroDigital)
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );
        
        const vehicleUpdateData = {};
        if (odometro !== undefined) vehicleUpdateData.odometro = parseFloat(odometro);
        if (horimetro !== undefined) vehicleUpdateData.horimetro = parseFloat(horimetro);
        if (horimetroDigital !== undefined) vehicleUpdateData.horimetroDigital = parseFloat(horimetroDigital);

        if (Object.keys(vehicleUpdateData).length > 0) {
            const setClause = Object.keys(vehicleUpdateData).map(key => `${key} = ?`).join(', ');
            const setValues = Object.values(vehicleUpdateData);
            await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...setValues, receivingVehicleId]);
        }
        
        await connection.commit();
        res.status(201).json({ message: 'Saída registrada com sucesso.', refuelingOrder: { authNumber: 0, litrosAbastecidos: liters } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar saída:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const createDrenagemTransaction = async (req, res) => {
    const { comboioVehicleId, drainingVehicleId, liters, date, fuelType, reason, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const transactionData = {
            id: req.body.id || crypto.randomUUID(), // Gera ID se necessário
            type: 'drenagem',
            date: new Date(date),
            comboioVehicleId,
            drainingVehicleId,
            liters: parseFloat(liters),
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
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), drainingVehicleId]
        );
        
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );

        await connection.commit();
        res.status(201).json({ message: 'Drenagem registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao registrar drenagem:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// NOVA FUNÇÃO DE UPDATE
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const newData = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Busca transação antiga
        const [oldRows] = await connection.execute('SELECT * FROM comboio_transactions WHERE id = ?', [id]);
        if (oldRows.length === 0) throw new Error("Transação não encontrada");
        const oldData = oldRows[0];

        // 2. Reverte efeito da antiga (Simplificado para litros apenas)
        // Para uma implementação completa, deveríamos reverter despesas também se mudou algo crítico
        
        // Reverte Entrada
        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
        } 
        // Reverte Saída
        else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
        } 
        // Reverte Drenagem
        else if (oldData.type === 'drenagem') {
            // Tira do comboio (que recebeu), devolve ao veículo (que drenou)
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.drainingVehicleId]);
        }

        // 3. Aplica efeito da nova
        const newLiters = parseFloat(newData.liters);
        // Aplica Entrada Nova
        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.comboioVehicleId]);
        } 
        // Aplica Saída Nova
        else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.comboioVehicleId]);
        } 
        // Aplica Drenagem Nova
        else if (oldData.type === 'drenagem') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.drainingVehicleId]);
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${newData.fuelType}`, `$.${newData.fuelType}`, newLiters, oldData.comboioVehicleId]);
        }

        // 4. Atualiza registro na tabela
        // Nota: partnerId ou oldData.partnerId garante que se newData não trouxer o campo, mantemos o antigo
        await connection.execute(
            'UPDATE comboio_transactions SET liters = ?, date = ?, fuelType = ?, partnerId = ?, employeeId = ?, obraId = ?, odometro = ?, horimetro = ? WHERE id = ?',
            [
                newLiters, 
                new Date(newData.date), 
                newData.fuelType, 
                sanitize(newData.partnerId) || oldData.partnerId, 
                sanitize(newData.employeeId) || oldData.employeeId, 
                sanitize(newData.obraId) || oldData.obraId, 
                sanitize(newData.odometro) || oldData.odometro, 
                sanitize(newData.horimetro) || oldData.horimetro, 
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