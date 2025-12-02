// controllers/refuelingController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');

// --- HELPER: Conversão Numérica Segura para MySQL ---
// O MySQL Strict Mode rejeita '' para campos Decimal/Int. Isso converte '' ou NaN para null ou 0.
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
        // Garante que números venham como números do banco
        litrosAbastecidos: row.litrosAbastecidos ? parseFloat(row.litrosAbastecidos) : 0,
        pricePerLiter: row.pricePerLiter ? parseFloat(row.pricePerLiter) : 0,
        outrosValor: row.outrosValor ? parseFloat(row.outrosValor) : 0,
    }));
};

// --- READ: Obter todas as ordens ---
const getAllRefuelings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings ORDER BY id DESC');
        res.json(parseRefuelingRows(rows));
    } catch (error) {
        console.error('Erro ao buscar abastecimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimentos' });
    }
};

// --- READ: Obter por ID ---
const getRefuelingById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Abastecimento não encontrado' });
        res.json(parseRefuelingRows(rows)[0]);
    } catch (error) {
        console.error('Erro ao buscar abastecimento:', error);
        res.status(500).json({ error: 'Erro ao buscar abastecimento' });
    }
};

// --- CREATE: Criar Ordem ---
const createRefuelingOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Gerador de Número de Autorização Sequencial
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;

        // Sanitização de Data: Garante ISO 8601 (Fix Safari/Legacy)
        let dataAbastecimento = new Date();
        if (data.date) {
             // Se vier apenas data (YYYY-MM-DD), adiciona hora fixa para evitar flutuação de timezone
             const dateStr = data.date.toString().includes('T') ? data.date : `${data.date}T12:00:00`;
             dataAbastecimento = new Date(dateStr);
        }

        const refuelingData = {
            authNumber: newAuthNumber,
            vehicleId: data.vehicleId,
            partnerId: data.partnerId,
            partnerName: data.partnerName,
            employeeId: data.employeeId,
            obraId: safeNum(data.obraId) ? data.obraId : null,
            fuelType: data.fuelType,
            data: dataAbastecimento,
            status: data.status || 'Aberta',
            
            // Flags Booleanas (MySQL usa 1/0)
            isFillUp: data.isFillUp ? 1 : 0,
            needsArla: data.needsArla ? 1 : 0,
            isFillUpArla: data.isFillUpArla ? 1 : 0,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0,
            
            // Campos Numéricos Sanitizados (Evita erro 500 por string vazia)
            litrosLiberados: safeNum(data.litrosLiberados, true),
            litrosLiberadosArla: safeNum(data.litrosLiberadosArla, true),
            odometro: safeNum(data.odometro),
            horimetro: safeNum(data.horimetro),
            horimetroDigital: safeNum(data.horimetroDigital),
            horimetroAnalogico: safeNum(data.horimetroAnalogico),
            outrosValor: safeNum(data.outrosValor, true),
            
            // Campos de Texto/JSON
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

        // Lógica para ordens já nascidas "Concluídas" (se houver necessidade futura)
        if (refuelingData.status === 'Concluída') {
            const vehicleUpdate = {};
            if (refuelingData.odometro) vehicleUpdate.odometro = refuelingData.odometro;
            if (refuelingData.horimetro) vehicleUpdate.horimetro = refuelingData.horimetro;
            if (refuelingData.horimetroDigital) vehicleUpdate.horimetroDigital = refuelingData.horimetroDigital;
            
            if (Object.keys(vehicleUpdate).length > 0) {
                const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
                await connection.execute(`UPDATE vehicles SET ${vFields} WHERE id = ?`, [...Object.values(vehicleUpdate), refuelingData.vehicleId]);
            }
        }

        await connection.commit();
        res.status(201).json({ id: newAuthNumber, message: 'Ordem emitida.', authNumber: newAuthNumber });
    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE refueling:', error);
        res.status(500).json({ error: 'Falha ao criar ordem: ' + error.message });
    } finally {
        connection.release();
    }
};

// --- UPDATE: Atualizar Ordem ---
const updateRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const updateData = {};
        
        // Sanitização Data
        if (data.date) {
            const dateStr = data.date.toString().replace(' ', 'T');
            updateData.data = new Date(dateStr);
        }
        if (data.editedBy) updateData.editedBy = JSON.stringify(data.editedBy);
        if (data.status) updateData.status = data.status;
        
        // Numéricos Seguros
        if (data.litrosLiberados !== undefined) updateData.litrosLiberados = safeNum(data.litrosLiberados, true);
        if (data.odometro !== undefined) updateData.odometro = safeNum(data.odometro);
        if (data.horimetro !== undefined) updateData.horimetro = safeNum(data.horimetro);
        if (data.horimetroDigital !== undefined) updateData.horimetroDigital = safeNum(data.horimetroDigital);
        if (data.horimetroAnalogico !== undefined) updateData.horimetroAnalogico = safeNum(data.horimetroAnalogico);
        if (data.outrosValor !== undefined) updateData.outrosValor = safeNum(data.outrosValor, true);

        // Remove undefined
        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        if (Object.keys(updateData).length > 0) {
            const setClause = Object.keys(updateData).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE refuelings SET ${setClause} WHERE id = ?`, [...Object.values(updateData), id]);
        }

        await connection.commit();
        res.json({ message: 'Ordem atualizada.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE refueling:', error);
        res.status(500).json({ error: 'Falha ao atualizar ordem.' });
    } finally {
        connection.release();
    }
};

// --- CONFIRM: Confirmar Abastecimento (CRÍTICO: PREÇOS E INTEGRIDADE) ---
const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const { litrosAbastecidos, litrosAbastecidosArla, pricePerLiter, confirmedReading, confirmedBy, outrosValor } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Busca Ordem e Lock
        const [orders] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (orders.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        const order = orders[0];

        // 2. Determina atualização do Veículo
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [order.vehicleId]);
        const vehicle = vehicles[0];
        
        const vehicleUpdate = {};
        const readingVal = safeNum(confirmedReading);

        if (readingVal) {
            if (vehicle.possuiHorimetroDigital) {
                vehicleUpdate.horimetroDigital = readingVal;
                vehicleUpdate.horimetro = readingVal; // Sync
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

        // 3. Atualiza Veículo
        if (Object.keys(vehicleUpdate).length > 0) {
            const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE vehicles SET ${vFields} WHERE id = ?`, [...Object.values(vehicleUpdate), order.vehicleId]);
        }

        // 4. Atualiza Tabela de Preços do Parceiro (CORREÇÃO DA MIGRAÇÃO)
        const safePrice = safeNum(pricePerLiter, true);
        if (order.partnerId && safePrice > 0 && order.fuelType) {
            const priceQuery = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price) 
                VALUES (?, ?, ?) 
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            await connection.execute(priceQuery, [order.partnerId, order.fuelType, safePrice]);
        }

        // 5. Atualiza a Ordem para Concluída
        const orderUpdate = {
            status: 'Concluída',
            litrosAbastecidos: safeNum(litrosAbastecidos, true),
            litrosAbastecidosArla: safeNum(litrosAbastecidosArla, true),
            pricePerLiter: safePrice,
            confirmedBy: JSON.stringify(confirmedBy),
            outrosValor: safeNum(outrosValor, true),
            // Salva a leitura confirmada no histórico da ordem para garantir cálculo de média
            ...(vehicleUpdate.odometro ? { odometro: vehicleUpdate.odometro } : {}),
            ...(vehicleUpdate.horimetro ? { horimetro: vehicleUpdate.horimetro } : {}),
            ...(vehicleUpdate.horimetroDigital ? { horimetroDigital: vehicleUpdate.horimetroDigital } : {}),
        };

        const oFields = Object.keys(orderUpdate).map(k => `${k} = ?`).join(', ');
        await connection.execute(`UPDATE refuelings SET ${oFields} WHERE id = ?`, [...Object.values(orderUpdate), id]);

        // 6. Lança Despesa Financeira
        const valorTotal = (orderUpdate.litrosAbastecidos * orderUpdate.pricePerLiter) + orderUpdate.outrosValor;
        if (valorTotal > 0 && order.obraId) {
             let pName = order.partnerName;
             if (!pName && order.partnerId) {
                 const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [order.partnerId]);
                 if (pRows[0]) pName = pRows[0].razaoSocial;
             }
             
             await createOrUpdateWeeklyFuelExpense({
                 connection,
                 obraId: order.obraId,
                 date: order.data,
                 fuelType: order.fuelType,
                 partnerName: pName || 'Posto Externo',
                 valueChange: valorTotal
             });
        }

        await connection.commit();
        res.json({ message: 'Abastecimento confirmado com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CONFIRM refueling:', error);
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

        // Estorno Financeiro
        if (ref.status === 'Concluída' && ref.obraId) {
            const valor = (parseFloat(ref.litrosAbastecidos || 0) * parseFloat(ref.pricePerLiter || 0)) + parseFloat(ref.outrosValor || 0);
            if (valor > 0) {
                 await createOrUpdateWeeklyFuelExpense({
                     connection,
                     obraId: ref.obraId,
                     date: ref.data,
                     fuelType: ref.fuelType,
                     partnerName: ref.partnerName || 'Posto',
                     valueChange: -valor // Negativo para estornar
                 });
            }
        }

        await connection.execute('DELETE FROM refuelings WHERE id = ?', [id]);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro DELETE refueling:', error);
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