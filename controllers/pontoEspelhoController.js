// Espelho de ponto importado — alimenta a trilha "Ponto" do Relatório de
// Jornadas por Operador. Fluxo: ler (PDF → marcações, sem gravar) → o usuário
// confere na tela → salvar.

const { randomUUID } = require('crypto');
const db = require('../database');
const {
    lerEspelho, normalizarMarcacoes, minutosTrabalhados, RE_DATA,
} = require('../services/pontoEspelhoService');

const MAX_DIAS_POR_ENVIO = 62;

const semAcento = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();

// ── POST /api/analise-gerencial/ponto/espelho/ler (multipart, campo "arquivo") ─

const ler = async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Envie o arquivo do espelho de ponto.' });
    try {
        const r = await lerEspelho({ buffer: req.file.buffer, mimetype: req.file.mimetype });
        if (!r.ok) {
            const status = r.erro === 'SEM_CREDENCIAL' ? 503 : 422;
            return res.status(status).json({ error: r.detalhe, codigo: r.erro });
        }

        // Sugere o funcionário pelo nome lido no documento (comparação sem acento).
        let funcionarioSugerido = null;
        if (r.funcionario.nome) {
            const alvo = semAcento(r.funcionario.nome);
            const [emps] = await db.query('SELECT id, nome FROM employees');
            const achados = emps.filter(e => semAcento(e.nome) === alvo);
            if (achados.length === 1) funcionarioSugerido = { id: achados[0].id, nome: achados[0].nome };
        }

        res.json({
            arquivoNome: req.file.originalname || null,
            funcionario: r.funcionario,
            funcionarioSugerido,
            periodo: r.periodo,
            dias: r.dias,
        });
    } catch (e) {
        console.error('Erro ao ler espelho de ponto:', e);
        res.status(500).json({ error: 'Erro ao ler o espelho de ponto.' });
    }
};

// ── POST /api/analise-gerencial/ponto/espelho ────────────────────────────────
// body: { employeeId, origem?, arquivoNome?, dias: [{ data, marcacoes[], observacao? }] }
// Dia sem marcação e sem observação APAGA o registro existente daquele dia.

const salvar = async (req, res) => {
    const { employeeId, arquivoNome } = req.body || {};
    const origem = req.body && req.body.origem === 'manual' ? 'manual' : 'pdf';
    const dias = Array.isArray(req.body && req.body.dias) ? req.body.dias : [];

    if (!employeeId) return res.status(400).json({ error: 'Selecione o funcionário.' });
    if (!dias.length) return res.status(400).json({ error: 'Nenhum dia para salvar.' });
    if (dias.length > MAX_DIAS_POR_ENVIO) {
        return res.status(400).json({ error: `Envie no máximo ${MAX_DIAS_POR_ENVIO} dias por vez.` });
    }

    const linhas = [];
    const vistos = new Set();
    for (const d of dias) {
        const data = String(d && d.data ? d.data : '').slice(0, 10);
        if (!RE_DATA.test(data)) return res.status(400).json({ error: `Data inválida: ${d && d.data}` });
        if (vistos.has(data)) return res.status(400).json({ error: `Dia repetido no envio: ${data}` });
        vistos.add(data);

        const brutas = Array.isArray(d.marcacoes) ? d.marcacoes.filter(m => String(m || '').trim()) : [];
        const marcacoes = normalizarMarcacoes(brutas);
        if (marcacoes.length !== brutas.length) {
            return res.status(400).json({ error: `Horário inválido em ${data}. Use o formato HH:MM.` });
        }
        linhas.push({
            data,
            marcacoes,
            observacao: d.observacao ? String(d.observacao).trim().slice(0, 120) : null,
        });
    }

    let connection;
    try {
        const [emp] = await db.query('SELECT id FROM employees WHERE id = ? LIMIT 1', [employeeId]);
        if (!emp.length) return res.status(404).json({ error: 'Funcionário não encontrado.' });

        connection = await db.getConnection();
        await connection.beginTransaction();
        let gravados = 0;
        let removidos = 0;
        for (const l of linhas) {
            if (!l.marcacoes.length && !l.observacao) {
                const [r] = await connection.query(
                    'DELETE FROM ponto_espelho_dias WHERE employee_id = ? AND data = ?',
                    [employeeId, l.data]
                );
                removidos += r.affectedRows;
                continue;
            }
            await connection.query(
                `INSERT INTO ponto_espelho_dias
                    (id, employee_id, data, marcacoes_json, observacao, origem, arquivo_nome, importado_por)
                 VALUES (?,?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                    marcacoes_json = VALUES(marcacoes_json),
                    observacao     = VALUES(observacao),
                    origem         = VALUES(origem),
                    arquivo_nome   = VALUES(arquivo_nome),
                    importado_por  = VALUES(importado_por)`,
                [
                    randomUUID(), employeeId, l.data, JSON.stringify(l.marcacoes), l.observacao,
                    origem, arquivoNome ? String(arquivoNome).slice(0, 255) : null,
                    req.user && req.user.id != null ? String(req.user.id) : null,
                ]
            );
            gravados++;
        }
        await connection.commit();
        res.json({ message: 'Ponto salvo.', gravados, removidos });
    } catch (e) {
        if (connection) await connection.rollback();
        console.error('Erro ao salvar espelho de ponto:', e);
        res.status(500).json({ error: 'Erro ao salvar o ponto.' });
    } finally {
        if (connection) connection.release();
    }
};

// ── GET /api/analise-gerencial/ponto/espelho/:employeeId?startDate&endDate ───

const listar = async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        const [rows] = await db.query(
            `SELECT DATE_FORMAT(data, '%Y-%m-%d') AS data, marcacoes_json, observacao, origem,
                    arquivo_nome, importado_em
               FROM ponto_espelho_dias
              WHERE employee_id = ? AND data BETWEEN ? AND ?
              ORDER BY data`,
            [employeeId, startDate, endDate]
        );
        res.json(rows.map(r => {
            let marcacoes = r.marcacoes_json;
            if (typeof marcacoes === 'string') {
                try { marcacoes = JSON.parse(marcacoes); } catch (_) { marcacoes = []; }
            }
            marcacoes = normalizarMarcacoes(marcacoes);
            return {
                data: r.data,
                marcacoes,
                observacao: r.observacao,
                minutos: minutosTrabalhados(marcacoes),
                origem: r.origem,
                arquivoNome: r.arquivo_nome,
                importadoEm: r.importado_em,
            };
        }));
    } catch (e) {
        console.error('Erro ao listar espelho de ponto:', e);
        res.status(500).json({ error: 'Erro ao buscar o ponto.' });
    }
};

module.exports = { ler, salvar, listar };
