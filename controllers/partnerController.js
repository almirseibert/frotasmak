// controllers/partnerController.js
const db = require('../database');
const { parseJsonSafe } = require('../utils/parseJsonSafe'); // Supondo que você criou um util

// --- Função Auxiliar para Conversão de JSON ---
// Esta função não é mais necessária para fuel_prices
const parsePartnerJsonFields = (partner) => {
    if (!partner) return null;
    const newPartner = { ...partner };
    // Removemos fuel_prices daqui
    if (newPartner.ultima_alteracao) newPartner.ultima_alteracao = parseJsonSafe(newPartner.ultima_alteracao, 'ultima_alteracao');
    return newPartner;
};

// --- READ: Obter todos os parceiros (CORRIGIDO) ---
const getAllPartners = async (req, res) => {
    try {
        // 1. Busca todos os parceiros
        const [partnerRows] = await db.execute('SELECT * FROM partners');
        
        // 2. Busca todos os preços de combustível
        const [priceRows] = await db.execute('SELECT * FROM partner_fuel_prices');
        
        // 3. Mapeia os preços para cada parceiro
        const partnersWithPrices = partnerRows.map(partner => {
            const parsedPartner = parsePartnerJsonFields(partner);
            
            // Filtra os preços para este parceiro
            const partnerPrices = priceRows.filter(p => p.partnerId === partner.id);
            
            // Transforma o array de preços em um objeto (como o frontend espera)
            // Ex: { "Diesel S10": 5.99, "Arla": 2.50 }
            parsedPartner.fuel_prices = partnerPrices.reduce((acc, priceEntry) => {
                acc[priceEntry.fuelType] = priceEntry.price;
                return acc;
            }, {});
            
            return parsedPartner;
        });
        
        res.json(partnersWithPrices);
    } catch (error) {
        console.error('Erro ao buscar parceiros:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiros' });
    }
};

// --- READ: Obter um único parceiro por ID (CORRIGIDO) ---
const getPartnerById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM partners WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Parceiro não encontrado' });
        }
        
        const partner = parsePartnerJsonFields(rows[0]);
        
        // Busca os preços deste parceiro
        const [priceRows] = await db.execute('SELECT * FROM partner_fuel_prices WHERE partnerId = ?', [req.params.id]);
        
        // Transforma e anexa os preços
        partner.fuel_prices = priceRows.reduce((acc, priceEntry) => {
            acc[priceEntry.fuelType] = priceEntry.price;
            return acc;
        }, {});
        
        res.json(partner);
    } catch (error) {
        console.error('Erro ao buscar parceiro:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiro' });
    }
};

// --- CREATE: Criar um novo parceiro (CORRIGIDO) ---
const createPartner = async (req, res) => {
    const data = req.body;
    
    // Remove fuel_prices dos dados principais (será tratado separadamente)
    const fuelPrices = data.fuel_prices;
    delete data.fuel_prices;

    if (data.ultima_alteracao) data.ultima_alteracao = JSON.stringify(data.ultima_alteracao);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO partners (${fields.join(', ')}) VALUES (${placeholders})`;

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [result] = await connection.execute(query, values);
        const newPartnerId = data.id || result.insertId; // Usa ID se fornecido (ex: UUID) ou o insertId

        // Agora, insere os preços de combustível na tabela 'partner_fuel_prices'
        if (fuelPrices && typeof fuelPrices === 'object') {
            const pricePromises = Object.entries(fuelPrices).map(([fuelType, price]) => {
                return connection.execute(
                    'INSERT INTO partner_fuel_prices (partnerId, fuelType, price) VALUES (?, ?, ?)',
                    [newPartnerId, fuelType, price || 0]
                );
            });
            await Promise.all(pricePromises);
        }

        await connection.commit();
        res.status(201).json({ id: newPartnerId, ...req.body });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao criar parceiro:', error);
        res.status(500).json({ error: 'Erro ao criar parceiro' });
    } finally {
        connection.release();
    }
};

// --- UPDATE: Atualizar um parceiro existente ---
// (Esta função só atualiza a tabela 'partners'. Preços são atualizados via 'updateFuelPrices')
const updatePartner = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    // Remove fuel_prices para garantir que não tente atualizar a coluna errada
    delete data.fuel_prices; 
    
    if (data.ultima_alteracao) data.ultima_alteracao = JSON.stringify(data.ultima_alteracao);

    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = fields.map(field => data[field]); // Pega os valores na ordem correta
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    if (fields.length === 0) {
        return res.status(400).json({ message: 'Nenhum dado para atualizar.' });
    }
    
    const query = `UPDATE partners SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Parceiro atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar parceiro:', error);
        res.status(500).json({ error: 'Erro ao atualizar parceiro' });
    }
};

// --- UPDATE: Atualizar apenas os preços dos combustíveis (CORRIGIDO) ---
const updateFuelPrices = async (req, res) => {
    const { id } = req.params; // partnerId
    const prices = req.body; // Ex: { "Diesel S10": 5.99, "Arla": 2.50 }
    
    if (!prices || typeof prices !== 'object' || Object.keys(prices).length === 0) {
        return res.status(400).json({ error: 'Dados de preços inválidos.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const priceUpdates = Object.entries(prices).map(([fuelType, price]) => {
            const query = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price) 
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            // Garante que o preço é um número, ou 0 se inválido
            const numericPrice = parseFloat(price);
            return connection.execute(query, [id, fuelType, isNaN(numericPrice) ? 0 : numericPrice]);
        });
        
        await Promise.all(priceUpdates);
        
        await connection.commit();
        res.json({ message: 'Preços de combustível atualizados com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar preços:', error);
        // Este é o "Erro 500 nos Postos" que você mencionou.
        res.status(500).json({ error: 'Erro ao atualizar os preços.' });
    } finally {
        connection.release();
    }
};

// --- DELETE: Deletar um parceiro ---
// (Não precisa de mudança, o DB deve usar ON DELETE CASCADE)
const deletePartner = async (req, res) => {
    try {
        // O 'ON DELETE CASCADE' na tabela 'partner_fuel_prices' (definido no SQL)
        // deve remover os preços automaticamente.
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
    updateFuelPrices,
    deletePartner,
};