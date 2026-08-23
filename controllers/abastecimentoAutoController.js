// backend/controllers/abastecimentoAutoController.js
//
// Configuração e acompanhamento do aceite automático de abastecimento.
// Ver docs/aceite-automatico-ia.md.

const db = require('../database');
const motor = require('../services/abastecimentoAutoService');
const visao = require('../services/aiVisionService');

// Campos editáveis pela tela de admin. Whitelist explícita: `id` e `updated_at`
// ficam de fora de propósito, e qualquer coluna nova precisa ser adicionada
// aqui conscientemente.
const CAMPOS_EDITAVEIS = {
    ativo: 'bool',
    modo: 'modo',
    obras_habilitadas: 'json',
    tipos_habilitados: 'json',
    confianca_minima_painel: 'fracao',
    confianca_minima_cupom: 'fracao',
    tolerancia_leitura_km: 'numero',
    tolerancia_leitura_hr: 'numero',
    tolerancia_media_padrao: 'numero',
    min_intervalos_historico: 'inteiro',
    exigir_tanque_cheio_historico: 'bool',
    percentual_minimo_tanque: 'numero',
    limite_valor_auto: 'numero',
    modelo_rapido: 'texto',
    modelo_preciso: 'texto',
};

// parseFloat('2,5') devolve 2 — para na vírgula. A tela é em português e o
// usuário digita vírgula decimal, então normalizamos antes de converter.
const numeroBR = (valor) => {
    if (typeof valor === 'number') return valor;
    if (valor == null || valor === '') return NaN;
    return parseFloat(String(valor).trim().replace(/\s/g, '').replace(',', '.'));
};

const converter = (tipo, valor) => {
    switch (tipo) {
        case 'bool':
            return (valor === true || valor === 1 || valor === '1' || valor === 'true') ? 1 : 0;
        case 'modo':
            return valor === 'ativo' ? 'ativo' : 'sombra';
        case 'json':
            return JSON.stringify(Array.isArray(valor) ? valor : []);
        case 'fracao': {
            const n = numeroBR(valor);
            if (isNaN(n)) return null;
            // Aceita tanto 0,90 quanto 90 vindos da tela.
            const f = n > 1 ? n / 100 : n;
            return Math.max(0, Math.min(1, f));
        }
        case 'inteiro': {
            const n = Math.round(numeroBR(valor));
            return isNaN(n) ? null : Math.max(0, n);
        }
        case 'numero': {
            const n = numeroBR(valor);
            return isNaN(n) ? null : Math.max(0, n);
        }
        default:
            return valor == null ? null : String(valor).slice(0, 60);
    }
};

const getConfig = async (req, res) => {
    try {
        const config = await motor.carregarConfig(db);
        if (!config) return res.status(404).json({ error: 'Configuração não encontrada.' });
        res.json({
            ...config,
            // A tela precisa saber se a credencial existe para explicar por que o
            // portão de visão está indeterminado, sem nunca expor a chave.
            credencial_ia_configurada: visao.isConfigured(),
        });
    } catch (error) {
        console.error('Erro ao ler config do aceite automático:', error);
        res.status(500).json({ error: 'Erro ao carregar configuração.' });
    }
};

const updateConfig = async (req, res) => {
    try {
        const campos = [];
        const valores = [];

        for (const [campo, tipo] of Object.entries(CAMPOS_EDITAVEIS)) {
            if (!(campo in req.body)) continue;
            const convertido = converter(tipo, req.body[campo]);
            if (convertido === null) continue; // valor inválido: ignora em vez de gravar nulo
            campos.push(`${campo} = ?`);
            valores.push(convertido);
        }

        if (campos.length === 0) {
            return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
        }

        campos.push('updated_by = ?');
        valores.push(req.user.id);

        await db.query(`UPDATE abastecimento_auto_config SET ${campos.join(', ')} WHERE id = 1`, valores);
        motor.invalidarConfig();

        const config = await motor.carregarConfig(db);
        if (req.io) req.io.emit('server:sync', { targets: ['abastecimento_auto'] });

        console.log(`⚙️ [abastecimentoAuto] configuração alterada por usuário ${req.user.id}: `
            + `ativo=${config.ativo} modo=${config.modo}`);
        res.json({ ...config, credencial_ia_configurada: visao.isConfigured() });
    } catch (error) {
        console.error('Erro ao salvar config do aceite automático:', error);
        res.status(500).json({ error: 'Erro ao salvar configuração.' });
    }
};

/**
 * Painel de concordância — o critério objetivo para virar do modo sombra para o
 * ativo. Cruza o que a IA decidiu com o que o humano acabou fazendo.
 *
 * Falso positivo (a linha que importa): a IA teria liberado e o humano NEGOU.
 * Enquanto houver qualquer um desses, não se liga o modo ativo.
 */
const getMetricas = async (req, res) => {
    try {
        const dias = Math.min(parseInt(req.query.dias, 10) || 30, 180);

        const [[totais]] = await db.query(
            `SELECT
                COUNT(*) AS analisadas,
                SUM(ia_decisao IN ('AUTO_LIBERADO', 'AUTO_LIBERADO_SIMULADO')) AS ia_liberaria,
                SUM(ia_decisao = 'MANUAL') AS ia_encaminharia,
                SUM(ia_decisao = 'ERRO') AS ia_erro,
                SUM(liberacao_automatica = 1) AS liberadas_de_fato
               FROM solicitacoes_abastecimento
              WHERE ia_analisado_em >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [dias]
        );

        // Concordância só faz sentido em solicitações já resolvidas pelo humano.
        const [[concordancia]] = await db.query(
            `SELECT
                COUNT(*) AS resolvidas,
                SUM(ia_decisao IN ('AUTO_LIBERADO','AUTO_LIBERADO_SIMULADO') AND status <> 'NEGADO') AS acerto_liberar,
                SUM(ia_decisao IN ('AUTO_LIBERADO','AUTO_LIBERADO_SIMULADO') AND status = 'NEGADO') AS falso_positivo,
                SUM(ia_decisao = 'MANUAL' AND status = 'NEGADO') AS acerto_reter,
                SUM(ia_decisao = 'MANUAL' AND status <> 'NEGADO') AS retencao_desnecessaria
               FROM solicitacoes_abastecimento
              WHERE ia_analisado_em >= DATE_SUB(NOW(), INTERVAL ? DAY)
                AND status IN ('LIBERADO','AGUARDANDO_BAIXA','CONCLUIDO','NEGADO')`,
            [dias]
        );

        // Qual portão mais retém — mostra onde ajustar limiar ou cadastro.
        const [porPortao] = await db.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(p.portao, '$.nome'))   AS portao,
                    JSON_UNQUOTE(JSON_EXTRACT(p.portao, '$.status')) AS status,
                    COUNT(*) AS n
               FROM solicitacoes_abastecimento s
               JOIN JSON_TABLE(s.ia_motivos, '$[*]' COLUMNS (portao JSON PATH '$')) p
              WHERE s.ia_analisado_em >= DATE_SUB(NOW(), INTERVAL ? DAY)
                AND s.ia_motivos IS NOT NULL
              GROUP BY portao, status
              HAVING status <> 'ok'
              ORDER BY n DESC`,
            [dias]
        );

        const [[custo]] = await db.query(
            `SELECT COUNT(*) AS chamadas,
                    SUM(escalonou) AS escalonadas,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    ROUND(AVG(latencia_ms)) AS latencia_media_ms
               FROM solicitacao_ia_analises
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                AND modelo IS NOT NULL`,
            [dias]
        );

        const [fila] = await db.query(
            `SELECT status, COUNT(*) AS n FROM abastecimento_ia_fila GROUP BY status`
        );

        const config = await motor.carregarConfig(db);

        res.json({
            dias,
            modo: config ? config.modo : null,
            ativo: config ? config.ativo : 0,
            credencial_ia_configurada: visao.isConfigured(),
            totais,
            concordancia,
            porPortao,
            custo,
            fila,
        });
    } catch (error) {
        console.error('Erro ao calcular métricas do aceite automático:', error);
        res.status(500).json({ error: 'Erro ao calcular métricas.' });
    }
};

/** Reprocessa a análise de uma solicitação (após ajustar limiar, por exemplo). */
const reprocessar = async (req, res) => {
    const { id } = req.params;
    const etapa = req.body.etapa === motor.ETAPA.CUPOM ? motor.ETAPA.CUPOM : motor.ETAPA.PAINEL;
    try {
        if (!visao.isConfigured()) {
            return res.status(409).json({ error: 'ANTHROPIC_API_KEY não configurada neste ambiente.' });
        }
        const resultado = etapa === motor.ETAPA.CUPOM
            ? await motor.analisarComprovante(id)
            : await motor.analisarSolicitacao(id);

        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
        res.json(resultado);
    } catch (error) {
        console.error('Erro ao reprocessar análise:', error);
        res.status(500).json({ error: 'Erro ao reprocessar: ' + error.message });
    }
};

/** Histórico de análises de uma solicitação (para o painel de detalhe). */
const getAnalises = async (req, res) => {
    const { id } = req.params;
    try {
        const [linhas] = await db.query(
            `SELECT id, etapa, modelo, escalonou, confianca, portoes_json, decisao,
                    input_tokens, output_tokens, latencia_ms, erro, created_at
               FROM solicitacao_ia_analises
              WHERE solicitacao_id = ?
              ORDER BY created_at DESC
              LIMIT 20`,
            [id]
        );
        res.json(linhas);
    } catch (error) {
        console.error('Erro ao listar análises:', error);
        res.status(500).json({ error: 'Erro ao listar análises.' });
    }
};

module.exports = { getConfig, updateConfig, getMetricas, reprocessar, getAnalises };
