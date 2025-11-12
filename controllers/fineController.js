// controllers/fineController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid'); // Importa o gerador de UUID

// --- Função Auxiliar para Conversão de JSON (Mantida para 'ultimaAlteracao') ---
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

// --- (CORRIGIDO) Função Auxiliar para formatar a multa para o frontend ---
// Ela pega os dados do JOIN e os transforma nos objetos JSON esperados
// E TRADUZ os nomes das colunas do banco (ex: paymentStatus) para os nomes do frontend (ex: status)
const formatFineForFrontend = (fine) => {
    if (!fine) return null;

    // Renomeia os campos do banco para os campos do frontend
    const {
        paymentStatus,
        localInfracao,
        codigoInfracao,
        ...rest
    } = fine;

    const newFine = {
        ...rest,
        status: paymentStatus,         // Traduz paymentStatus -> status
        local: localInfracao,          // Traduz localInfracao -> local
        codigoInfração: codigoInfracao,  // Traduz codigoInfracao -> codigoInfração
    };

    // 1. Cria os objetos esperados pelo frontend
    newFine.vehicleInfo = {
        registroInterno: fine.vehicleRegistroInterno, // Pego do JOIN
        placa: fine.vehiclePlaca                 // Pego do JOIN
    };
    newFine.employeeInfo = {
        nome: fine.employeeName                   // Pego do JOIN
    };

    // 2. Parseia o JSON que já existe (ultimaAlteracao)
    newFine.ultimaAlteracao = parseJsonSafe(fine.ultimaAlteracao, 'ultimaAlteracao');

    // 3. Remove os campos "planos" para evitar duplicidade
    delete newFine.vehicleRegistroInterno;
    delete newFine.vehiclePlaca;
    delete newFine.employeeName;

    return newFine;
};

// --- READ: Obter todas as multas (Corrigido com JOIN) ---
const getAllFines = async (req, res) => {
    try {
        // Query que "enriquece" a multa com dados do veículo e funcionário
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
        // Formata cada linha (e traduz os campos) para o formato que o frontend espera
        res.json(rows.map(formatFineForFrontend));
    } catch (error) {
        console.error('Erro ao buscar multas:', error);
        res.status(500).json({ error: 'Erro ao buscar multas' });
    }
};

// --- READ: Obter uma única multa por ID (Corrigido com JOIN) ---
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
        // Formata a linha (e traduz os campos) para o formato que o frontend espera
        res.json(formatFineForFrontend(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar multa:', error);
        res.status(500).json({ error: 'Erro ao buscar multa' });
    }
};

// --- Função auxiliar para buscar infos de Veículo e Funcionário ---
const getInfoObjects = async (vehicleId, employeeId) => {
    let vehicleInfo = null;
    let employeeInfo = null;

    if (vehicleId) {
        const [vRows] = await db.execute('SELECT registroInterno, placa FROM vehicles WHERE id = ?', [vehicleId]);
        if (vRows.length > 0) vehicleInfo = vRows[0];
    }
    if (employeeId) {
        const [eRows] = await db.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
        if (eRows.length > 0) employeeInfo = eRows[0];
    }
    
    return { vehicleInfo, employeeInfo };
};


// --- CREATE: Criar uma nova multa (CORRIGIDO para Erro 500) ---
const createFine = async (req, res) => {
    const dataFromFrontend = req.body;
    
    // 1. Gera o ID da multa (o banco de dados é VARCHAR)
    const newFineId = uuidv4();
    
    try {
        // 2. Busca os dados do veículo e funcionário para popular os campos JSON
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);
        
        // 3. Pega o usuário logado (assumindo que o authMiddleware o adiciona)
        let ultimaAlteracao = null;
        if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
        // 4. *** CORREÇÃO: Traduz os nomes do frontend para os nomes do BD ***
        const dataForDB = {
            id: newFineId,
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local, // Traduzido
            codigoInfracao: dataFromFrontend.codigoInfração, // Traduzido
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status, // Traduzido
            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        // 5. Constrói a query de inserção
        const fields = Object.keys(dataForDB);
        const values = Object.values(dataForDB);
        const placeholders = fields.map(() => '?').join(', ');
        const query = `INSERT INTO fines (${fields.join(', ')}) VALUES (${placeholders})`;

        // 6. Executa
        await db.execute(query, values);
        res.status(201).json({ id: newFineId, ...dataFromFrontend }); // Retorna os dados do frontend
    } catch (error) {
        console.error('Erro ao criar multa:', error);
        // Loga o erro específico do SQL, se houver
        if (error.sqlMessage) {
            console.error('SQL Error:', error.sqlMessage);
        }
        res.status(500).json({ error: 'Erro ao criar multa' });
    }
};

// --- UPDATE: Atualizar uma multa existente (CORRIGIDO para Erro 500) ---
const updateFine = async (req, res) => {
    const { id } = req.params;
    const dataFromFrontend = req.body;

    try {
        // 1. Busca os dados do veículo e funcionário para ATUALIZAR os campos JSON
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);

        // 2. Pega o usuário logado
         let ultimaAlteracao = null;
         if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
        // 3. *** CORREÇÃO: Traduz os nomes do frontend para os nomes do BD ***
         const dataForDB = {
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local, // Traduzido
            codigoInfracao: dataFromFrontend.codigoInfração, // Traduzido
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status, // Traduzido
            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        // 4. Constrói a query
        const fields = Object.keys(dataForDB);
        const values = fields.map(key => dataForDB[key]); // Pega os valores na ordem correta
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const query = `UPDATE fines SET ${setClause} WHERE id = ?`;

        // 5. Executa
        await db.execute(query, [...values, id]);
        res.json({ message: 'Multa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar multa:', error);
         // Loga o erro específico do SQL, se houver
        if (error.sqlMessage) {
            console.error('SQL Error:', error.sqlMessage);
        }
        res.status(500).json({ error: 'Erro ao atualizar multa' });
    }
};

// --- DELETE: Deletar uma multa (Sem alterações, já estava OK) ---
const deleteFine = async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM fines WHERE id = ?', [req.params.id]);
         if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Multa não encontrada.' });
        }
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