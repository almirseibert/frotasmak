const db = require('../database');
const { precificacaoDaObra, custoCombustivelPorObra } = require('../utils/obraFinanceiro');
const { _computeAnalyticsCore, _fmtDate } = require('./obraSupervisorController');
const { carregarTaxonomia } = require('../utils/planoItem');

const HORAS_PADRAO_DIA = 8;
const FUEL_LIMIT_PCT = 20;

const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
};

const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (e) {
        console.warn('[dashboard] query falhou, devolvendo vazio:', e.code || e.message);
        return [];
    }
};

const classifyAproveitamento = (pct) => {
    if (pct >= 70) return 'verde';
    if (pct >= 40) return 'amarelo';
    return 'vermelho';
};

// Calcula projeção leve por obra a partir de logs e abastecimentos já agregados.
// Não chama getProjecaoObra para evitar custo de 10+ requisições; cobre só os
// campos que a home consome (combustível %, dias para finalizar, % concluído).
const computeProjecoesLeves = async (obraIds) => {
    if (!obraIds.length) return new Map();

    const placeholders = obraIds.map(() => '?').join(',');

    const obras = await safeQuery(
        `SELECT id, nome, horasContratadasPorTipo, valoresPorTipo,
                horasContratadasPorSubTipo, valoresPorSubTipo
           FROM obras WHERE id IN (${placeholders})`,
        obraIds
    );

    // Item declarado na alocação, grupo e subgrupo do veículo lado a lado: o
    // preço sai de `precificacaoDaObra`, que precifica por subgrupo (o nível do
    // contrato) e só cai no mapa legado por grupo quando não acha.
    // Ver utils/obraFinanceiro.js e docs/item-de-contrato-e-substituicao-plano.md.
    const logs = await safeQuery(`
        SELECT l.obraId,
               NULLIF(l.planoItemKey, '') AS itemKey,
               v.tipo                     AS grupoVeiculo,
               NULLIF(v.sub_tipo, '')     AS subgrupoVeiculo,
               SUM(l.totalHours) AS horas,
               MIN(DATE_FORMAT(l.date, '%Y-%m-%d')) AS primeira_data,
               MAX(DATE_FORMAT(l.date, '%Y-%m-%d')) AS ultima_data,
               COUNT(DISTINCT DATE(l.date)) AS dias_lancamento
          FROM daily_work_logs l
          LEFT JOIN vehicles v ON v.id = l.vehicleId
         WHERE l.obraId IN (${placeholders})
         GROUP BY l.obraId, itemKey, grupoVeiculo, subgrupoVeiculo
    `, obraIds);

    // Custo real: abastecimentos concluídos + comboio/manuais. Ver obraFinanceiro.
    let custoCombustivel = new Map();
    try {
        custoCombustivel = await custoCombustivelPorObra(db, obraIds);
    } catch (e) {
        console.warn('[dashboard] custo de combustível falhou, devolvendo vazio:', e.code || e.message);
    }

    const logsPorObra = new Map();
    for (const r of logs) {
        const key = String(r.obraId);
        if (!logsPorObra.has(key)) logsPorObra.set(key, { totalHoras: 0, faturamento: 0, diasLancamento: 0, primeiraData: null, ultimaData: null, porTipo: [] });
        const entry = logsPorObra.get(key);
        entry.porTipo.push(r);
        entry.totalHoras += parseFloat(r.horas) || 0;
        entry.diasLancamento = Math.max(entry.diasLancamento, parseInt(r.dias_lancamento, 10) || 0);
        if (!entry.primeiraData || (r.primeira_data && r.primeira_data < entry.primeiraData)) {
            entry.primeiraData = r.primeira_data;
        }
        if (!entry.ultimaData || (r.ultima_data && r.ultima_data > entry.ultimaData)) {
            entry.ultimaData = r.ultima_data;
        }
    }

    const out = new Map();
    for (const obra of obras) {
        const key = String(obra.id);
        const { precoDaHora, horasContratadas, faturamentoContratado } = precificacaoDaObra(obra);
        const entry = logsPorObra.get(key) || { totalHoras: 0, diasLancamento: 0, porTipo: [] };

        let faturamento = 0;
        // Horas que caem fora do contrato: nem o subgrupo nem o grupo têm preço.
        // Quase sempre é cadastro -- veículo sem sub_tipo, ou item de contrato
        // não mapeado -- e some em silêncio do faturamento.
        // Ver docs/item-de-contrato-e-substituicao-plano.md.
        let horasSemPreco = 0;
        for (const t of entry.porTipo) {
            const preco = precoDaHora(t);
            const horas = parseFloat(t.horas) || 0;
            faturamento += horas * preco;
            if (preco <= 0 && horas > 0) {
                horasSemPreco += horas;
            }
        }

        const percentConcluido = horasContratadas > 0 ? (entry.totalHoras / horasContratadas) * 100 : 0;
        const ritmoHorasPorDia = entry.diasLancamento > 0 ? entry.totalHoras / entry.diasLancamento : 0;
        const horasRestantes = Math.max(0, horasContratadas - entry.totalHoras);
        const diasParaFinalizar = ritmoHorasPorDia > 0 ? Math.ceil(horasRestantes / ritmoHorasPorDia) : null;

        const custoCombust = custoCombustivel.get(key)?.total || 0;
        const percentCombust = faturamento > 0 ? (custoCombust / faturamento) * 100 : 0;
        // Mesma regra de getProjecaoObra (analiseGerencialController): custo
        // projetado a 100% sobre o faturamento do contrato inteiro (horas
        // contratadas × valor hora), mesma base do percentCombust.
        const custoCombustProjetado = percentConcluido > 1
            ? custoCombust / (percentConcluido / 100)
            : null;
        const projecaoFinalPercent = custoCombustProjetado != null && faturamentoContratado > 0
            ? (custoCombustProjetado / faturamentoContratado) * 100
            : percentCombust;

        out.set(key, {
            nome: obra.nome,
            horasContratadas,
            percentConcluido: Math.round(percentConcluido * 10) / 10,
            ritmoHorasPorDia: Math.round(ritmoHorasPorDia * 10) / 10,
            diasParaFinalizar,
            faturamento,
            custoCombust,
            percentCombust: Math.round(percentCombust * 10) / 10,
            projecaoFinalPercent: Math.round(projecaoFinalPercent * 10) / 10,
            horasSemPreco: Math.round(horasSemPreco * 10) / 10,
            ultimoLancamento: entry.ultimaData || null,
            totalHoras: Math.round(entry.totalHoras * 10) / 10,
        });
    }
    return out;
};

const buildLinhaResumo = (proj, aproveitamentoPct) => {
    const parts = [];
    if (proj.projecaoFinalPercent > FUEL_LIMIT_PCT) {
        parts.push(`combustível projetado ${proj.projecaoFinalPercent.toLocaleString('pt-BR')}%`);
    }
    if (proj.diasParaFinalizar !== null && proj.percentConcluido >= 70 && proj.diasParaFinalizar <= 15) {
        parts.push(`estima término em ${proj.diasParaFinalizar}d (${proj.percentConcluido}%)`);
    } else if (proj.percentConcluido >= 100) {
        parts.push('escopo atingido — revisar fechamento');
    }
    if (aproveitamentoPct >= 80 && parts.length === 0) {
        parts.push(`aproveitamento ${Math.round(aproveitamentoPct)}% no período`);
    }
    if (parts.length === 0) {
        parts.push(`${Math.round(proj.percentConcluido)}% concluída · ritmo ${proj.ritmoHorasPorDia.toLocaleString('pt-BR')} h/dia`);
    }
    return parts.join(' · ');
};

exports.getHomeSummary = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(12, 0, 0, 0);

        // Janela consolidada: últimos 30d com buffer 7d (today-37 → today-7)
        const endConsolidated = addDays(today, -7);
        const startConsolidated = addDays(endConsolidated, -29);

        // Janela do pulso diário: últimos 14 dias corridos (não úteis) até hoje
        const endPulse = today;
        const startPulse = addDays(today, -13);

        const analytics = await _computeAnalyticsCore(
            'geral',
            _fmtDate(startConsolidated),
            _fmtDate(endConsolidated)
        );

        // Período anterior (mesmo comprimento) para delta de aproveitamento
        const prevEnd = addDays(startConsolidated, -1);
        const prevStart = addDays(prevEnd, -29);
        const analyticsPrev = await _computeAnalyticsCore(
            'geral',
            _fmtDate(prevStart),
            _fmtDate(prevEnd)
        );

        const veiculosTrabalharam = await safeQuery(`
            SELECT COUNT(DISTINCT vehicleId) AS qtd
              FROM daily_work_logs
             WHERE date BETWEEN ? AND ?
               AND totalHours > 0
        `, [_fmtDate(startConsolidated), _fmtDate(endConsolidated)]);
        const qtdTrabalharam = parseInt(veiculosTrabalharam[0]?.qtd || 0, 10);

        // Projeções leves para todas as obras com atividade no período
        const obraIdsAtivos = (analytics.porObra || []).map(o => o.obraId).filter(Boolean);
        const projecoes = await computeProjecoesLeves(obraIdsAtivos);

        const obrasAnalisadas = (analytics.porObra || []).map(o => {
            const proj = projecoes.get(String(o.obraId)) || {};
            const emRisco = (proj.projecaoFinalPercent || 0) > FUEL_LIMIT_PCT
                         || (proj.diasParaFinalizar !== null && proj.diasParaFinalizar > 60 && proj.percentConcluido < 50);
            return {
                obraId: o.obraId,
                obraNome: o.obraNome,
                aproveitamento: Math.round(o.aproveitamento * 10) / 10,
                horasExecutadas: Math.round(o.horas_executadas * 10) / 10,
                qtdVeiculos: o.qtdVeiculos,
                percentConcluido: proj.percentConcluido ?? null,
                ritmoHorasPorDia: proj.ritmoHorasPorDia ?? null,
                diasParaFinalizar: proj.diasParaFinalizar ?? null,
                projecaoFinalCombustivel: proj.projecaoFinalPercent ?? null,
                emRisco,
            };
        });

        // Combustível/Receita agregado de todas as obras analisadas
        let faturamentoTotal = 0;
        let custoCombustTotal = 0;
        for (const id of obraIdsAtivos) {
            const p = projecoes.get(String(id));
            if (p) {
                faturamentoTotal += p.faturamento;
                custoCombustTotal += p.custoCombust;
            }
        }
        const fuelPct = faturamentoTotal > 0 ? (custoCombustTotal / faturamentoTotal) * 100 : 0;

        // Obras em foco: 3 piores aproveitamentos + 2 melhores (mesmo critério visual do mockup)
        const ordenadoPiorMelhor = [...obrasAnalisadas].sort((a, b) => a.aproveitamento - b.aproveitamento);
        const criticas = ordenadoPiorMelhor.slice(0, 3).map(o => ({
            ...o,
            status: classifyAproveitamento(o.aproveitamento),
            linhaResumo: buildLinhaResumo({
                projecaoFinalPercent: o.projecaoFinalCombustivel || 0,
                diasParaFinalizar: o.diasParaFinalizar,
                percentConcluido: o.percentConcluido || 0,
                ritmoHorasPorDia: o.ritmoHorasPorDia || 0,
            }, o.aproveitamento),
        }));
        const destaques = ordenadoPiorMelhor.slice(-2).reverse().map(o => ({
            ...o,
            status: 'verde',
            linhaResumo: buildLinhaResumo({
                projecaoFinalPercent: o.projecaoFinalCombustivel || 0,
                diasParaFinalizar: o.diasParaFinalizar,
                percentConcluido: o.percentConcluido || 0,
                ritmoHorasPorDia: o.ritmoHorasPorDia || 0,
            }, o.aproveitamento),
        }));

        const obrasEmFoco = [...criticas, ...destaques];

        // Ranking: top 5 melhores (por aproveitamento DESC) e bottom 5 (ASC)
        const top = [...obrasAnalisadas]
            .sort((a, b) => b.aproveitamento - a.aproveitamento)
            .slice(0, 5)
            .map(o => ({ obraId: o.obraId, nome: o.obraNome, aproveitamento: o.aproveitamento }));
        const atencao = [...obrasAnalisadas]
            .sort((a, b) => a.aproveitamento - b.aproveitamento)
            .slice(0, 5)
            .map(o => ({ obraId: o.obraId, nome: o.obraNome, aproveitamento: o.aproveitamento, classe: classifyAproveitamento(o.aproveitamento) }));

        // Pulso diário: horas/dia nos últimos 14 dias. Marca quais estão "em consolidação" (após endConsolidated).
        const pulseRows = await safeQuery(`
            SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, SUM(totalHours) AS h
              FROM daily_work_logs
             WHERE date BETWEEN ? AND ?
             GROUP BY d
             ORDER BY d
        `, [_fmtDate(startPulse), _fmtDate(endPulse)]);
        const pulseMap = new Map(pulseRows.map(r => [r.d, parseFloat(r.h) || 0]));
        const consolidatedEndStr = _fmtDate(endConsolidated);
        const pulseDays = [];
        for (let i = 0; i < 14; i++) {
            const d = addDays(startPulse, i);
            const dStr = _fmtDate(d);
            pulseDays.push({
                date: dStr,
                horas: Math.round((pulseMap.get(dStr) || 0) * 10) / 10,
                emConsolidacao: dStr > consolidatedEndStr,
            });
        }

        // Alertas (queries leves, defensivas — devolvem 0 se a tabela não existir)
        const [solicitRows, revisRows, finesRows] = await Promise.all([
            safeQuery(`SELECT COUNT(*) c FROM solicitacoes_abastecimento WHERE status = 'PENDENTE'`),
            safeQuery(`SELECT COUNT(*) c FROM revisions WHERE proximaRevisaoData IS NOT NULL AND proximaRevisaoData < CURDATE()`),
            safeQuery(`
                SELECT COUNT(*) c,
                       COALESCE(SUM(valor), 0) v
                  FROM fines
                 WHERE LOWER(COALESCE(paymentStatus, '')) NOT IN ('pago', 'paid', 'quitado')
            `),
        ]);

        const obrasEscopoEstourar = obrasAnalisadas.filter(o =>
            o.percentConcluido !== null
            && o.percentConcluido >= 85
            && o.percentConcluido < 100
        ).length;

        const aproveitamentoAtual = analytics.summary.aproveitamento || 0;
        const aproveitamentoAnterior = analyticsPrev.summary.aproveitamento || 0;
        const fuelPctPrev = (() => {
            // delta de combustível/receita: refazendo o cálculo no período anterior seria custoso —
            // devolvemos 0 e marcamos como não disponível para a primeira versão.
            return null;
        })();

        const obrasEmRisco = obrasAnalisadas.filter(o => o.emRisco).length;

        res.json({
            generatedAt: today.toISOString(),
            period: {
                start: _fmtDate(startConsolidated),
                end: _fmtDate(endConsolidated),
                consolidatedUntil: _fmtDate(endConsolidated),
            },
            kpis: {
                aproveitamento: {
                    value: Math.round(aproveitamentoAtual * 10) / 10,
                    deltaPp: Math.round((aproveitamentoAtual - aproveitamentoAnterior) * 10) / 10,
                },
                veiculosAtivos: {
                    trabalharam: qtdTrabalharam,
                    total: analytics.summary.qtdVeiculos,
                },
                combustivelReceita: {
                    value: Math.round(fuelPct * 10) / 10,
                    deltaPp: fuelPctPrev,
                    limit: FUEL_LIMIT_PCT,
                },
                obrasEmRisco,
            },
            obrasEmFoco,
            ranking: { top, atencao },
            pulse: {
                consolidatedEnd: consolidatedEndStr,
                days: pulseDays,
            },
            alerts: {
                solicitacoesPendentes: parseInt(solicitRows[0]?.c || 0, 10),
                revisoesVencidas: parseInt(revisRows[0]?.c || 0, 10),
                obrasEscopoEstourar,
                multasPendentes: {
                    count: parseInt(finesRows[0]?.c || 0, 10),
                    valor: parseFloat(finesRows[0]?.v || 0),
                },
            },
        });
    } catch (error) {
        console.error('❌ Erro em /dashboard/home-summary:', error);
        res.status(500).json({ error: error.message });
    }
};

// ---------------------------------------------------------------------------
// Obras em foco — painel operacional de gestão.
//
// Quatro indicadores, nada de prosa. É tela de trabalho do gestor e também o que
// se projeta para o diretor: lê o número, sabe qual obra, segue a conversa.
//
// O que NÃO entra aqui, de propósito:
//  - Aproveitamento: desaba quando o apontamento atrasa, não quando a obra
//    para. Problema fantasma numa janela que já fecha com buffer de 7 dias.
//    Esse controle vive na página de Desempenho.
//  - Qualquer estimativa de "receita não faturada": a nota fiscal NÃO é
//    emitida por este sistema. Item sem preço no contrato é lacuna de
//    cadastro, não dinheiro perdido — concluir o contrário é inventar número.
// ---------------------------------------------------------------------------

// Uma obra está "em produção" se apontou hora nos últimos 45 dias. Mais simples
// e mais honesto que a janela consolidada: aqui não se mede desempenho, se
// mede o que está rodando agora.
const DIAS_OBRA_ATIVA = 45;

// Limites calibrados na distribuição real da operação (set/2026):
// h/dia por veículo -> mediana 4,7 | p25 3,6   → abaixo de 3,5 é meio turno.
// dias em produção  -> mediana 70  | p90 134   → acima de 120 é cauda longa.
const RITMO_BAIXO_H_DIA_VEICULO = 3.5;
const RITMO_CRITICO_H_DIA_VEICULO = 2.5;
const DIAS_PRODUCAO_LONGA = 120;
const DIAS_PRODUCAO_CRITICA = 160;
// Medianas da mesma calibragem, enviadas à tela junto com os cortes.
const RITMO_MEDIANA_H_DIA_VEICULO = 4.7;
const DIAS_PRODUCAO_MEDIANA = 70;

const fmtNum1 = (v) => (v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

// Substituição que ainda está acontecendo pesa mais que uma já encerrada.
const DIAS_OUTRO_GRUPO_EM_CURSO = 7;

/**
 * Obras onde uma máquina apontou horas carimbadas (planoItemKey) num item do
 * plano que pertence a OUTRO grupo de veículo. Só olha apontamentos com item
 * declarado: sem carimbo, a hora é classificada pelo próprio veículo e não
 * existe "outro grupo". Ver docs/item-de-contrato-e-substituicao-plano.md.
 */
const obrasComItemDeOutroGrupo = async (obraIds, today) => {
    if (!obraIds.length) return [];
    const ph = obraIds.map(() => '?').join(',');

    const [linhas, grupos] = await Promise.all([
        safeQuery(`
            SELECT l.obraId,
                   o.nome                               AS obraNome,
                   TRIM(l.planoItemKey)                 AS itemKey,
                   TRIM(v.tipo)                         AS grupoVeiculo,
                   SUM(l.totalHours)                    AS horas,
                   COUNT(DISTINCT l.vehicleId)          AS veiculos,
                   DATE_FORMAT(MAX(l.date), '%Y-%m-%d') AS ultimo
              FROM daily_work_logs l
              JOIN vehicles v ON v.id = l.vehicleId
              JOIN obras o ON o.id = l.obraId
             WHERE l.obraId IN (${ph})
               AND l.totalHours > 0
               AND l.planoItemKey IS NOT NULL AND TRIM(l.planoItemKey) <> ''
             GROUP BY l.obraId, o.nome, itemKey, grupoVeiculo
        `, obraIds),
        safeQuery(`SELECT nome FROM vehicle_types`),
    ]);
    if (!linhas.length) return [];

    let taxonomia = new Map();
    try {
        taxonomia = await carregarTaxonomia(db);
    } catch (e) {
        console.warn('[dashboard] taxonomia falhou, indicador de outro grupo vazio:', e.code || e.message);
        return [];
    }
    const nomesGrupo = new Set(grupos.map(g => (g.nome || '').trim()));

    const gruposDoItem = (key) => {
        const set = new Set(taxonomia.get(key) || []);
        if (nomesGrupo.has(key)) set.add(key);
        return set;
    };

    const limiteEmCurso = _fmtDate(addDays(today, -DIAS_OUTRO_GRUPO_EM_CURSO));
    const porObra = new Map();
    for (const r of linhas) {
        const grupos = gruposDoItem(r.itemKey);
        if (grupos.size === 0 || !r.grupoVeiculo || grupos.has(r.grupoVeiculo)) continue;

        const key = String(r.obraId);
        if (!porObra.has(key)) porObra.set(key, { obraId: r.obraId, obraNome: r.obraNome, horas: 0, pares: [], ultimo: null });
        const entry = porObra.get(key);
        const horas = parseFloat(r.horas) || 0;
        entry.horas += horas;
        entry.pares.push({ grupoVeiculo: r.grupoVeiculo, itemKey: r.itemKey, horas, veiculos: parseInt(r.veiculos, 10) || 0 });
        if (!entry.ultimo || r.ultimo > entry.ultimo) entry.ultimo = r.ultimo;
    }

    return [...porObra.values()]
        .sort((a, b) => b.horas - a.horas)
        .map(o => {
            const pares = o.pares.sort((a, b) => b.horas - a.horas);
            const p = pares[0];
            const veic = `${p.veiculos > 1 ? `${p.veiculos}× ` : ''}${p.grupoVeiculo}`;
            const mais = pares.length > 1 ? ` · +${pares.length - 1}` : '';
            return {
                obraId: o.obraId,
                obraNome: o.obraNome,
                valor: Math.round(o.horas),
                rotulo: `${fmtNum1(Math.round(o.horas))} h`,
                apoio: `${veic} → ${p.itemKey}${mais}`,
                pares: pares.map(x => ({ ...x, horas: Math.round(x.horas * 10) / 10 })),
                ultimoLancamento: o.ultimo,
                critico: o.ultimo >= limiteEmCurso,
            };
        });
};

exports.getObrasFoco = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(12, 0, 0, 0);

        // Uma query resolve ritmo e duração: horas, dias de apontamento,
        // veículos distintos e data do primeiro lançamento por obra.
        const producao = await safeQuery(`
            SELECT l.obraId,
                   o.nome                                  AS obraNome,
                   SUM(l.totalHours)                       AS horas,
                   COUNT(DISTINCT DATE(l.date))            AS diasLancamento,
                   COUNT(DISTINCT l.vehicleId)             AS veiculos,
                   DATEDIFF(CURDATE(), MIN(l.date))        AS diasProducao,
                   DATE_FORMAT(MIN(l.date), '%Y-%m-%d')    AS inicio,
                   DATE_FORMAT(MAX(l.date), '%Y-%m-%d')    AS ultimo
              FROM daily_work_logs l
              JOIN obras o ON o.id = l.obraId
             WHERE l.totalHours > 0
             GROUP BY l.obraId, o.nome
            HAVING MAX(l.date) >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        `, [DIAS_OBRA_ATIVA]);

        const obraIds = producao.map(p => p.obraId).filter(Boolean);
        const projecoes = await computeProjecoesLeves(obraIds);

        const obras = producao.map(p => {
            const horas = parseFloat(p.horas) || 0;
            const diasLanc = parseInt(p.diasLancamento, 10) || 0;
            const veiculos = parseInt(p.veiculos, 10) || 0;
            // Ritmo por VEÍCULO: h/dia da obra inteira só diz que ela é grande.
            const hDiaVeiculo = (diasLanc > 0 && veiculos > 0) ? horas / diasLanc / veiculos : 0;
            const proj = projecoes.get(String(p.obraId)) || {};
            return {
                obraId: p.obraId,
                obraNome: p.obraNome,
                horas: Math.round(horas),
                veiculos,
                hDiaVeiculo: Math.round(hDiaVeiculo * 10) / 10,
                diasProducao: parseInt(p.diasProducao, 10) || 0,
                inicio: p.inicio,
                ultimoLancamento: p.ultimo,
                dieselProjetado: proj.projecaoFinalPercent ?? null,
                dieselAtual: proj.percentCombust ?? null,
                percentConcluido: proj.percentConcluido ?? null,
                // O % de diesel é medido CONTRA a receita. Se boa parte das
                // horas da obra caiu em item sem preço, o denominador é
                // ficção e o percentual explode (já vimos 22.604%). Nesse
                // caso a obra simplesmente não entra no indicador: melhor
                // ausente do que com número inventado no telão.
                receitaConfiavel: proj.faturamento > 0
                    && (proj.totalHoras > 0 ? (proj.horasSemPreco || 0) / proj.totalHoras : 1) <= 0.2,
            };
        });

        // --- Indicador 1: diesel acima do teto do contrato -------------------
        // A projeção extrapola o gasto atual para o contrato inteiro
        // (percentCombust / percentConcluido). Com a obra no começo o
        // denominador é minúsculo e o resultado vira absurdo — Constantina
        // apareceu com 1.993% estando 3% concluída. Abaixo de 10% de obra
        // executada mostramos o gasto MEDIDO, que é fato, e não a extrapolação.
        const PROGRESSO_MINIMO_PARA_PROJETAR = 10;
        const diesel = obras
            .filter(o => o.receitaConfiavel && o.dieselAtual != null)
            .map(o => {
                const projetavel = (o.percentConcluido ?? 0) >= PROGRESSO_MINIMO_PARA_PROJETAR;
                const valor = projetavel ? o.dieselProjetado : o.dieselAtual;
                return {
                    obraId: o.obraId,
                    obraNome: o.obraNome,
                    valor,
                    rotulo: `${Math.round(valor)}%`,
                    apoio: projetavel
                        ? `hoje ${Math.round(o.dieselAtual)}% · obra ${Math.round(o.percentConcluido)}%`
                        : `medido · obra ${Math.round(o.percentConcluido ?? 0)}%`,
                    projetado: projetavel,
                    dieselAtual: o.dieselAtual,
                    percentConcluido: o.percentConcluido,
                    critico: valor > FUEL_LIMIT_PCT * 1.5,
                };
            })
            .filter(o => o.valor > FUEL_LIMIT_PCT)
            .sort((a, b) => b.valor - a.valor);

        // --- Indicador 2: ritmo baixo por veículo ----------------------------
        const ritmo = obras
            .filter(o => o.veiculos > 0 && o.hDiaVeiculo < RITMO_BAIXO_H_DIA_VEICULO)
            .sort((a, b) => a.hDiaVeiculo - b.hDiaVeiculo)
            .map(o => ({
                obraId: o.obraId,
                obraNome: o.obraNome,
                valor: o.hDiaVeiculo,
                rotulo: `${fmtNum1(o.hDiaVeiculo)} h/dia`,
                apoio: `${o.veiculos} veículo${o.veiculos > 1 ? 's' : ''}`,
                veiculos: o.veiculos,
                horas: o.horas,
                percentConcluido: o.percentConcluido,
                critico: o.hDiaVeiculo < RITMO_CRITICO_H_DIA_VEICULO,
            }));

        // --- Indicador 3: tempo em produção ----------------------------------
        const duracao = obras
            .filter(o => o.diasProducao > DIAS_PRODUCAO_LONGA)
            .sort((a, b) => b.diasProducao - a.diasProducao)
            .map(o => ({
                obraId: o.obraId,
                obraNome: o.obraNome,
                valor: o.diasProducao,
                rotulo: `${o.diasProducao} dias`,
                apoio: `desde ${o.inicio.split('-').reverse().join('/')}`,
                inicio: o.inicio,
                percentConcluido: o.percentConcluido,
                critico: o.diasProducao > DIAS_PRODUCAO_CRITICA,
            }));

        // --- Indicador 4: máquina consumindo item de outro grupo -------------
        // Caçamba apontando no item "Escavadeira 23T", rolo no item de caçamba.
        // Porte diferente do MESMO grupo (35T no item 23T) é substituição
        // normal e não entra. O grupo do item sai da taxonomia (subgrupo N:N) ou
        // da própria chave quando o plano é por grupo; item que não se resolve
        // em grupo nenhum fica de fora — sem grupo conhecido não há "outro".
        const outroGrupo = await obrasComItemDeOutroGrupo(obraIds, today);

        res.json({
            generatedAt: today.toISOString(),
            obrasEmProducao: obras.length,
            indicadores: [
                {
                    id: 'diesel',
                    titulo: 'Diesel acima do limite',
                    criterio: `acima de ${FUEL_LIMIT_PCT}% da receita`,
                    escala: { limite: FUEL_LIMIT_PCT, critico: FUEL_LIMIT_PCT * 1.5, sentido: 'acima' },
                    total: diesel.length,
                    criticos: diesel.filter(x => x.critico).length,
                    obras: diesel,
                },
                {
                    id: 'ritmo',
                    titulo: 'Ritmo baixo',
                    criterio: `menos de ${fmtNum1(RITMO_BAIXO_H_DIA_VEICULO)} h/dia por veículo`,
                    escala: { limite: RITMO_BAIXO_H_DIA_VEICULO, critico: RITMO_CRITICO_H_DIA_VEICULO, referencia: RITMO_MEDIANA_H_DIA_VEICULO, sentido: 'abaixo' },
                    total: ritmo.length,
                    criticos: ritmo.filter(x => x.critico).length,
                    obras: ritmo,
                },
                {
                    id: 'duracao',
                    titulo: 'Tempo em produção',
                    criterio: `mais de ${DIAS_PRODUCAO_LONGA} dias apontando`,
                    escala: { limite: DIAS_PRODUCAO_LONGA, critico: DIAS_PRODUCAO_CRITICA, referencia: DIAS_PRODUCAO_MEDIANA, sentido: 'acima' },
                    total: duracao.length,
                    criticos: duracao.filter(x => x.critico).length,
                    obras: duracao,
                },
                {
                    id: 'outro_grupo',
                    titulo: 'Item de outro grupo',
                    criterio: 'máquina abatendo horas de item de outro grupo',
                    escala: { emCursoDias: DIAS_OUTRO_GRUPO_EM_CURSO },
                    total: outroGrupo.length,
                    criticos: outroGrupo.filter(x => x.critico).length,
                    obras: outroGrupo,
                },
            ],
        });
    } catch (error) {
        console.error('❌ Erro em /dashboard/obras-foco:', error);
        res.status(500).json({ error: error.message });
    }
};
