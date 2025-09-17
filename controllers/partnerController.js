// controllers/partnerController.js
const db = require('../database');

// --- Função Auxiliar para Conversão de JSON ---
const parsePartnerJsonFields = (partner) => {
    if (!partner) return null;
    const newPartner = { ...partner };
    if (newPartner.fuel_prices) newPartner.fuel_prices = JSON.parse(newPartner.fuel_prices);
    if (newPartner.ultima_alteracao) newPartner.ultima_alteracao = JSON.parse(newPartner.ultima_alteracao);
    return newPartner;
};

// --- READ: Obter todos os parceiros ---
const getAllPartners = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM partners');
        res.json(rows.map(parsePartnerJsonFields));
    } catch (error) {
        console.error('Erro ao buscar parceiros:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiros' });
    }
};

// --- READ: Obter um único parceiro por ID ---
const getPartnerById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM partners WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Parceiro não encontrado' });
        }
        res.json(parsePartnerJsonFields(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar parceiro:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiro' });
    }
};

// --- CREATE: Criar um novo parceiro ---
const createPartner = async (req, res) => {
    const data = req.body;
    
    if (data.fuel_prices) data.fuel_prices = JSON.stringify(data.fuel_prices);
    if (data.ultima_alteracao) data.ultima_alteracao = JSON.stringify(data.ultima_alteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO partners (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar parceiro:', error);
        res.status(500).json({ error: 'Erro ao criar parceiro' });
    }
};

// --- UPDATE: Atualizar um parceiro existente ---
const updatePartner = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    if (data.fuel_prices) data.fuel_prices = JSON.stringify(data.fuel_prices);
    if (data.ultima_alteracao) data.ultima_alteracao = JSON.stringify(data.ultima_alteracao);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE partners SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Parceiro atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar parceiro:', error);
        res.status(500).json({ error: 'Erro ao atualizar parceiro' });
    }
};

// --- DELETE: Deletar um parceiro ---
const deletePartner = async (req, res) => {
    try {
        await db.execute('DELETE FROM partners WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar parceiro:', error);
        res.status(500).json({ error: 'Erro ao deletar parceiro' });
    }
};

module.exports = {
    getAllPartners,
    getPartnerById,
    createPartner,
    updatePartner,
    deletePartner,
};