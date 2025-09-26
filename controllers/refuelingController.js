// controllers/refuelingController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');
const { parseVehicleJsonFields } = require('./vehicleController');

// --- Função Auxiliar para Conversão de JSON ---
const parseRefuelingJsonFields = (refueling) => {
    if (!refueling) return null;
    const newRefueling = { ...refueling };
    if (newRefueling.createdBy) newRefueling.createdBy = JSON.parse(newRefueling.createdBy);
    if (newRefueling.confirmedBy) newRefueling.confirmedBy = JSON.parse(newRefueling.confirmedBy);
    if (newRefueling.editedBy) newRefueling.editedBy = JSON.parse(newRefueling.editedBy);
    return newRefueling;
};

// --- READ: Obter todas as ordens de abastecimento ---
const getAllRefuelings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings');
        res.json(rows.map(parseRefuelingJsonFields));
    } catch (error) {
        console.error('Erro ao buscar abastecimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimentos' });
    }
};

// --- READ: Obter uma única ordem por ID ---
const getRefuelingById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Abastecimento não encontrado' });
        }
        res.json(parseRefuelingJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimento' });
    }
};

// --- CREATE: Criar uma nova ordem de abastecimento ---
const createRefuelingOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;

        const refuelingData = {
            ...data,
            authNumber: newAuthNumber,
            data: new Date(data.data),
            createdBy: JSON.stringify(data.createdBy),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null,
        };
        await connection.execute('INSERT INTO refuelings SET ?', [refuelingData]);
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        if (refuelingData.status === 'Concluída') {
            const vehicleUpdateData = {};
            if (refuelingData.odometro) vehicleUpdateData.odometro = refuelingData.odometro;
            if (refuelingData.horimetro) vehicleUpdateData.horimetro = refuelingData.horimetro;
            if (refuelingData.horimetroDigital) vehicleUpdateData.horimetroDigital = refuelingData.horimetroDigital;
            if (refuelingData.horimetroAnalogico) vehicleUpdateData.horimetroAnalogico = refuelingData.horimetroAnalogico;
            await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, refuelingData.vehicleId]);
            await createOrUpdateWeeklyFuelExpense({ connection, obraId: refuelingData.obraId, date: refuelingData.data, fuelType: refuelingData.fuelType, partnerName: refuelingData.partnerName, valueChange: refuelingData.litrosAbastecidos * 1 });
        }
        
        await connection.commit();
        res.status(201).json({ id: newAuthNumber, message: 'Ordem emitida com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao criar ordem de abastecimento:', error);
        res.status(500).json({ error: 'Falha ao criar ordem de abastecimento.' });
    } finally {
        connection.release();
    }
};

// --- UPDATE: Atualizar uma ordem existente ---
const updateRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [originalRefuelingRows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        const originalRefueling = parseRefuelingJsonFields(originalRefuelingRows[0]);
        const newStatus = data.status;

        const refuelingUpdateData = {
            ...data,
            data: new Date(data.data),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null,
        };
        await connection.execute('UPDATE refuelings SET ? WHERE id = ?', [refuelingUpdateData, id]);

        if (originalRefueling.status === 'Concluída' && newStatus === 'Concluída') {
            await createOrUpdateWeeklyFuelExpense({ connection, obraId: originalRefueling.obraId, date: originalRefueling.data, fuelType: originalRefueling.fuelType, partnerName: originalRefueling.partnerName, valueChange: -originalRefueling.litrosAbastecidos * 1 });
            await createOrUpdateWeeklyFuelExpense({ connection, obraId: refuelingUpdateData.obraId, date: refuelingUpdateData.data, fuelType: refuelingUpdateData.fuelType, partnerName: refuelingUpdateData.partnerName, valueChange: refuelingUpdateData.litrosAbastecidos * 1 });
        }
        
        await connection.commit();
        res.status(200).json({ message: 'Ordem atualizada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar ordem:', error);
        res.status(500).json({ error: 'Falha ao atualizar a ordem.' });
    } finally {
        connection.release();
    }
};


// --- ROTA: Confirmar um abastecimento em aberto ---
const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const { litrosAbastecidos, litrosAbastecidosArla, confirmedBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orderRows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        const order = parseRefuelingJsonFields(orderRows[0]);

        if (!order) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem de abastecimento não encontrada.' });
        }
        if (order.status !== 'Aberta') {
            await connection.rollback();
            return res.status(400).json({ error: 'Ordem já foi confirmada.' });
        }

        await connection.execute('UPDATE refuelings SET status = ?, litrosAbastecidos = ?, litrosAbastecidosArla = ?, confirmedBy = ? WHERE id = ?', [
            'Concluída',
            litrosAbastecidos,
            litrosAbastecidosArla,
            JSON.stringify(confirmedBy),
            id
        ]);
        
        await createOrUpdateWeeklyFuelExpense({ connection, obraId: order.obraId, date: order.data, fuelType: order.fuelType, partnerName: order.partnerName, valueChange: litrosAbastecidos * 1 });

        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [order.vehicleId]);
        const vehicle = parseVehicleJsonFields(vehicleRows[0]);
        const vehicleUpdateData = {};
        if (order.odometro) vehicleUpdateData.odometro = order.odometro;
        if (order.horimetro) vehicleUpdateData.horimetro = order.horimetro;
        if (order.horimetroDigital) vehicleUpdateData.horimetroDigital = order.horimetroDigital;
        if (order.horimetroAnalogico) vehicleUpdateData.horimetroAnalogico = order.horimetroAnalogico;
        await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, order.vehicleId]);
        
        await connection.commit();
        res.status(200).json({ message: 'Abastecimento confirmado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao confirmar abastecimento:', error);
        res.status(500).json({ error: 'Falha ao confirmar o abastecimento.' });
    } finally {
        connection.release();
    }
};

// --- DELETE: Deletar uma ordem de abastecimento ---
const deleteRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [refuelingRows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        const refueling = parseRefuelingJsonFields(refuelingRows[0]);
        if (refueling.status === 'Concluída') {
            await createOrUpdateWeeklyFuelExpense({ connection, obraId: refueling.obraId, date: refueling.data, fuelType: refueling.fuelType, partnerName: refueling.partnerName, valueChange: -refueling.litrosAbastecidos * 1 });
        }
        await connection.execute('DELETE FROM refuelings WHERE id = ?', [id]);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao deletar ordem de abastecimento:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem de abastecimento' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllRefuelings,
    getRefuelingById,
    createRefuelingOrder,
    updateRefuelingOrder,
    confirmRefuelingOrder,
    deleteRefuelingOrder
};