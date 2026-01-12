// controllers/fineController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// --- Função Auxiliar para Conversão de JSON ---
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

// --- Formatação para Frontend ---
const formatFineForFrontend = (fine) => {
    if (!fine) return null;

    const {
        paymentStatus,
        localInfracao,
        codigoInfracao,
        descontarFuncionario, // Mapeamento legado se houver
        multaNomeFuncionario, // Mapeamento legado se houver
        ...rest
    } = fine;

    const newFine = {
        ...rest,
        status: paymentStatus,
        local: localInfracao,
        codigoInfração: codigoInfracao,
        // Garante que os booleanos sejam retornados corretamente
        discountFromEmployee: !!fine.discountFromEmployee,
        alreadyInEmployeeName: !!fine.alreadyInEmployeeName
    };

    newFine.vehicleInfo = {
        registroInterno: fine.vehicleRegistroInterno,
        placa: fine.vehiclePlaca
    };
    newFine.employeeInfo = {
        nome: fine.employeeName
    };

    newFine.ultimaAlteracao = parseJsonSafe(fine.ultimaAlteracao, 'ultimaAlteracao');

    delete newFine.vehicleRegistroInterno;
    delete newFine.vehiclePlaca;
    delete newFine.employeeName;

    return newFine;
};

// --- READ: Obter todas as multas ---
const getAllFines = async (req, res) => {
    try {
        const query = `
            SELECT 
                f.*,
                v.registroInterno as vehicleRegistroInterno,
                v.placa as vehiclePlaca,
                e.nome as employeeName
            FROM fines f
            LEFT JOIN vehicles v ON f.vehicleId = v.id
            LEFT JOIN employees e ON f.employeeId = e.id
            ORDER BY f.dataInfração DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows.map(formatFineForFrontend));
    } catch (error) {
        console.error('Erro ao buscar multas:', error);
        res.status(500).json({ error: 'Erro ao buscar multas' });
    }
};

// --- READ: Obter multa por ID ---
const getFineById = async (req, res) => {
    try {
         const query = `
            SELECT 
                f.*,
                v.registroInterno as vehicleRegistroInterno,
                v.placa as vehiclePlaca,
                e.nome as employeeName
            FROM fines f
            LEFT JOIN vehicles v ON f.vehicleId = v.id
            LEFT JOIN employees e ON f.employeeId = e.id
            WHERE f.id = ?
        `;
        const [rows] = await db.execute(query, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Multa não encontrada' });
        }
        res.json(formatFineForFrontend(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar multa:', error);
        res.status(500).json({ error: 'Erro ao buscar multa' });
    }
};

const getInfoObjects = async (vehicleId, employeeId) => {
    let vehicleInfo = null;
    let employeeInfo = null;

    if (vehicleId) {
        const [vRows] = await db.execute('SELECT registroInterno, placa, modelo, marca FROM vehicles WHERE id = ?', [vehicleId]);
        if (vRows.length > 0) vehicleInfo = vRows[0];
    }
    if (employeeId) {
        const [eRows] = await db.execute('SELECT nome, cpf FROM employees WHERE id = ?', [employeeId]);
        if (eRows.length > 0) employeeInfo = eRows[0];
    }
    
    return { vehicleInfo, employeeInfo };
};


// --- CREATE ---
const createFine = async (req, res) => {
    const dataFromFrontend = req.body;
    const newFineId = uuidv4();
    
    try {
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);
        
        let ultimaAlteracao = null;
        if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
        const dataForDB = {
            id: newFineId,
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local,
            codigoInfracao: dataFromFrontend.codigoInfração,
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status,
            // NOVOS CAMPOS
            discountFromEmployee: dataFromFrontend.discountFromEmployee ? 1 : 0,
            alreadyInEmployeeName: dataFromFrontend.alreadyInEmployeeName ? 1 : 0,
            
            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        const fields = Object.keys(dataForDB);
        const values = Object.values(dataForDB);
        const placeholders = fields.map(() => '?').join(', ');
        const query = `INSERT INTO fines (${fields.join(', ')}) VALUES (${placeholders})`;

        await db.execute(query, values);

        req.io.emit('server:sync', { targets: ['fines'] });
        res.status(201).json({ id: newFineId, ...dataFromFrontend });
    } catch (error) {
        console.error('Erro ao criar multa:', error);
        if (error.sqlMessage) console.error('SQL Error:', error.sqlMessage);
        res.status(500).json({ error: 'Erro ao criar multa' });
    }
};

// --- UPDATE ---
const updateFine = async (req, res) => {
    const { id } = req.params;
    const dataFromFrontend = req.body;

    try {
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);

         let ultimaAlteracao = null;
         if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
         const dataForDB = {
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local,
            codigoInfracao: dataFromFrontend.codigoInfração,
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status,
            // NOVOS CAMPOS
            discountFromEmployee: dataFromFrontend.discountFromEmployee ? 1 : 0,
            alreadyInEmployeeName: dataFromFrontend.alreadyInEmployeeName ? 1 : 0,

            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        const fields = Object.keys(dataForDB);
        const values = fields.map(key => dataForDB[key]);
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const query = `UPDATE fines SET ${setClause} WHERE id = ?`;

        await db.execute(query, [...values, id]);

        req.io.emit('server:sync', { targets: ['fines'] });
        res.json({ message: 'Multa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar multa:', error);
        if (error.sqlMessage) console.error('SQL Error:', error.sqlMessage);
        res.status(500).json({ error: 'Erro ao atualizar multa' });
    }
};

// --- DELETE ---
const deleteFine = async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM fines WHERE id = ?', [req.params.id]);
         if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Multa não encontrada.' });
        }
        req.io.emit('server:sync', { targets: ['fines'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar multa:', error);
        res.status(500).json({ error: 'Erro ao deletar multa' });
    }
};

module.exports = {
    getAllFines,
    getFineById,
    createFine,
    updateFine,
    deleteFine,
};