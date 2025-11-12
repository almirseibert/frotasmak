const db = require('../database');
// const { parseJsonSafe } = require('../utils/parseJsonSafe'); // Removido Import

// ===================================================================================
// FUNÇÃO AUXILIAR DE PARSE SEGURO (Adicionada localmente)
// ===================================================================================
// Esta função tenta fazer o parse de um campo. Se falhar (ex: é um email
// ou texto simples), ela registra um aviso e retorna o valor padrão (ex: null).
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; // Já é um objeto
    if (typeof field !== 'string' || (!field.startsWith('{') && !field.startsWith('['))) {
        // Se não for string ou não parecer JSON, retorna o próprio campo (como texto)
        // Mudança: Retorna o texto original se não for JSON, para campos de "details"
        // que são apenas texto (como "Entrada em manutenção...")
        if (key === 'history.details') {
             return field;
        }
        return defaultValue; 
    }

    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
    } catch (e) {
        // Se falhar o parse, registra o aviso e retorna o valor original (texto)
        // Isso é importante para os logs de "Entrada em manutenção..."
        console.warn(`[JSON Parse Warning] Campo '${key}' não é JSON. Valor problemático:`, field);
        if (key === 'history.details') {
            return field; // Retorna o texto original
        }
        return defaultValue;
    }
};
// ===================================================================================


// --- Função Auxiliar para Conversão de JSON nos campos da Obra ---
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

// --- GET: Todas as obras ---
const getAllObras = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM obras');
        
        // *** CORREÇÃO: Busca todo o histórico de obras de uma vez ***
        const [historyRows] = await db.query('SELECT * FROM obras_historico_veiculos');

        // *** CORREÇÃO: Faz o parse seguro dos 'details' do histórico ANTES de mapear ***
        const parsedHistory = historyRows.map(h => {
            return {
                ...h,
                details: parseJsonSafe(h.details, 'history.details')
            };
        });

        const obras = rows.map(obra => {
            const parsedObra = parseObraJsonFields(obra);
            
            // *** CORREÇÃO: Anexa o histórico JÁ COM PARSE FEITO ***
            parsedObra.historicoVeiculos = parsedHistory
                .filter(h => h.obraId === parsedObra.id)
                .sort((a, b) => new Date(b.dataEntrada) - new Date(a.dataEntrada)); // Ordena
                
            return parsedObra;
        });
        
        res.json(obras);
    } catch (error) {
        console.error('Erro ao buscar obras:', error);
        res.status(500).json({ error: 'Erro ao buscar obras' });
    }
};

// --- GET: Uma obra por ID ---
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
        
        const obra = parseObraJsonFields(rows[0]);
        
        // *** CORREÇÃO: Aplica o parse seguro no histórico ANTES de anexar ***
        obra.historicoVeiculos = historyRows.map(h => ({
             ...h,
             details: parseJsonSafe(h.details, 'history.details')
        }));
        
        res.json(obra);
    } catch (error) {
        console.error('Erro ao buscar obra por ID:', error);
        res.status(500).json({ error: 'Erro ao buscar obra' });
    }
};

// --- POST: Criar uma nova obra ---
const createObra = async (req, res) => {
    const data = { ...req.body };
    delete data.historicoVeiculos; 

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

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

// --- PUT: Atualizar uma obra existente ---
const updateObra = async (req, res) => {
    const { id } = req.params;
    const data = { ...req.body };
    delete data.historicoVeiculos;

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE obras SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Obra atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar obra:', error);
        res.status(500).json({ error: 'Erro ao atualizar obra' });
    }
};

// --- DELETE: Deletar uma obra ---
const deleteObra = async (req, res) => {
    try {
        await db.execute('DELETE FROM obras WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar obra:', error);
        res.status(500).json({ error: 'Erro ao deletar obra' });
    }
};

// --- FUNÇÃO PARA FINALIZAR UMA OBRA (A QUE ESTAVA FALTANDO) ---
const finishObra = async (req, res) => {
    const { id } = req.params;
    const currentDate = new Date(); 

    try {
        const [result] = await db.execute(
            "UPDATE obras SET status = 'finalizada', dataFim = ? WHERE id = ?", // Corrigido para 'finalizada'
            [currentDate, id]
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

// --- NOVO: Atualizar uma entrada de histórico específica (para ObrasPage.js) ---
const updateObraHistoryEntry = async (req, res) => {
    const { historyId } = req.params; // PK da tabela obras_historico_veiculos
    const { dataEntrada, dataSaida, employeeId, leituraEntrada, leituraSaida } = req.body;

    // Busca o nome do funcionário
    let employeeName = null;
    if (employeeId) {
        try {
            const [empRows] = await db.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
            if (empRows.length > 0) {
                employeeName = empRows[0].nome;
            }
        } catch (e) {
            console.warn("Não foi possível buscar nome do funcionário durante a atualização do histórico.");
        }
    }

    // Determina os campos de leitura (o frontend envia 'leituraEntrada',
    // mas não sabemos se é odometro ou horimetro. Precisamos checar o registro original)
    let odometroEntrada = null;
    let horimetroEntrada = null;
    let odometroSaida = null;
    let horimetroSaida = null;

    try {
        const [currentHistory] = await db.execute('SELECT * FROM obras_historico_veiculos WHERE id = ?', [historyId]);
        if (currentHistory.length === 0) {
            return res.status(404).json({ error: 'Registro de histórico não encontrado.' });
        }

        const history = currentHistory[0];
        
        // Mantém o tipo de leitura original
        if (history.odometroEntrada !== null) {
            odometroEntrada = parseFloat(leituraEntrada) || null;
            odometroSaida = parseFloat(leituraSaida) || null;
        } else {
            horimetroEntrada = parseFloat(leituraEntrada) || null;
            horimetroSaida = parseFloat(leituraSaida) || null;
        }

        const query = `
            UPDATE obras_historico_veiculos 
            SET 
                dataEntrada = ?, 
                dataSaida = ?, 
                employeeId = ?, 
                employeeName = ?,
                odometroEntrada = ?,
                odometroSaida = ?,
                horimetroEntrada = ?,
                horimetroSaida = ?
            WHERE id = ?
        `;
        
        const values = [
            dataEntrada || null,
            dataSaida || null,
            employeeId || null,
            employeeName,
            odometroEntrada,
            odometroSaida,
            horimetroEntrada,
            horimetroSaida,
            historyId
        ];

        await db.execute(query, values);
        res.json({ message: 'Histórico da obra atualizado com sucesso.' });

    } catch (error) {
        console.error('Erro ao atualizar histórico da obra:', error);
        res.status(500).json({ error: 'Erro ao atualizar histórico da obra.' });
    }
};


// --- EXPORTAÇÃO DE TODAS AS FUNÇÕES ---
module.exports = {
    getAllObras,
    getObraById,
    createObra,
    updateObra,
    deleteObra,
    finishObra,
    updateObraHistoryEntry // Adiciona a nova função
};