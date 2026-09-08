// ============================================================================
// controllers/partCatalogController.js
// Guia de Peças e Reposição — catálogo de referência por modelo de equipamento
// (filtros, óleos, correias etc.) + resolução por veículo.
// Padrão: routes → controller → db.query. Emite server:sync target 'partCatalog'
// nas mutações.
// ============================================================================

const db = require('../database');
const crypto = require('crypto');
const {
    normalizeText,
    normalizeMarca,
    resolveVehicleAno,
    anoMatch,
} = require('../utils/partCatalog');

const SYNC = (req) => { if (req.io) req.io.emit('server:sync', { targets: ['partCatalog'] }); };

// codigos_equivalentes chega do MySQL como string/objeto conforme driver.
const parseEquivalentes = (raw) => {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return raw;
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
};

const hydrateItem = (row) => ({
    ...row,
    codigos_equivalentes: parseEquivalentes(row.codigos_equivalentes),
});

// Sanitiza codigos_equivalentes vindo do body → [{marca, codigo}].
const cleanEquivalentes = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((e) => ({
            marca: (e && e.marca != null) ? String(e.marca).trim() : '',
            codigo: (e && e.codigo != null) ? String(e.codigo).trim() : '',
        }))
        .filter((e) => e.marca || e.codigo);
};

const STATUS_VALIDOS = ['referencia', 'confirmado', 'revisar'];

// ============================================================================
// MODELOS
// ============================================================================

const getModels = async (req, res) => {
    const { marca, modelo, ano, q } = req.query;
    try {
        let sql = `SELECT * FROM part_catalog_models WHERE 1=1`;
        const params = [];

        if (marca) {
            sql += ` AND marca_norm LIKE ?`;
            params.push(`%${normalizeMarca(marca)}%`);
        }
        if (modelo) {
            sql += ` AND modelo_norm LIKE ?`;
            params.push(`%${normalizeText(modelo)}%`);
        }
        if (q) {
            const qn = normalizeText(q);
            sql += ` AND (marca_norm LIKE ? OR modelo_norm LIKE ?)`;
            params.push(`%${qn}%`, `%${qn}%`);
        }
        if (ano) {
            const a = parseInt(ano, 10);
            if (Number.isFinite(a)) {
                sql += ` AND (ano_inicio IS NULL OR ano_inicio <= ?) AND (ano_fim IS NULL OR ano_fim >= ?)`;
                params.push(a, a);
            }
        }

        sql += ` ORDER BY marca ASC, modelo ASC`;
        const [rows] = await db.query(sql, params);

        // Anexa contagem de itens por modelo (leve, para a lista).
        const ids = rows.map(r => r.id);
        let counts = {};
        if (ids.length) {
            const [cRows] = await db.query(
                `SELECT model_id, COUNT(*) AS total FROM part_catalog_items
                 WHERE model_id IN (${ids.map(() => '?').join(',')}) GROUP BY model_id`,
                ids
            );
            counts = Object.fromEntries(cRows.map(c => [c.model_id, Number(c.total)]));
        }
        res.json(rows.map(r => ({ ...r, itemCount: counts[r.id] || 0 })));
    } catch (error) {
        console.error('❌ [partCatalog] getModels:', error);
        res.status(500).json({ error: 'Erro ao buscar modelos do catálogo' });
    }
};

const getModelById = async (req, res) => {
    const { id } = req.params;
    try {
        const [[model]] = await db.query(`SELECT * FROM part_catalog_models WHERE id = ?`, [id]);
        if (!model) return res.status(404).json({ error: 'Modelo não encontrado' });

        const [items] = await db.query(
            `SELECT * FROM part_catalog_items WHERE model_id = ? ORDER BY categoria ASC, descricao ASC`,
            [id]
        );
        res.json({ ...model, items: items.map(hydrateItem) });
    } catch (error) {
        console.error('❌ [partCatalog] getModelById:', error);
        res.status(500).json({ error: 'Erro ao buscar o modelo' });
    }
};

const createModel = async (req, res) => {
    const { marca, modelo, variante, categoria_veiculo, ano_inicio, ano_fim, observacoes, anexo_url, fonte } = req.body;
    if (!marca || !modelo) {
        return res.status(400).json({ error: 'Marca e modelo são obrigatórios.' });
    }
    try {
        const id = crypto.randomUUID();
        await db.query(
            `INSERT INTO part_catalog_models
                (id, marca, marca_norm, modelo, modelo_norm, variante, categoria_veiculo,
                 ano_inicio, ano_fim, observacoes, anexo_url, fonte)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, marca, normalizeMarca(marca), modelo, normalizeText(modelo),
                variante || null, categoria_veiculo || null,
                ano_inicio || null, ano_fim || null,
                observacoes || null, anexo_url || null, fonte || null,
            ]
        );
        SYNC(req);
        res.status(201).json({ id });
    } catch (error) {
        console.error('❌ [partCatalog] createModel:', error);
        res.status(500).json({ error: 'Erro ao criar o modelo' });
    }
};

const updateModel = async (req, res) => {
    const { id } = req.params;
    const { marca, modelo, variante, categoria_veiculo, ano_inicio, ano_fim, observacoes, anexo_url, fonte } = req.body;
    if (!marca || !modelo) {
        return res.status(400).json({ error: 'Marca e modelo são obrigatórios.' });
    }
    try {
        const [result] = await db.query(
            `UPDATE part_catalog_models
             SET marca=?, marca_norm=?, modelo=?, modelo_norm=?, variante=?, categoria_veiculo=?,
                 ano_inicio=?, ano_fim=?, observacoes=?, anexo_url=?, fonte=?
             WHERE id=?`,
            [
                marca, normalizeMarca(marca), modelo, normalizeText(modelo),
                variante || null, categoria_veiculo || null,
                ano_inicio || null, ano_fim || null,
                observacoes || null, anexo_url || null, fonte || null, id,
            ]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Modelo não encontrado' });
        SYNC(req);
        res.json({ message: 'Modelo atualizado' });
    } catch (error) {
        console.error('❌ [partCatalog] updateModel:', error);
        res.status(500).json({ error: 'Erro ao atualizar o modelo' });
    }
};

const deleteModel = async (req, res) => {
    const { id } = req.params;
    try {
        // Cascade manual: a FK não é declarada no DDL (para não travar em dados
        // legados), então removemos os itens do modelo antes do próprio modelo.
        await db.query(`DELETE FROM part_catalog_items WHERE model_id = ?`, [id]);
        const [result] = await db.query(`DELETE FROM part_catalog_models WHERE id = ?`, [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Modelo não encontrado' });
        SYNC(req);
        res.json({ message: 'Modelo e itens removidos' });
    } catch (error) {
        console.error('❌ [partCatalog] deleteModel:', error);
        res.status(500).json({ error: 'Erro ao remover o modelo' });
    }
};

// ============================================================================
// ITENS
// ============================================================================

const createItem = async (req, res) => {
    const {
        model_id, vehicle_id, categoria, descricao, especificacao, capacidade, quantidade,
        codigo_oem, codigos_equivalentes, intervalo_km, intervalo_horas, intervalo_meses,
        status_validacao, fonte, observacoes,
    } = req.body;

    if (!categoria || !descricao) {
        return res.status(400).json({ error: 'Categoria e descrição são obrigatórias.' });
    }
    if (!model_id && !vehicle_id) {
        return res.status(400).json({ error: 'Informe model_id (modelo) ou vehicle_id (override).' });
    }
    const status = STATUS_VALIDOS.includes(status_validacao) ? status_validacao : 'referencia';
    try {
        const id = crypto.randomUUID();
        await db.query(
            `INSERT INTO part_catalog_items
                (id, model_id, vehicle_id, categoria, descricao, especificacao, capacidade, quantidade,
                 codigo_oem, codigos_equivalentes, intervalo_km, intervalo_horas, intervalo_meses,
                 status_validacao, fonte, observacoes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, model_id || null, vehicle_id || null, categoria, descricao,
                especificacao || null, capacidade || null, quantidade || null,
                codigo_oem || null, JSON.stringify(cleanEquivalentes(codigos_equivalentes)),
                intervalo_km || null, intervalo_horas || null, intervalo_meses || null,
                status, fonte || null, observacoes || null,
            ]
        );
        SYNC(req);
        res.status(201).json({ id });
    } catch (error) {
        console.error('❌ [partCatalog] createItem:', error);
        res.status(500).json({ error: 'Erro ao criar o item' });
    }
};

const updateItem = async (req, res) => {
    const { id } = req.params;
    const {
        categoria, descricao, especificacao, capacidade, quantidade,
        codigo_oem, codigos_equivalentes, intervalo_km, intervalo_horas, intervalo_meses,
        status_validacao, fonte, observacoes,
    } = req.body;

    if (!categoria || !descricao) {
        return res.status(400).json({ error: 'Categoria e descrição são obrigatórias.' });
    }
    const status = STATUS_VALIDOS.includes(status_validacao) ? status_validacao : 'referencia';
    try {
        const [result] = await db.query(
            `UPDATE part_catalog_items
             SET categoria=?, descricao=?, especificacao=?, capacidade=?, quantidade=?,
                 codigo_oem=?, codigos_equivalentes=?, intervalo_km=?, intervalo_horas=?, intervalo_meses=?,
                 status_validacao=?, fonte=?, observacoes=?
             WHERE id=?`,
            [
                categoria, descricao, especificacao || null, capacidade || null, quantidade || null,
                codigo_oem || null, JSON.stringify(cleanEquivalentes(codigos_equivalentes)),
                intervalo_km || null, intervalo_horas || null, intervalo_meses || null,
                status, fonte || null, observacoes || null, id,
            ]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Item não encontrado' });
        SYNC(req);
        res.json({ message: 'Item atualizado' });
    } catch (error) {
        console.error('❌ [partCatalog] updateItem:', error);
        res.status(500).json({ error: 'Erro ao atualizar o item' });
    }
};

const deleteItem = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.query(`DELETE FROM part_catalog_items WHERE id = ?`, [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Item não encontrado' });
        SYNC(req);
        res.json({ message: 'Item removido' });
    } catch (error) {
        console.error('❌ [partCatalog] deleteItem:', error);
        res.status(500).json({ error: 'Erro ao remover o item' });
    }
};

// ============================================================================
// RESOLUÇÃO POR VEÍCULO
// ============================================================================

const getForVehicle = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const [[vehicle]] = await db.query(
            `SELECT id, placa, registroInterno, marca, modelo, tipo, sub_tipo,
                    anoFabricacao, ano_fabricacao, ano_modelo
             FROM vehicles WHERE id = ?`,
            [vehicleId]
        );
        if (!vehicle) return res.status(404).json({ error: 'Veículo não encontrado' });

        const marcaNorm = normalizeMarca(vehicle.marca);
        const modeloNorm = normalizeText(vehicle.modelo);
        const ano = resolveVehicleAno(vehicle);

        // Candidatos por marca; refina modelo e ano em JS (o modelo do veículo
        // costuma ser mais específico que o do catálogo — ex.: "Constellation
        // 24.280" casa com o modelo "Constellation").
        let modelMatches = [];
        if (marcaNorm) {
            const [candidates] = await db.query(
                `SELECT * FROM part_catalog_models WHERE marca_norm = ? ORDER BY modelo ASC`,
                [marcaNorm]
            );
            const filtered = candidates.filter((m) => {
                const cat = m.modelo_norm || '';
                const modeloOk = !modeloNorm || !cat
                    ? true
                    : (modeloNorm.includes(cat) || cat.includes(modeloNorm));
                return modeloOk && anoMatch(ano, m.ano_inicio, m.ano_fim);
            });

            for (const m of filtered) {
                const [items] = await db.query(
                    `SELECT * FROM part_catalog_items WHERE model_id = ? ORDER BY categoria ASC, descricao ASC`,
                    [m.id]
                );
                modelMatches.push({ model: m, items: items.map(hydrateItem) });
            }
        }

        // Overrides específicos por chassi/veículo.
        const [overrideRows] = await db.query(
            `SELECT * FROM part_catalog_items WHERE vehicle_id = ? ORDER BY categoria ASC, descricao ASC`,
            [vehicleId]
        );

        res.json({
            vehicle: {
                id: vehicle.id,
                placa: vehicle.placa,
                registroInterno: vehicle.registroInterno,
                marca: vehicle.marca,
                modelo: vehicle.modelo,
                ano,
            },
            resolved: { marcaNorm, modeloNorm, ano },
            modelMatches,
            overrides: overrideRows.map(hydrateItem),
        });
    } catch (error) {
        console.error('❌ [partCatalog] getForVehicle:', error);
        res.status(500).json({ error: 'Erro ao resolver peças do veículo' });
    }
};

module.exports = {
    getModels,
    getModelById,
    createModel,
    updateModel,
    deleteModel,
    createItem,
    updateItem,
    deleteItem,
    getForVehicle,
};
