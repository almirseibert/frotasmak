// controllers/refuelingController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');
const { parseVehicleJsonFields } = require('./vehicleController');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro (parseJsonSafe) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field; 
    if (typeof field !== 'string') return field;

    try {
        const parsed = JSON.parse(field);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        return null; 
    }
};

// --- Função Auxiliar para Conversão de JSON ---
const parseRefuelingJsonFields = (refueling) => {
    if (!refueling) return null;
    const newRefueling = { ...refueling };
    
    newRefueling.createdBy = parseJsonSafe(newRefueling.createdBy, 'createdBy');
    newRefueling.confirmedBy = parseJsonSafe(newRefueling.confirmedBy, 'confirmedBy');
    newRefueling.editedBy = parseJsonSafe(newRefueling.editedBy, 'editedBy');

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

        // Prepara objeto para inserção
        const refuelingData = {
            ...data,
            authNumber: newAuthNumber,
            data: new Date(data.data),
            createdBy: JSON.stringify(data.createdBy),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null,
            // Garante campos numéricos
            odometro: data.odometro || null,
            horimetro: data.horimetro || null,
            horimetroDigital: data.horimetroDigital || null,
            horimetroAnalogico: data.horimetroAnalogico || null,
            // Novos campos
            outrosValor: data.outrosValor || 0,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0 // MySQL boolean
        };

        await connection.execute('INSERT INTO refuelings SET ?', [refuelingData]);
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        // Se já nascer concluída (cenário raro, mas possível via API direta)
        if (refuelingData.status === 'Concluída') {
            const vehicleUpdateData = {};
            // Atualiza leitura do veículo
            if (refuelingData.odometro) vehicleUpdateData.odometro = refuelingData.odometro;
            if (refuelingData.horimetro) vehicleUpdateData.horimetro = refuelingData.horimetro;
            if (refuelingData.horimetroDigital) vehicleUpdateData.horimetroDigital = refuelingData.horimetroDigital;
            if (refuelingData.horimetroAnalogico) vehicleUpdateData.horimetroAnalogico = refuelingData.horimetroAnalogico;
            
            if (Object.keys(vehicleUpdateData).length > 0) {
                await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, refuelingData.vehicleId]);
            }

            // Gera despesa incluindo Outros Valor
            const valorTotal = (refuelingData.litrosAbastecidos || 0) * (refuelingData.pricePerLiter || 0) + (parseFloat(refuelingData.outrosValor) || 0);
            
            await createOrUpdateWeeklyFuelExpense({ 
                connection, 
                obraId: refuelingData.obraId, 
                date: refuelingData.data, 
                fuelType: refuelingData.fuelType, 
                partnerName: refuelingData.partnerName, 
                valueChange: valorTotal 
            });
        }
        
        await connection.commit();
        res.status(201).json({ id: newAuthNumber, message: 'Ordem emitida com sucesso.', authNumber: newAuthNumber, status: 'Aberta' });
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
        if (originalRefuelingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        
        const refuelingUpdateData = {
            ...data,
            data: data.data ? new Date(data.data) : undefined,
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : undefined,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : undefined,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0
        };
        
        // Remove undefined keys
        Object.keys(refuelingUpdateData).forEach(key => refuelingUpdateData[key] === undefined && delete refuelingUpdateData[key]);

        await connection.execute('UPDATE refuelings SET ? WHERE id = ?', [refuelingUpdateData, id]);
        
        await connection.commit();
        res.status(200).json({ message: 'Ordem atualizada com sucesso.', authNumber: originalRefuelingRows[0].authNumber });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar ordem:', error);
        res.status(500).json({ error: 'Falha ao atualizar a ordem.' });
    } finally {
        connection.release();
    }
};


// --- ROTA: Confirmar um abastecimento em aberto (CRÍTICO: ATUALIZA VEÍCULO, PREÇO E PARCEIRO) ---
const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const { litrosAbastecidos, litrosAbastecidosArla, pricePerLiter, confirmedReading, confirmedBy, outrosValor } = req.body; 
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Busca a Ordem
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

        // 2. Busca o Veículo
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [order.vehicleId]);
        const vehicle = vehicleRows[0];
        
        // 3. Atualiza o Veículo (Leituras)
        const vehicleUpdateData = {};
        const orderUpdateData = {};

        if (confirmedReading) {
            if (vehicle.possuiHorimetroDigital) {
                vehicleUpdateData.horimetroDigital = confirmedReading;
                vehicleUpdateData.horimetro = confirmedReading; 
                orderUpdateData.horimetroDigital = confirmedReading;
            } else if (vehicle.possuiHorimetroAnalogico) {
                vehicleUpdateData.horimetroAnalogico = confirmedReading;
                vehicleUpdateData.horimetro = confirmedReading;
                orderUpdateData.horimetroAnalogico = confirmedReading;
            } else if (vehicle.tipo === 'Caminhão' || vehicle.mediaCalculo === 'horimetro') { 
                 if (order.horimetro || (!order.odometro && !order.horimetro)) { 
                     vehicleUpdateData.horimetro = confirmedReading;
                     orderUpdateData.horimetro = confirmedReading;
                 } else {
                     vehicleUpdateData.odometro = confirmedReading;
                     orderUpdateData.odometro = confirmedReading;
                 }
            } else {
                vehicleUpdateData.odometro = confirmedReading;
                orderUpdateData.odometro = confirmedReading;
            }
        }

        // 4. Atualiza a Ordem
        await connection.execute('UPDATE refuelings SET status = ?, litrosAbastecidos = ?, litrosAbastecidosArla = ?, pricePerLiter = ?, confirmedBy = ?, outrosValor = ?, ? WHERE id = ?', [
            'Concluída',
            litrosAbastecidos,
            litrosAbastecidosArla,
            pricePerLiter || null,
            JSON.stringify(confirmedBy),
            outrosValor || 0,
            orderUpdateData, 
            id
        ]);
        
        if (Object.keys(vehicleUpdateData).length > 0) {
            await connection.execute('UPDATE vehicles SET ? WHERE id = ?', [vehicleUpdateData, order.vehicleId]);
        }

        // 5. ATUALIZAR PREÇO DO COMBUSTÍVEL NO PARCEIRO (NOVO)
        if (order.partnerId && pricePerLiter > 0 && order.fuelType) {
            // Busca o parceiro atual
            const [partnerRows] = await connection.execute('SELECT fuel_prices FROM partners WHERE id = ?', [order.partnerId]);
            
            if (partnerRows.length > 0) {
                let currentPrices = {};
                try {
                    // Tenta parsear o JSON existente, se não, cria objeto vazio
                    currentPrices = typeof partnerRows[0].fuel_prices === 'string' 
                        ? JSON.parse(partnerRows[0].fuel_prices) 
                        : (partnerRows[0].fuel_prices || {});
                } catch (e) {
                    currentPrices = {};
                }

                // Atualiza o preço apenas do combustível específico
                currentPrices[order.fuelType] = parseFloat(pricePerLiter);

                // Salva de volta no banco
                await connection.execute('UPDATE partners SET fuel_prices = ? WHERE id = ?', [
                    JSON.stringify(currentPrices),
                    order.partnerId
                ]);
            }
        }

        // 6. Gera Despesa (Financeiro)
        let partnerName = order.partnerName;
        if (!partnerName) {
            const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [order.partnerId]);
            if (pRows.length > 0) partnerName = pRows[0].razaoSocial;
        }

        const valorCombustivel = (parseFloat(litrosAbastecidos) * parseFloat(pricePerLiter || 0));
        const valorExtra = parseFloat(outrosValor || 0);
        const valorTotal = valorCombustivel + valorExtra;
        
        if (valorTotal > 0 && order.obraId) {
             await createOrUpdateWeeklyFuelExpense({ 
                 connection, 
                 obraId: order.obraId, 
                 date: order.data, 
                 fuelType: order.fuelType, 
                 partnerName: partnerName || 'Posto Desconhecido', 
                 valueChange: valorTotal 
             });
        }
        
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
        if (refuelingRows.length === 0) {
             await connection.rollback();
             return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        
        const refueling = parseRefuelingJsonFields(refuelingRows[0]);
        
        // Estorno da Despesa se já foi concluída
        if (refueling.status === 'Concluída') {
            const valorTotal = (parseFloat(refueling.litrosAbastecidos) * parseFloat(refueling.pricePerLiter || 0)) + (parseFloat(refueling.outrosValor) || 0);
            if (valorTotal > 0 && refueling.obraId) {
                // Passa valor negativo para subtrair
                await createOrUpdateWeeklyFuelExpense({ 
                    connection, 
                    obraId: refueling.obraId, 
                    date: refueling.data, 
                    fuelType: refueling.fuelType, 
                    partnerName: refueling.partnerName || 'Posto', 
                    valueChange: -valorTotal 
                });
            }
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