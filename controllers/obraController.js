const db = require('../database');

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
        console.warn(`[JSON Parse Error] Falha ao analisar o campo '${key}'. Valor problemático:`, field);
        return null;
    }
};

// --- Função Auxiliar para Conversão de JSON nos campos da Obra ---
const parseObraJsonFields = (obra) => {
    if (!obra) return null;
    const newObra = { ...obra };
    const fieldsToParse = ['historicoVeiculos', 'horasContratadasPorTipo', 'sectors', 'alocadoEm', 'ultimasAlteracoes'];
    fieldsToParse.forEach(field => {
        newObra[field] = parseJsonSafe(obra[field], field);
    });
    return newObra;
};

// --- GET: Todas as obras ---
const getAllObras = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM obras');
        const obras = rows.map(parseObraJsonFields);
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
        const obra = parseObraJsonFields(rows[0]);
        res.json(obra);
    } catch (error) {
        console.error('Erro ao buscar obra por ID:', error);
        res.status(500).json({ error: 'Erro ao buscar obra' });
    }
};

// --- POST: Criar uma nova obra ---
const createObra = async (req, res) => {
    const data = { ...req.body };
    // Converte campos JSON para strings antes de inserir
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
    // Converte campos JSON para strings antes de atualizar
    if (data.historicoVeiculos) data.historicoVeiculos = JSON.stringify(data.historicoVeiculos);
    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimasAlteracoes) data.ultimasAlteracoes = JSON.stringify(data.ultimasAlteracoes);

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
    const currentDate = new Date().toISOString().slice(0, 10); // Formato YYYY-MM-DD

    try {
        const [result] = await db.execute(
            "UPDATE obras SET status = 'Finalizada', endDate = ? WHERE id = ?",
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

// --- EXPORTAÇÃO DE TODAS AS FUNÇÕES ---
module.exports = {
    getAllObras,
    getObraById,
    createObra,
    updateObra,
    deleteObra,
    finishObra // A função agora está definida e exportada
};
