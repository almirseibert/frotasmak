// controllers/obrasPlanilhaController.js
// Fila de obras lidas da planilha oficial (ver services/planilhaObrasService.js).
// A aprovação não mora aqui: a obra é criada pelo POST /obras normal com
// `planilha_import_id`, para passar pelas mesmas regras do cadastro manual.
const db = require('../database');
const planilha = require('../services/planilhaObrasService');

const quem = (req) => req.user?.email || String(req.user?.id || '');

// GET /api/obras-planilha
const listar = async (req, res) => {
    try {
        const [pendentes] = await db.query(
            "SELECT * FROM obras_planilha WHERE status = 'pendente' ORDER BY detectado_em DESC, municipio"
        );
        const [contagem] = await db.query('SELECT status, COUNT(*) AS n FROM obras_planilha GROUP BY status');
        const [obrasSeapi] = await db.query(
            "SELECT id, nome, valorTotalContrato, status FROM obras WHERE orgao_contratante = 'SEAPI'"
        );

        const itens = pendentes.map(p => {
            const base = planilha.nomeBase(p.municipio);
            return {
                ...p,
                nome: planilha.titulo(p.municipio),
                fiscal: p.fiscal ? planilha.titulo(p.fiscal) : null,
                plano: planilha.parseJson(p.plano_json),
                alertas: planilha.parseJson(p.alertas_json) || [],
                plano_json: undefined,
                alertas_json: undefined,
                // Obras com o mesmo nome-base: opções do "Vincular".
                candidatas: obrasSeapi.filter(o => planilha.nomeBase(o.nome) === base),
            };
        });

        res.json({
            configurado: planilha.isConfigured(),
            ultimaExecucao: planilha.estado.ultimaExecucao,
            ultimoErro: planilha.estado.ultimoErro,
            contagem: Object.fromEntries(contagem.map(c => [c.status, c.n])),
            pendentes: itens,
        });
    } catch (error) {
        console.error('❌ [PLANILHA-OBRAS] listar:', error);
        res.status(500).json({ error: 'Erro ao listar obras da planilha.' });
    }
};

// POST /api/obras-planilha/sincronizar — "Verificar agora"
const sincronizar = async (req, res) => {
    if (!planilha.isConfigured()) {
        return res.status(400).json({ error: 'Leitura da planilha desligada: faltam PLANILHA_OBRAS_ID e GOOGLE_SERVICE_ACCOUNT_JSON no servidor.' });
    }
    try {
        const resumo = await planilha.sincronizar({ relerPlanos: true });
        res.json(resumo);
    } catch (error) {
        console.error('❌ [PLANILHA-OBRAS] sincronizar:', error.message);
        res.status(502).json({ error: `Não foi possível ler a planilha: ${planilha.estado.ultimoErro || error.message}` });
    }
};

// POST /api/obras-planilha/:id/ignorar
const ignorar = async (req, res) => {
    try {
        const [r] = await db.query(
            "UPDATE obras_planilha SET status = 'ignorada', resolvido_em = NOW(), resolvido_por = ? WHERE id = ? AND status = 'pendente'",
            [quem(req), req.params.id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Linha não encontrada ou já resolvida.' });
        req.io.emit('server:sync', { targets: ['obras_planilha'] });
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ [PLANILHA-OBRAS] ignorar:', error);
        res.status(500).json({ error: 'Erro ao ignorar linha da planilha.' });
    }
};

// POST /api/obras-planilha/:id/vincular { obraId } — a obra já existe no sistema
const vincular = async (req, res) => {
    const { obraId } = req.body || {};
    if (!obraId) return res.status(400).json({ error: 'Informe a obra.' });
    try {
        const [[obra]] = await db.query('SELECT id FROM obras WHERE id = ?', [obraId]);
        if (!obra) return res.status(404).json({ error: 'Obra não encontrada.' });
        const [r] = await db.query(
            "UPDATE obras_planilha SET status = 'vinculada', obra_id = ?, resolvido_em = NOW(), resolvido_por = ? WHERE id = ? AND status = 'pendente'",
            [obraId, quem(req), req.params.id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Linha não encontrada ou já resolvida.' });
        req.io.emit('server:sync', { targets: ['obras_planilha'] });
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ [PLANILHA-OBRAS] vincular:', error);
        res.status(500).json({ error: 'Erro ao vincular linha da planilha.' });
    }
};

module.exports = { listar, sincronizar, ignorar, vincular };
