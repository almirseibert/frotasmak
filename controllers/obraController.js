const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// ===================================================================================
// FUNÇÃO AUXILIAR DE PARSE SEGURO
// ===================================================================================
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string' || (!field.startsWith('{') && !field.startsWith('['))) {
        return defaultValue; 
    }

    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
    } catch (e) {
        console.warn(`[JSON Parse Warning] Campo '${key}' não é JSON. Valor problemático:`, field);
        return defaultValue;
    }
};

const parseObraJsonFields = (obra) => {
    if (!obra) return null;
    const newObra = { ...obra };
    const fieldsToParse = ['horasContratadasPorTipo', 'sectors', 'alocadoEm', 'ultimaAlteracao'];
    fieldsToParse.forEach(field => {
        if (obra.hasOwnProperty(field)) {
            newObra[field] = parseJsonSafe(obra[field], field);
        }
    });
    return newObra;
};

// --- GET ALL OBRAS (Com Soma de Horas do Faturamento) ---
const getAllObras = async (req, res) => {
    try {
        // Busca obras básicas
        const [rows] = await db.query('SELECT * FROM obras');
        
        // Busca histórico de alocação (mantido para contagem de veículos ativos)
        const [historyRows] = await db.query('SELECT * FROM obras_historico_veiculos');

        // NOVA LÓGICA: Busca soma de horas apontadas no Faturamento (daily_work_logs) agrupadas por Obra
        const [billingRows] = await db.query(`
            SELECT obraId, SUM(totalHours) as totalHorasRealizadas 
            FROM daily_work_logs 
            GROUP BY obraId
        `);

        // Mapa para acesso rápido ao faturamento
        const billingMap = {};
        billingRows.forEach(row => {
            billingMap[row.obraId] = parseFloat(row.totalHorasRealizadas) || 0;
        });

        const obras = rows.map(obra => {
            const parsedObra = parseObraJsonFields(obra);
            
            // Anexa histórico
            parsedObra.historicoVeiculos = historyRows
                .filter(h => h.obraId === parsedObra.id)
                .sort((a, b) => new Date(b.dataEntrada) - new Date(a.dataEntrada));
            
            // Anexa total realizado via Faturamento
            parsedObra.totalHorasRealizadas = billingMap[parsedObra.id] || 0;
                
            return parsedObra;
        });
        
        res.json(obras);
    } catch (error) {
        console.error('Erro ao buscar obras:', error);
        res.status(500).json({ error: 'Erro ao buscar obras' });
    }
};

// --- GET OBRA BY ID (Com Detalhamento por Tipo do Faturamento) ---
const getObraById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM obras WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Obra não encontrada' });
        }
        
        const [historyRows] = await db.query(
            'SELECT * FROM obras_historico_veiculos WHERE obraId = ? ORDER BY dataEntrada DESC', 
            [req.params.id]
        );

        // NOVA LÓGICA: Busca horas realizadas agrupadas por TIPO DE VEÍCULO (Join com vehicles)
        // Isso alimenta as barras de progresso detalhadas
        const [billingByTypeRows] = await db.query(`
            SELECT v.tipo, SUM(l.totalHours) as totalHoras
            FROM daily_work_logs l
            JOIN vehicles v ON l.vehicleId = v.id
            WHERE l.obraId = ?
            GROUP BY v.tipo
        `, [req.params.id]);

        const realizadoPorTipo = {};
        let totalRealizadoGeral = 0;

        billingByTypeRows.forEach(row => {
            realizadoPorTipo[row.tipo] = parseFloat(row.totalHoras) || 0;
            totalRealizadoGeral += parseFloat(row.totalHoras) || 0;
        });
        
        const obra = parseObraJsonFields(rows[0]);
        
        obra.historicoVeiculos = historyRows; 
        
        // Novos campos injetados para o Frontend usar no modal de detalhes
        obra.realizadoPorTipo = realizadoPorTipo; 
        obra.totalHorasRealizadas = totalRealizadoGeral;

        res.json(obra);
    } catch (error) {
        console.error('Erro ao buscar obra por ID:', error);
        res.status(500).json({ error: 'Erro ao buscar obra' });
    }
};

// --- CREATE OBRA ---
const createObra = async (req, res) => {
    const data = { ...req.body };
    data.id = uuidv4();

    delete data.historicoVeiculos; 
    delete data.realizadoPorTipo; // Remove campos calculados se vierem por engano
    delete data.totalHorasRealizadas;

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);
    
    if (data.latitude === '') data.latitude = null;
    if (data.longitude === '') data.longitude = null;

    data.status = 'ativa';

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO obras (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        res.status(201).json({ message: 'Obra criada com sucesso' });
    } catch (error) {
        console.error('Erro ao criar obra:', error);
        res.status(500).json({ error: 'Erro ao criar obra' });
    }
};

// --- UPDATE OBRA ---
const updateObra = async (req, res) => {
    const { id } = req.params;
    const data = { ...req.body };
    
    // Limpeza de campos que não existem na tabela ou são somente leitura/calculados
    delete data.historicoVeiculos;
    delete data.realizadoPorTipo;
    delete data.totalHorasRealizadas;
    delete data.id;

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    if (data.latitude === '') data.latitude = null;
    if (data.longitude === '') data.longitude = null;

    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    if(fields.length === 0){
        return res.status(400).json({ error: 'Nenhum dado para atualizar.' });
    }
    
    const query = `UPDATE obras SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Obra atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar obra:', error);
        res.status(500).json({ error: 'Erro ao atualizar obra' });
    }
};

// --- DELETE OBRA ---
const deleteObra = async (req, res) => {
    try {
        await db.execute('DELETE FROM obras WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar obra:', error);
        res.status(500).json({ error: 'Erro ao deletar obra' });
    }
};

// --- FINISH OBRA ---
const finishObra = async (req, res) => {
    const { id } = req.params;
    const { dataFim } = req.body;
    const finalDate = dataFim ? new Date(dataFim) : new Date();

    try {
        const [result] = await db.execute(
            "UPDATE obras SET status = 'finalizada', dataFim = ? WHERE id = ?",
            [finalDate, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Obra não encontrada.' });
        }
        res.json({ message: 'Obra finalizada com sucesso.' });
    } catch (error) {
        console.error('Erro ao finalizar obra:', error);
        res.status(500).json({ message: 'Erro interno do servidor ao finalizar a obra.' });
    }
};

// --- UPDATE HISTORICO (Mantido para correções de apontamento de alocação se necessário) ---
const updateObraHistoryEntry = async (req, res) => {
    const { historyId } = req.params;
    const { dataEntrada, dataSaida, employeeId, leituraEntrada, leituraSaida } = req.body;

    let employeeName = null;
    if (employeeId) {
        try {
            const [empRows] = await db.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
            if (empRows.length > 0) employeeName = empRows[0].nome;
        } catch (e) { console.warn("Erro ao buscar nome funcionário"); }
    }

    let odometroEntrada = null, horimetroEntrada = null, odometroSaida = null, horimetroSaida = null;

    try {
        const [currentHistory] = await db.execute('SELECT * FROM obras_historico_veiculos WHERE id = ?', [historyId]);
        if (currentHistory.length === 0) return res.status(404).json({ error: 'Histórico não encontrado.' });

        const history = currentHistory[0];
        
        if (history.odometroEntrada !== null) {
            odometroEntrada = parseFloat(leituraEntrada) || null;
            odometroSaida = parseFloat(leituraSaida) || null;
        } else {
            horimetroEntrada = parseFloat(leituraEntrada) || null;
            horimetroSaida = parseFloat(leituraSaida) || null;
        }

        const query = `
            UPDATE obras_historico_veiculos 
            SET dataEntrada=?, dataSaida=?, employeeId=?, employeeName=?, odometroEntrada=?, odometroSaida=?, horimetroEntrada=?, horimetroSaida=?
            WHERE id=?
        `;
        
        await db.execute(query, [dataEntrada || null, dataSaida || null, employeeId || null, employeeName, odometroEntrada, odometroSaida, horimetroEntrada, horimetroSaida, historyId]);
        res.json({ message: 'Histórico atualizado com sucesso.' });

    } catch (error) {
        console.error('Erro ao atualizar histórico:', error);
        res.status(500).json({ error: 'Erro ao atualizar histórico.' });
    }
};

module.exports = {
    getAllObras,
    getObraById,
    createObra,
    updateObra,
    deleteObra,
    finishObra,
    updateObraHistoryEntry
};