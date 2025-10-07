// controllers/revisionController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON com Tratamento de Erro (parseJsonSafe) ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    
    // Se já for um objeto/array (por exemplo, se o driver do MySQL já parseou a coluna JSON)
    if (typeof field === 'object') return field; 
    
    // Garante que é uma string antes de tentar o parse
    if (typeof field !== 'string') return field;

    try {
        // Tenta fazer o parse da string
        const parsed = JSON.parse(field);
        
        // Verifica se o resultado do parse é um objeto/array válido
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        // Retorna null em caso de erro, impedindo a quebra da aplicação.
        return null; 
    }
};

// --- Função Auxiliar para Conversão de JSON ---
const parseRevisionJsonFields = (revision) => {
    if (!revision) return null;
    const newRevision = { ...revision };
    
    // Aplicação da função segura:
    newRevision.historico = parseJsonSafe(newRevision.historico, 'historico');
    newRevision.ultimaAlteracao = parseJsonSafe(newRevision.ultimaAlteracao, 'ultimaAlteracao');

    return newRevision;
};

// --- READ: Obter todas as revisões ---
const getAllRevisions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM revisions');
        res.json(rows.map(parseRevisionJsonFields));
    } catch (error) {
        console.error('Erro ao buscar revisões:', error);
        res.status(500).json({ error: 'Erro ao buscar revisões' });
    }
};

// --- READ: Obter uma única revisão por ID ---
const getRevisionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM revisions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Revisão não encontrada' });
        }
        res.json(parseRevisionJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar revisão:', error);
        res.status(500).json({ error: 'Erro ao buscar revisão' });
    }
};

// --- CREATE: Criar uma nova revisão ---
const createRevision = async (req, res) => {
    const data = req.body;
    if (data.historico) data.historico = JSON.stringify(data.historico);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO revisions (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar revisão:', error);
        res.status(500).json({ error: 'Erro ao criar revisão' });
    }
};

// --- UPDATE: Atualizar uma revisão existente ---
const updateRevision = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    if (data.historico) data.historico = JSON.stringify(data.historico);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE revisions SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Revisão atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar revisão:', error);
        res.status(500).json({ error: 'Erro ao atualizar revisão' });
    }
};

// --- ROTA: Concluir uma revisão ---
const completeRevision = async (req, res) => {
    const { id } = req.params;
    const { historyEntry } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Usamos parseRevisionJsonFields, que agora é seguro
        const [revisionRows] = await connection.execute('SELECT historico FROM revisions WHERE id = ? FOR UPDATE', [id]);
        const revision = parseRevisionJsonFields(revisionRows[0]);

        const updatedHistorico = revision.historico || [];
        updatedHistorico.push(historyEntry);

        const revisionUpdateData = {
            proximaRevisaoData: null,
            proximaRevisaoOdometro: 0,
            avisoAntecedenciaDias: 0,
            avisoAntecedenciaKmHr: 0,
            descricao: '',
            historico: JSON.stringify(updatedHistorico)
        };

        await connection.execute('UPDATE revisions SET ? WHERE id = ?', [revisionUpdateData, id]);
        
        await connection.commit();
        res.status(200).json({ message: 'Revisão concluída com sucesso!' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao concluir revisão:", error);
        res.status(500).json({ error: 'Falha ao concluir a revisão.' });
    } finally {
        connection.release();
    }
};

// --- DELETE: Deletar uma revisão ---
const deleteRevision = async (req, res) => {
    try {
        await db.execute('DELETE FROM revisions WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar revisão:', error);
        res.status(500).json({ error: 'Erro ao deletar revisão' });
    }
};

module.exports = {
    getAllRevisions,
    getRevisionById,
    createRevision,
    updateRevision,
    completeRevision,
    deleteRevision,
};
