// controllers/obraController.js
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
const parseObraJsonFields = (obra) => {
    if (!obra) return null;
    const newObra = { ...obra };
    
    // Aplicação da função segura:
    newObra.historicoVeiculos = parseJsonSafe(newObra.historicoVeiculos, 'historicoVeiculos');
    newObra.horasContratadasPorTipo = parseJsonSafe(newObra.horasContratadasPorTipo, 'horasContratadasPorTipo');
    newObra.sectors = parseJsonSafe(newObra.sectors, 'sectors');
    newObra.alocadoEm = parseJsonSafe(newObra.alocadoEm, 'alocadoEm');
    newObra.ultimasAlteracoes = parseJsonSafe(newObra.ultimasAlteracoes, 'ultimasAlteracoes');
    
    return newObra;
};

// --- READ: Obter todas as obras ---
const getAllObras = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM obras');
        res.json(rows.map(parseObraJsonFields));
    } catch (error) {
        console.error('Erro ao buscar obras:', error);
        res.status(500).json({ error: 'Erro ao buscar obras' });
    }
};

// --- READ: Obter uma única obra por ID ---
const getObraById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM obras WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Obra não encontrada' });
        }
        res.json(parseObraJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar obra:', error);
        res.status(500).json({ error: 'Erro ao buscar obra' });
    }
};

// --- CREATE: Criar uma nova obra ---
const createObra = async (req, res) => {
    const data = req.body;
    
    if (data.historicoVeiculos) data.historicoVeiculos = JSON.stringify(data.historicoVeiculos);
    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimasAlteracoes) data.ultimasAlteracoes = JSON.stringify(data.ultimasAlteracoes);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO obras (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar obra:', error);
        res.status(500).json({ error: 'Erro ao criar obra' });
    }
};

// --- UPDATE: Atualizar uma obra existente ---
const updateObra = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    if (data.historicoVeiculos) data.historicoVeiculos = JSON.stringify(data.historicoVeiculos);
    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimasAlteracoes) data.ultimasAlteracoes = JSON.stringify(data.ultimasAlteracoes);

    const fields = Object.keys(data).filter(key => key !== 'id');
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

module.exports = {
    getAllObras,
    getObraById,
    createObra,
    updateObra,
    deleteObra,
    parseObraJsonFields // Exportar para uso potencial em outros controllers
};
