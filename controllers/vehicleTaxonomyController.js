const db = require('../database');
const { randomUUID } = require('crypto');

const UNIDADES_VALIDAS = ['L/h', 'h/L', 'Km/L', 'L/Km'];

const emitSync = (req) => req.io && req.io.emit('server:sync', { targets: ['vehicleTaxonomy'] });

// ── Árvore completa ─────────────────────────────────────────────────────────
//
// O formato da árvore (grupos → tipos → subTipos) é mantido: é o que
// `hydrateVehicleTaxonomy` do frontend consome. Com o vínculo N:N o mesmo
// subgrupo simplesmente passa a aparecer em mais de um tipo — o JSON não muda
// de forma, só de conteúdo.
//
// `subgrupos` (array de topo) é novo e existe para a tela de administração da
// taxonomia, que precisa enxergar o subgrupo como entidade própria e não como
// filho de alguém.
const getTree = async (req, res) => {
    try {
        const [groups] = await db.query('SELECT * FROM vehicle_groups ORDER BY ordem ASC, nome ASC');
        const [types] = await db.query('SELECT * FROM vehicle_types ORDER BY nome ASC');
        const [subTypes] = await db.query('SELECT id, nome FROM vehicle_sub_types ORDER BY nome ASC');
        const [vinculos] = await db.query('SELECT type_id, sub_type_id FROM vehicle_type_sub_types');

        // Contagem de veículos por tipo e por subgrupo — a tela usa para não
        // deixar ninguém excluir às cegas.
        // `vehicles.tipo` é string e só existe um nome por grupo dentro de cada
        // categoria (UNIQUE (group_id, nome)) — o mesmo nome PODE existir em duas
        // categorias. Nesse caso a frota é genuinamente ambígua: a contagem é
        // atribuída ao primeiro grupo em ordem e os demais recebem 0, com
        // `contagemAmbigua` marcando a linha, em vez de inflar os dois.
        const [porTipo] = await db.query(
            `SELECT tipo AS nome, COUNT(*) AS n FROM vehicles WHERE tipo IS NOT NULL AND tipo <> '' GROUP BY tipo`);
        const veicTipo = Object.fromEntries(porTipo.map(r => [r.nome, Number(r.n)]));
        const nomesRepetidos = new Set();
        const vistos = new Set();
        types.forEach(t => {
            if (vistos.has(t.nome)) nomesRepetidos.add(t.nome);
            vistos.add(t.nome);
        });
        const jaAtribuido = new Set();

        const subById = Object.fromEntries(subTypes.map(s => [s.id, s]));
        const subsByType = {};   // type_id -> [{id, nome}]
        vinculos.forEach(v => {
            const s = subById[v.sub_type_id];
            if (!s) return;
            (subsByType[v.type_id] = subsByType[v.type_id] || []).push({ id: s.id, nome: s.nome });
        });
        Object.values(subsByType).forEach(arr => arr.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));

        const typesByGroup = {};
        types.forEach(t => {
            (typesByGroup[t.group_id] = typesByGroup[t.group_id] || []).push({
                id: t.id,
                nome: t.nome,
                group_id: t.group_id,
                veiculos: jaAtribuido.has(t.nome) ? 0 : (veicTipo[t.nome] || 0),
                contagemAmbigua: nomesRepetidos.has(t.nome),
                subTipos: subsByType[t.id] || [],
            });
            jaAtribuido.add(t.nome);
        });

        const tree = groups.map(g => ({
            id: g.id,
            nome: g.nome,
            unidade: g.unidade,
            ordem: g.ordem,
            tipos: typesByGroup[g.id] || [],
        }));

        // A resposta continua sendo o array puro que o frontend já espera.
        // A visão "subgrupo como entidade" está em GET /vehicle-taxonomy/sub-types.
        res.json(tree);
    } catch (err) {
        console.error('[vehicleTaxonomy] getTree:', err);
        res.status(500).json({ error: 'Erro ao buscar taxonomia de veículos.' });
    }
};

// ── Subgrupos como entidade própria (tela de administração) ──────────────────
const listSubTypes = async (req, res) => {
    try {
        const [subTypes] = await db.query('SELECT id, nome FROM vehicle_sub_types ORDER BY nome ASC');
        const [vinculos] = await db.query('SELECT type_id, sub_type_id FROM vehicle_type_sub_types');
        const [porSub] = await db.query(
            `SELECT sub_tipo AS nome, COUNT(*) AS n FROM vehicles WHERE sub_tipo IS NOT NULL AND sub_tipo <> '' GROUP BY sub_tipo`);
        const veicSub = Object.fromEntries(porSub.map(r => [r.nome, Number(r.n)]));

        const gruposPorSub = {};
        vinculos.forEach(v => (gruposPorSub[v.sub_type_id] = gruposPorSub[v.sub_type_id] || []).push(v.type_id));

        res.json(subTypes.map(s => ({
            id: s.id,
            nome: s.nome,
            grupos: gruposPorSub[s.id] || [],
            veiculos: veicSub[s.nome] || 0,
        })));
    } catch (err) {
        console.error('[vehicleTaxonomy] listSubTypes:', err);
        res.status(500).json({ error: 'Erro ao buscar subgrupos.' });
    }
};

// ── Regra da Categoria ───────────────────────────────────────────────────────
//
// A Categoria (vehicle_groups) define a unidade de consumo e, por consequência,
// o tipo de leitura: L/h → horímetro, Km/L → odômetro. Um subgrupo ligado a
// grupos de duas categorias ficaria ambíguo sobre qual aplicar.
//
// Validação de APLICAÇÃO, deliberadamente — não constraint de schema. O dia em
// que aparecer uma exceção legítima, afrouxar não pode exigir migração.
const validarCategoriaUnica = async (typeIds) => {
    if (!typeIds || typeIds.length === 0) {
        return { ok: false, erro: 'Marque pelo menos um grupo — é ele que diz onde este subgrupo se encaixa.' };
    }
    const placeholders = typeIds.map(() => '?').join(',');
    const [linhas] = await db.query(
        `SELECT t.id, t.nome AS tipo, g.id AS group_id, g.nome AS categoria
           FROM vehicle_types t JOIN vehicle_groups g ON g.id = t.group_id
          WHERE t.id IN (${placeholders})`, typeIds);

    if (linhas.length !== typeIds.length) {
        return { ok: false, erro: 'Um dos grupos informados não existe.' };
    }
    const categorias = [...new Set(linhas.map(l => l.categoria))];
    if (categorias.length > 1) {
        return {
            ok: false,
            erro: `Um subgrupo não pode pertencer a grupos de categorias diferentes (${categorias.join(' e ')}). `
                + 'A categoria define a unidade de consumo e o tipo de leitura do equipamento.',
        };
    }
    return { ok: true, group_id: linhas[0].group_id, categoria: categorias[0] };
};

// Quantos veículos usam este subgrupo (pelo nome — o vínculo do veículo é a string).
const subTypeInUse = async (nome) => {
    if (!nome) return 0;
    const [[row]] = await db.query('SELECT COUNT(*) AS n FROM vehicles WHERE sub_tipo = ?', [nome]);
    return Number(row.n) || 0;
};

// Em quantas obras este nome é chave do plano de trabalho.
const subTypeEmPlanos = async (nome) => {
    if (!nome) return 0;
    // JSON_EXTRACT com path montado por concatenação lança ER_INVALID_JSON_PATH em
    // nomes com barra invertida ou aspas — e um erro aqui derruba justamente a
    // guarda contra órfãos. JSON_CONTAINS sobre JSON_KEYS evita montar path: o
    // nome é comparado como VALOR (parametrizado), não como caminho.
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS n FROM obras
          WHERE JSON_CONTAINS(
                    JSON_KEYS(COALESCE(horasContratadasPorSubTipo, '{}')),
                    JSON_QUOTE(?))
             OR JSON_CONTAINS(
                    JSON_KEYS(COALESCE(horasContratadasPorTipo, '{}')),
                    JSON_QUOTE(?))`,
        [nome, nome]);
    return Number(row.n) || 0;
};

// ── Grupos ──────────────────────────────────────────────────────────────────
const createGroup = async (req, res) => {
    const { nome, unidade } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do grupo é obrigatório.' });
    const uni = UNIDADES_VALIDAS.includes(unidade) ? unidade : 'L/h';
    const id = randomUUID();
    try {
        const [[{ maxOrdem }]] = await db.query('SELECT COALESCE(MAX(ordem), -1) AS maxOrdem FROM vehicle_groups');
        await db.query('INSERT INTO vehicle_groups (id, nome, unidade, ordem) VALUES (?, ?, ?, ?)',
            [id, nome, uni, maxOrdem + 1]);
        emitSync(req);
        res.status(201).json({ id, nome, unidade: uni });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um grupo com esse nome.' });
        console.error('[vehicleTaxonomy] createGroup:', err);
        res.status(500).json({ error: 'Erro ao criar grupo.' });
    }
};

const updateGroup = async (req, res) => {
    const { id } = req.params;
    const { nome, unidade } = req.body;
    if (unidade && !UNIDADES_VALIDAS.includes(unidade)) {
        return res.status(400).json({ error: 'Unidade inválida.' });
    }
    try {
        const [[current]] = await db.query('SELECT * FROM vehicle_groups WHERE id = ?', [id]);
        if (!current) return res.status(404).json({ error: 'Grupo não encontrado.' });
        await db.query('UPDATE vehicle_groups SET nome = ?, unidade = ? WHERE id = ?',
            [nome != null ? nome : current.nome, unidade || current.unidade, id]);
        emitSync(req);
        res.json({ message: 'Grupo atualizado.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um grupo com esse nome.' });
        console.error('[vehicleTaxonomy] updateGroup:', err);
        res.status(500).json({ error: 'Erro ao atualizar grupo.' });
    }
};

const deleteGroup = async (req, res) => {
    const { id } = req.params;
    try {
        const [tipos] = await db.query('SELECT nome FROM vehicle_types WHERE group_id = ?', [id]);
        if (tipos.length > 0) {
            const inUse = await typesInUse(tipos.map(t => t.nome));
            if (inUse.length > 0) {
                return res.status(409).json({ error: `Não é possível excluir: há veículos usando os tipos: ${inUse.join(', ')}.` });
            }
        }
        await db.query('DELETE FROM vehicle_groups WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteGroup:', err);
        res.status(500).json({ error: 'Erro ao excluir grupo.' });
    }
};

// ── Tipos ───────────────────────────────────────────────────────────────────
const createType = async (req, res) => {
    const { group_id, nome } = req.body;
    if (!group_id || !nome) return res.status(400).json({ error: 'group_id e nome são obrigatórios.' });
    const id = randomUUID();
    try {
        await db.query('INSERT INTO vehicle_types (id, group_id, nome) VALUES (?, ?, ?)', [id, group_id, nome]);
        emitSync(req);
        res.status(201).json({ id, group_id, nome });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse tipo no grupo.' });
        console.error('[vehicleTaxonomy] createType:', err);
        res.status(500).json({ error: 'Erro ao criar tipo.' });
    }
};

const updateType = async (req, res) => {
    const { id } = req.params;
    const { nome, group_id } = req.body;
    try {
        const [[current]] = await db.query('SELECT * FROM vehicle_types WHERE id = ?', [id]);
        if (!current) return res.status(404).json({ error: 'Tipo não encontrado.' });

        // Mover um grupo de categoria violaria a regra do subgrupo retroativamente
        // e em silêncio: os subgrupos dele passariam a valer em duas categorias.
        if (group_id && group_id !== current.group_id) {
            const [compartilhados] = await db.query(`
                SELECT DISTINCT s.nome
                  FROM vehicle_type_sub_types v
                  JOIN vehicle_sub_types s ON s.id = v.sub_type_id
                 WHERE v.type_id = ?
                   AND EXISTS (SELECT 1 FROM vehicle_type_sub_types v2
                                WHERE v2.sub_type_id = v.sub_type_id AND v2.type_id <> v.type_id)
            `, [id]);
            if (compartilhados.length > 0) {
                const nomes = compartilhados.map(s => `"${s.nome}"`).join(', ');
                return res.status(409).json({
                    error: `Não é possível mover "${current.nome}" para outra categoria: `
                        + `${nomes} ${compartilhados.length > 1 ? 'são subgrupos compartilhados' : 'é um subgrupo compartilhado'} `
                        + 'com outros grupos. Desvincule antes de mover.',
                });
            }
        }

        await db.query('UPDATE vehicle_types SET nome = ?, group_id = ? WHERE id = ?',
            [nome != null ? nome : current.nome, group_id || current.group_id, id]);
        emitSync(req);
        res.json({ message: 'Tipo atualizado.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse tipo no grupo.' });
        console.error('[vehicleTaxonomy] updateType:', err);
        res.status(500).json({ error: 'Erro ao atualizar tipo.' });
    }
};

const deleteType = async (req, res) => {
    const { id } = req.params;
    // Aceita por query string também: DELETE nem sempre carrega corpo nos clientes.
    const confirmarPerdaDeVinculos =
        (req.body || {}).confirmarPerdaDeVinculos === true || req.query.confirmar === '1';
    try {
        const [[tipo]] = await db.query('SELECT nome FROM vehicle_types WHERE id = ?', [id]);
        if (tipo) {
            const inUse = await typesInUse([tipo.nome]);
            if (inUse.length > 0) {
                return res.status(409).json({ error: `Não é possível excluir: há veículos usando o tipo "${tipo.nome}".` });
            }

            // O ON DELETE CASCADE de vehicle_type_sub_types apaga os vínculos junto.
            // Para subgrupo compartilhado isso é perda silenciosa de configuração
            // que ninguém pediu — exige confirmação explícita antes de prosseguir.
            const [compartilhados] = await db.query(`
                SELECT DISTINCT s.nome
                  FROM vehicle_type_sub_types v
                  JOIN vehicle_sub_types s ON s.id = v.sub_type_id
                 WHERE v.type_id = ?
                   AND EXISTS (SELECT 1 FROM vehicle_type_sub_types v2
                                WHERE v2.sub_type_id = v.sub_type_id AND v2.type_id <> v.type_id)
            `, [id]);
            // Subgrupos que ficariam sem NENHUM grupo — órfãos invisíveis na tela.
            const [orfanariam] = await db.query(`
                SELECT s.nome
                  FROM vehicle_type_sub_types v
                  JOIN vehicle_sub_types s ON s.id = v.sub_type_id
                 WHERE v.type_id = ?
                   AND NOT EXISTS (SELECT 1 FROM vehicle_type_sub_types v2
                                    WHERE v2.sub_type_id = v.sub_type_id AND v2.type_id <> v.type_id)
            `, [id]);

            if (!confirmarPerdaDeVinculos && (compartilhados.length > 0 || orfanariam.length > 0)) {
                const partes = [];
                if (compartilhados.length) {
                    partes.push(`${compartilhados.length} subgrupo(s) perderiam o vínculo com este grupo `
                        + `(${compartilhados.map(x => `"${x.nome}"`).join(', ')})`);
                }
                if (orfanariam.length) {
                    partes.push(`${orfanariam.length} subgrupo(s) ficariam sem nenhum grupo `
                        + `(${orfanariam.map(x => `"${x.nome}"`).join(', ')})`);
                }
                return res.status(409).json({
                    error: `Excluir "${tipo.nome}" tem efeito colateral: ${partes.join('; ')}. `
                        + 'Confirme para prosseguir.',
                    exigeConfirmacao: true,
                    subgruposAfetados: [...compartilhados, ...orfanariam].map(x => x.nome),
                });
            }
        }
        await db.query('DELETE FROM vehicle_types WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteType:', err);
        res.status(500).json({ error: 'Erro ao excluir tipo.' });
    }
};

// ── Sub-tipos ───────────────────────────────────────────────────────────────
// Aceita `type_ids: []` (novo) e `type_id` avulso (chamadores antigos).
const lerTypeIds = (body) => {
    if (Array.isArray(body.type_ids)) return [...new Set(body.type_ids.filter(Boolean))];
    if (body.type_id) return [body.type_id];
    return [];
};

const createSubType = async (req, res) => {
    const nome = (req.body.nome || '').trim();
    const typeIds = lerTypeIds(req.body);
    if (!nome) return res.status(400).json({ error: 'Nome do subgrupo é obrigatório.' });

    let regra;
    try {
        regra = await validarCategoriaUnica(typeIds);
    } catch (e) {
        // Falha de infraestrutura não é erro do payload: 422 com a mensagem crua do
        // driver dizia ao usuário que ele preencheu algo errado e não gravava log.
        console.error('[vehicleTaxonomy] createSubType/validação:', e);
        return res.status(500).json({ error: 'Não foi possível validar os grupos informados. Tente novamente.' });
    }
    if (!regra.ok) return res.status(422).json({ error: regra.erro });

    const id = randomUUID();
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('INSERT INTO vehicle_sub_types (id, nome) VALUES (?, ?)', [id, nome]);
        for (const typeId of typeIds) {
            await conn.query(
                'INSERT IGNORE INTO vehicle_type_sub_types (type_id, sub_type_id) VALUES (?, ?)', [typeId, id]);
        }
        await conn.commit();
        emitSync(req);
        res.status(201).json({ id, nome, grupos: typeIds });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: `Já existe um subgrupo chamado "${nome}". Vincule-o a este grupo em vez de criar outro.` });
        }
        console.error('[vehicleTaxonomy] createSubType:', err);
        res.status(500).json({ error: 'Erro ao criar subgrupo.' });
    } finally {
        conn.release();
    }
};

const updateSubType = async (req, res) => {
    const { id } = req.params;
    const nome = (req.body.nome || '').trim();
    const typeIds = lerTypeIds(req.body);
    if (!nome) return res.status(400).json({ error: 'Nome do subgrupo é obrigatório.' });

    try {
        const [[atual]] = await db.query('SELECT id, nome FROM vehicle_sub_types WHERE id = ?', [id]);
        if (!atual) return res.status(404).json({ error: 'Subgrupo não encontrado.' });

        // Renomear quebra vínculo: veículos, plano de obra e apontamento guardam
        // a STRING, não o id. Mesma proteção de verificarItensRemovidos.
        if (nome !== atual.nome) {
            const veiculos = await subTypeInUse(atual.nome);
            const planos = await subTypeEmPlanos(atual.nome);
            if (veiculos > 0 || planos > 0) {
                const partes = [];
                if (veiculos) partes.push(`${veiculos} veículo${veiculos > 1 ? 's' : ''}`);
                if (planos) partes.push(`${planos} obra${planos > 1 ? 's' : ''} com este item no plano`);
                return res.status(409).json({
                    error: `Não é possível renomear "${atual.nome}": ${partes.join(' e ')} apontam para esse nome. `
                        + 'O vínculo é gravado pelo nome, então renomear deixaria essas horas órfãs.',
                });
            }
        }

        // type_ids ausente = só renomeando; mantém os vínculos como estão.
        if (typeIds.length > 0) {
            const regra = await validarCategoriaUnica(typeIds);
            if (!regra.ok) return res.status(422).json({ error: regra.erro });
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('UPDATE vehicle_sub_types SET nome = ? WHERE id = ?', [nome, id]);
            if (typeIds.length > 0) {
                await conn.query('DELETE FROM vehicle_type_sub_types WHERE sub_type_id = ?', [id]);
                for (const typeId of typeIds) {
                    await conn.query(
                        'INSERT IGNORE INTO vehicle_type_sub_types (type_id, sub_type_id) VALUES (?, ?)', [typeId, id]);
                }
            }
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        // Quando `type_ids` não veio, os vínculos foram preservados — responder
        // `[]` faria um cliente que atualiza estado local pela resposta acreditar
        // que o subgrupo ficou sem grupo nenhum.
        const [vinculosAtuais] = await db.query(
            'SELECT type_id FROM vehicle_type_sub_types WHERE sub_type_id = ?', [id]);

        emitSync(req);
        res.json({
            message: 'Subgrupo atualizado.',
            id, nome,
            grupos: vinculosAtuais.map(v => v.type_id),
        });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um subgrupo com esse nome.' });
        console.error('[vehicleTaxonomy] updateSubType:', err);
        res.status(500).json({ error: 'Erro ao atualizar subgrupo.' });
    }
};

const deleteSubType = async (req, res) => {
    const { id } = req.params;
    try {
        const [[sub]] = await db.query('SELECT nome FROM vehicle_sub_types WHERE id = ?', [id]);
        if (!sub) return res.status(204).end();

        const veiculos = await subTypeInUse(sub.nome);
        const planos = await subTypeEmPlanos(sub.nome);
        if (veiculos > 0 || planos > 0) {
            const partes = [];
            if (veiculos) partes.push(`${veiculos} veículo${veiculos > 1 ? 's' : ''} cadastrado${veiculos > 1 ? 's' : ''} nele`);
            if (planos) partes.push(`${planos} obra${planos > 1 ? 's' : ''} com este item no plano de trabalho`);
            return res.status(409).json({
                error: `Não é possível excluir "${sub.nome}": ${partes.join(' e ')}.`,
            });
        }

        await db.query('DELETE FROM vehicle_sub_types WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteSubType:', err);
        res.status(500).json({ error: 'Erro ao excluir subgrupo.' });
    }
};

// ── Auxiliar: quais tipos (por nome) estão em uso por veículos ────────────────
const typesInUse = async (nomes) => {
    if (!nomes || nomes.length === 0) return [];
    const placeholders = nomes.map(() => '?').join(',');
    try {
        const [rows] = await db.query(
            `SELECT DISTINCT tipo FROM vehicles WHERE tipo IN (${placeholders})`,
            nomes
        );
        return rows.map(r => r.tipo);
    } catch (err) {
        console.warn('[vehicleTaxonomy] typesInUse:', err.message);
        return [];
    }
};

module.exports = {
    getTree,
    listSubTypes,
    createGroup, updateGroup, deleteGroup,
    createType, updateType, deleteType,
    createSubType, updateSubType, deleteSubType,
};
