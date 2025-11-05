// controllers/comboioTransactionController.js
const db = require('../database');
// const parseVehicleJsonFields = require('./vehicleController').parseVehicleJsonFields; // parseVehicleJsonFields não é usado aqui
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController'); // Função auxiliar
const { parseJsonSafe } = require('../utils/parseJsonSafe'); // Supondo que você criou um util

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
            // Subtrai do comboio
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
            // Reverte a despesa
            await createOrUpdateWeeklyFuelExpense({
                connection,
                obraId: transaction.obraId,
                date: new Date(transaction.date),
                fuelType: transaction.fuelType,
                partnerName: transaction.partnerName,
                valueChange: -transaction.valorTotal, // Valor negativo
            });
        } else if (transaction.type === 'saida') {
            // Adiciona de volta ao comboio
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.comboioVehicleId]
            );
        } else if (transaction.type === 'drenagem') {
            // Adiciona de volta ao veículo drenado
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${transaction.fuelType}`, `$.${transaction.fuelType}`, transaction.liters, transaction.drainingVehicleId]
            );
            // Subtrai do comboio
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
    // 'valorTotal' não é mais enviado, será calculado
    const { comboioVehicleId, partnerId, employeeId, odometro, horimetro, obraId, liters, date, fuelType, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // *** CORREÇÃO: Busca o preço na tabela 'partner_fuel_prices' ***
        const [priceRows] = await connection.execute(
            'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?',
            [partnerId, fuelType]
        );

        if (priceRows.length === 0 || !priceRows[0].price || priceRows[0].price <= 0) {
            throw new Error(`Preço para ${fuelType} no parceiro ${partnerId} não encontrado ou inválido na tabela 'partner_fuel_prices'.`);
        }
        
        const price = parseFloat(priceRows[0].price);
        const valorTotal = parseFloat(liters) * price;

        // Busca nome do parceiro para registrar na despesa
        const [partnerRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
        const partnerName = partnerRows[0]?.razaoSocial || 'Parceiro Desconhecido';

        const transactionData = {
            id: req.body.id, // Pega o ID do frontend
            type: 'entrada',
            date: new Date(date),
            comboioVehicleId,
            partnerId,
            partnerName, // Armazena o nome do parceiro
            obraId,
            liters: parseFloat(liters),
            fuelType,
            valorTotal, // Valor calculado
            responsibleUserEmail: createdBy.userEmail,
            odometro,
            horimetro,
            employeeId, // Adiciona employeeId
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);
        
        // Atualiza nível de combustível do comboio
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );
        
        // Atualiza odometro/horimetro do comboio
        if(odometro || horimetro) {
            await connection.execute('UPDATE vehicles SET odometro = ?, horimetro = ? WHERE id = ?', [odometro, horimetro, comboioVehicleId]);
        }
        
        // Cria a despesa
        await createOrUpdateWeeklyFuelExpense({ connection, obraId, date: new Date(date), fuelType, partnerName: partnerName, valueChange: valorTotal });

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
        // Usa parseJsonSafe para evitar crash se fuelLevels for null ou string inválida
        const comboioFuelLevels = parseJsonSafe(comboioVehicleRows[0].fuelLevels, 'fuelLevels') || {};
        
        if (!comboioFuelLevels[fuelType] || parseFloat(liters) > parseFloat(comboioFuelLevels[fuelType])) {
            throw new Error(`Litros solicitados (${liters}) excedem o saldo disponível (${comboioFuelLevels[fuelType] || 0}) no comboio.`);
        }

        const transactionData = {
            id: req.body.id, // Pega o ID do frontend
            type: 'saida',
            date: new Date(date),
            comboioVehicleId,
            receivingVehicleId,
            obraId,
            employeeId,
            liters: parseFloat(liters),
            fuelType,
            responsibleUserEmail: createdBy.userEmail,
            // Adiciona leituras do veículo abastecido
            odometro, 
            horimetro,
            horimetroDigital
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        // Subtrai do comboio
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );
        
        // Atualiza leituras do veículo recebendo
        const vehicleUpdateData = {};
        if (odometro !== null && odometro !== undefined) vehicleUpdateData.odometro = parseFloat(odometro);
        if (horimetro !== null && horimetro !== undefined) vehicleUpdateData.horimetro = parseFloat(horimetro);
        if (horimetroDigital !== null && horimetroDigital !== undefined) vehicleUpdateData.horimetroDigital = parseFloat(horimetroDigital);

        if (Object.keys(vehicleUpdateData).length > 0) {
            const setClause = Object.keys(vehicleUpdateData).map(key => `${key} = ?`).join(', ');
            const setValues = Object.values(vehicleUpdateData);
            await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...setValues, receivingVehicleId]);
        }
        
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
        const drainingFuelLevels = parseJsonSafe(drainingVehicleRows[0].fuelLevels, 'fuelLevels') || {};
        
        // Não precisamos verificar o saldo do veículo drenado, pois é uma drenagem
        // (Podemos querer adicionar essa verificação no futuro)

        const transactionData = {
            id: req.body.id, // Pega o ID do frontend
            type: 'drenagem',
            date: new Date(date),
            comboioVehicleId,
            drainingVehicleId,
            liters: parseFloat(liters),
            fuelType,
            reason,
            responsibleUserEmail: createdBy.userEmail,
        };

        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');

        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        // Subtrai (ou define como 0) do veículo drenado
        // A drenagem pode remover mais do que o registrado, então apenas subtraímos.
        // O frontend deve idealmente impedir drenar mais do que o veículo tem.
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), drainingVehicleId]
        );
        
        // Adiciona ao comboio
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, parseFloat(liters), comboioVehicleId]
        );

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