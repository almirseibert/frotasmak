// controllers/refuelingController.js
const db = require('../database');
const crypto = require('crypto');

// --- HELPER: Conversão Numérica Segura ---
const safeNum = (val, returnZero = false) => {
    if (val === null || typeof val === 'undefined' || val === '') {
        return returnZero ? 0 : null;
    }
    const num = parseFloat(val);
    return isNaN(num) ? (returnZero ? 0 : null) : num;
};

// --- HELPER: Parse JSON Seguro ---
const parseJsonSafe = (field) => {
    if (!field) return null;
    if (typeof field === 'object') return field;
    try {
        return JSON.parse(field);
    } catch (e) {
        return null;
    }
};

// --- HELPER: Formatação de Resposta ---
const parseRefuelingRows = (rows) => {
    return rows.map(row => ({
        ...row,
        createdBy: parseJsonSafe(row.createdBy),
        confirmedBy: parseJsonSafe(row.confirmedBy),
        editedBy: parseJsonSafe(row.editedBy),
        litrosAbastecidos: row.litrosAbastecidos ? parseFloat(row.litrosAbastecidos) : 0,
        pricePerLiter: row.pricePerLiter ? parseFloat(row.pricePerLiter) : 0,
        outrosValor: row.outrosValor ? parseFloat(row.outrosValor) : 0,
        outrosGeraValor: !!row.outrosGeraValor 
    }));
};

// --- HELPER CENTRAL: Atualizar Despesa Mensal Consolidada ---
const updateMonthlyExpense = async (connection, obraId, partnerId, fuelType, dateInput) => {
    if (!obraId || !partnerId || !fuelType || !dateInput) return;

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59);

    const [partners] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';

    const querySum = `
        SELECT SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) + 
            COALESCE(outrosValor, 0)
        ) as total
        FROM refuelings
        WHERE obraId = ? 
          AND partnerId = ? 
          AND fuelType = ?
          AND data BETWEEN ? AND ?
    `;

    const [rows] = await connection.execute(querySum, [obraId, partnerId, fuelType, startDate, endDate]);
    const totalAmount = rows[0]?.total || 0;

    const monthName = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const description = `Combustível: ${fuelType} - ${partnerName} (${monthName})`;

    const [existingExpense] = await connection.execute(
        'SELECT id FROM expenses WHERE obraId = ? AND description = ?',
        [obraId, description]
    );

    if (totalAmount > 0) {
        if (existingExpense.length > 0) {
            await connection.execute(
                'UPDATE expenses SET amount = ?, updatedAt = NOW() WHERE id = ?',
                [totalAmount, existingExpense[0].id]
            );
        } else {
            const newId = crypto.randomUUID();
            await connection.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, date, partnerName, fuelType)
                 VALUES (?, ?, ?, ?, 'Combustível', NOW(), ?, ?, ?)`,
                [newId, obraId, description, totalAmount, startDate, partnerName, fuelType]
            );
        }
    } else {
        if (existingExpense.length > 0) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense[0].id]);
        }
    }
};

// --- GETTERS ---
const getAllRefuelings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings ORDER BY id DESC');
        res.json(parseRefuelingRows(rows));
    } catch (error) {
        console.error('Erro GET refuelings:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const getRefuelingById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
        res.json(parseRefuelingRows(rows)[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// --- CREATE ---
const createRefuelingOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const id = crypto.randomUUID();
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;

        let dataAbastecimento = new Date();
        if (data.date) {
             const dateStr = data.date.toString().includes('T') ? data.date : `${data.date}T12:00:00`;
             dataAbastecimento = new Date(dateStr);
        }

        // CORREÇÃO AQUI: obraId não usa safeNum, pois é string/UUID
        const refuelingData = {
            id: id,
            authNumber: newAuthNumber,
            vehicleId: data.vehicleId,
            partnerId: data.partnerId,
            partnerName: data.partnerName || null,
            employeeId: data.employeeId || null,
            obraId: data.obraId || null, // FIX: Passa o valor direto (string) ou null
            fuelType: data.fuelType || null,
            data: dataAbastecimento,
            status: data.status || 'Aberta',
            isFillUp: data.isFillUp ? 1 : 0,
            needsArla: data.needsArla ? 1 : 0,
            isFillUpArla: data.isFillUpArla ? 1 : 0,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0,
            litrosLiberados: safeNum(data.litrosLiberados, true),
            litrosLiberadosArla: safeNum(data.litrosLiberadosArla, true),
            odometro: safeNum(data.odometro),
            horimetro: safeNum(data.horimetro),
            horimetroDigital: safeNum(data.horimetroDigital),
            horimetroAnalogico: safeNum(data.horimetroAnalogico),
            outrosValor: safeNum(data.outrosValor, true),
            outros: data.outros || null,
            createdBy: JSON.stringify(data.createdBy || {}),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null
        };

        const fields = Object.keys(refuelingData);
        const values = Object.values(refuelingData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO refuelings (${fields.join(', ')}) VALUES (${placeholders})`, values);
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        if (refuelingData.obraId && refuelingData.partnerId && refuelingData.fuelType) {
            await updateMonthlyExpense(connection, refuelingData.obraId, refuelingData.partnerId, refuelingData.fuelType, refuelingData.data);
        }

        await connection.commit();
        res.status(201).json({ id: id, message: 'Ordem emitida.', authNumber: newAuthNumber });
    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- UPDATE ---
const updateRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [oldData] = await connection.execute('SELECT * FROM refuelings WHERE id = ?', [id]);
        if (oldData.length === 0) throw new Error('Ordem não encontrada');
        const oldRefueling = oldData[0];

        const updateData = {};
        if (data.date) {
            const dateStr = data.date.toString().replace(' ', 'T');
            updateData.data = new Date(dateStr);
        }
        if (data.editedBy) updateData.editedBy = JSON.stringify(data.editedBy);
        if (data.status) updateData.status = data.status;
        
        if (data.litrosLiberados !== undefined) updateData.litrosLiberados = safeNum(data.litrosLiberados, true);
        if (data.odometro !== undefined) updateData.odometro = safeNum(data.odometro);
        if (data.horimetro !== undefined) updateData.horimetro = safeNum(data.horimetro);
        if (data.horimetroDigital !== undefined) updateData.horimetroDigital = safeNum(data.horimetroDigital);
        if (data.horimetroAnalogico !== undefined) updateData.horimetroAnalogico = safeNum(data.horimetroAnalogico);
        if (data.outrosValor !== undefined) updateData.outrosValor = safeNum(data.outrosValor, true);
        
        if (data.partnerName !== undefined) updateData.partnerName = data.partnerName || null;
        if (data.partnerId !== undefined) updateData.partnerId = data.partnerId;
        
        // CORREÇÃO AQUI: ObraId direto, sem safeNum
        if (data.obraId !== undefined) updateData.obraId = data.obraId || null;
        
        if (data.fuelType !== undefined) updateData.fuelType = data.fuelType || null;
        if (data.outrosGeraValor !== undefined) updateData.outrosGeraValor = data.outrosGeraValor ? 1 : 0;
        if (data.outros !== undefined) updateData.outros = data.outros || null;

        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        if (Object.keys(updateData).length > 0) {
            const setClause = Object.keys(updateData).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE refuelings SET ${setClause} WHERE id = ?`, [...Object.values(updateData), id]);
        }

        const currentObra = updateData.obraId || oldRefueling.obraId;
        const currentPartner = updateData.partnerId || oldRefueling.partnerId;
        const currentFuel = updateData.fuelType || oldRefueling.fuelType;
        const currentDate = updateData.data || oldRefueling.data;

        if (currentObra && currentPartner && currentFuel) {
            await updateMonthlyExpense(connection, currentObra, currentPartner, currentFuel, currentDate);
        }

        if (
            (updateData.obraId && updateData.obraId !== oldRefueling.obraId) ||
            (updateData.partnerId && updateData.partnerId !== oldRefueling.partnerId) ||
            (updateData.fuelType && updateData.fuelType !== oldRefueling.fuelType)
        ) {
            if (oldRefueling.obraId && oldRefueling.partnerId && oldRefueling.fuelType) {
                await updateMonthlyExpense(connection, oldRefueling.obraId, oldRefueling.partnerId, oldRefueling.fuelType, oldRefueling.data);
            }
        }

        await connection.commit();
        res.json({ message: 'Ordem atualizada.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE:', error);
        res.status(500).json({ error: 'Falha ao atualizar.' });
    } finally {
        connection.release();
    }
};

// --- CONFIRM ---
const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const { litrosAbastecidos, litrosAbastecidosArla, pricePerLiter, confirmedReading, confirmedBy, outrosValor } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orders] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (orders.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        const order = orders[0];

        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [order.vehicleId]);
        const vehicle = vehicles[0];
        
        const vehicleUpdate = {};
        const readingVal = safeNum(confirmedReading);

        if (readingVal) {
            if (vehicle.possuiHorimetroDigital) {
                vehicleUpdate.horimetroDigital = readingVal;
                vehicleUpdate.horimetro = readingVal; 
            } else if (vehicle.possuiHorimetroAnalogico) {
                vehicleUpdate.horimetroAnalogico = readingVal;
                vehicleUpdate.horimetro = readingVal;
            } else if (vehicle.tipo === 'Caminhão' || vehicle.mediaCalculo === 'horimetro') {
                if (order.horimetro || (!order.odometro && !order.horimetro)) {
                     vehicleUpdate.horimetro = readingVal;
                } else {
                     vehicleUpdate.odometro = readingVal;
                }
            } else {
                vehicleUpdate.odometro = readingVal;
            }
        }

        if (Object.keys(vehicleUpdate).length > 0) {
            const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE vehicles SET ${vFields} WHERE id = ?`, [...Object.values(vehicleUpdate), order.vehicleId]);
        }

        const safePrice = safeNum(pricePerLiter, true);
        if (order.partnerId && safePrice > 0 && order.fuelType) {
            const priceQuery = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price) 
                VALUES (?, ?, ?) 
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            await connection.execute(priceQuery, [order.partnerId, order.fuelType, safePrice]);
        }

        const orderUpdate = {
            status: 'Concluída',
            litrosAbastecidos: safeNum(litrosAbastecidos, true),
            litrosAbastecidosArla: safeNum(litrosAbastecidosArla, true),
            pricePerLiter: safePrice,
            confirmedBy: JSON.stringify(confirmedBy),
            outrosValor: safeNum(outrosValor, true),
            ...(vehicleUpdate.odometro ? { odometro: vehicleUpdate.odometro } : {}),
            ...(vehicleUpdate.horimetro ? { horimetro: vehicleUpdate.horimetro } : {}),
            ...(vehicleUpdate.horimetroDigital ? { horimetroDigital: vehicleUpdate.horimetroDigital } : {}),
        };

        const oFields = Object.keys(orderUpdate).map(k => `${k} = ?`).join(', ');
        await connection.execute(`UPDATE refuelings SET ${oFields} WHERE id = ?`, [...Object.values(orderUpdate), id]);

        if (order.obraId && order.partnerId && order.fuelType) {
            await updateMonthlyExpense(connection, order.obraId, order.partnerId, order.fuelType, order.data);
        }

        await connection.commit();
        res.json({ message: 'Abastecimento confirmado com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CONFIRM:', error);
        res.status(500).json({ error: 'Erro ao confirmar: ' + error.message });
    } finally {
        connection.release();
    }
};

// --- DELETE ---
const deleteRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [rows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (rows.length === 0) {
             await connection.rollback();
             return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        const ref = rows[0];

        await connection.execute('DELETE FROM refuelings WHERE id = ?', [id]);

        if (ref.obraId && ref.partnerId && ref.fuelType) {
            await updateMonthlyExpense(connection, ref.obraId, ref.partnerId, ref.fuelType, ref.data);
        }

        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro DELETE:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem.' });
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