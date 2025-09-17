// controllers/obraController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON ---
const parseObraJsonFields = (obra) => {
    if (!obra) return null;
    const newObra = { ...obra };
    if (newObra.historicoVeiculos) newObra.historicoVeiculos = JSON.parse(newObra.historicoVeiculos);
    if (newObra.horasContratadasPorTipo) newObra.horasContratadasPorTipo = JSON.parse(newObra.horasContratadasPorTipo);
    if (newObra.sectors) newObra.sectors = JSON.parse(newObra.sectors);
    if (newObra.alocadoEm) newObra.alocadoEm = JSON.parse(newObra.alocadoEm);
    if (newObra.ultimasAlteracoes) newObra.ultimasAlteracoes = JSON.parse(newObra.ultimasAlteracoes);
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
};