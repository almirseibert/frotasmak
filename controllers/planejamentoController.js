const db = require('../database');

// ===================================================================================
// MÓDULO DE PLANEJAMENTO ESTRATÉGICO DE OBRAS
// Regras de negócio (ver PLANO_MODULO_PLANEJAMENTO_OBRAS.md na raiz do workspace):
//  - Capacidade: 175 h/mês por máquina (≈ 5,83 h/dia)
//  - Meta: concluir obras em ≤ 45 dias
//  - Escalonamento: preferir N-1 máquinas até o dia 35 + reforço, quando fecha no prazo
//  - "Terminando": ≥ 70% horas consumidas OU fim previsto/projetado ≤ 15 dias
// ===================================================================================

const DEFAULTS = {
    HORAS_MES_MAQUINA: 175,
    PRAZO_ALVO_DIAS: 45,
    DIA_REFORCO: 35,
    PCT_TERMINANDO: 70,
    DIAS_TERMINANDO: 15,
    JANELA_BALANCO_DIAS: 60,
};

const PRE_ACTIVE = ['radar', 'planejada', 'mobilizacao'];

const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

// Dimensionamento por subgrupo: dado H horas contratadas, quantas máquinas e em
// que regime (constante ou escalonado) para fechar em ≤ PRAZO_ALVO_DIAS.
const dimensionar = (horas, p) => {
    const horasDia = p.HORAS_MES_MAQUINA / 30;
    const capPrazo = horasDia * p.PRAZO_ALVO_DIAS;        // 1 máquina no prazo todo
    const capAteReforco = horasDia * p.DIA_REFORCO;       // 1 máquina até o dia de reforço

    if (!horas || horas <= 0) return null;

    const nMin = Math.ceil(horas / capPrazo);             // mínimo constante que fecha no prazo

    // Testa escalonado com nMin-1 máquinas até DIA_REFORCO, depois nMin
    if (nMin > 1) {
        const entregueAteReforco = (nMin - 1) * capAteReforco;
        const restante = horas - entregueAteReforco;
        if (restante > 0) {
            const diasExtra = restante / (nMin * horasDia);
            const diasTotal = p.DIA_REFORCO + diasExtra;
            if (diasTotal <= p.PRAZO_ALVO_DIAS) {
                return {
                    regime: 'escalonado',
                    maquinasIniciais: nMin - 1,
                    maquinasPico: nMin,
                    diaReforco: p.DIA_REFORCO,
                    diasEstimados: Math.ceil(diasTotal),
                };
            }
        }
    }

    const diasConstante = horas / (nMin * horasDia);
    return {
        regime: 'constante',
        maquinasIniciais: nMin,
        maquinasPico: nMin,
        diaReforco: null,
        diasEstimados: Math.ceil(diasConstante),
        // Termina em menos de metade do prazo → candidata a ceder máquina no meio
        folga: diasConstante < p.PRAZO_ALVO_DIAS / 2,
    };
};

// GET /api/obras/planejamento
// Retorna todas as obras com métricas de planejamento + balanço demanda×oferta por subgrupo.
const getPlanejamento = async (req, res) => {
    try {
        const p = { ...DEFAULTS };
        if (req.query.janelaDias) p.JANELA_BALANCO_DIAS = parseInt(req.query.janelaDias, 10) || DEFAULTS.JANELA_BALANCO_DIAS;

        const [obras] = await db.query(`
            SELECT id, nome, status, tipo_registro, regiao, orgao_contratante, responsavel,
                   contractType, dataInicio, dataFim, dataInicioPrevisto, dataFimPrevisto,
                   origemInfo, confiancaInfo, obsPlanejamento,
                   horasContratadasPorTipo, horasContratadasPorSubTipo
            FROM obras
            WHERE (tipo_registro IS NULL OR tipo_registro = 'obra')
              AND (status != 'finalizada' OR dataFim >= DATE_SUB(NOW(), INTERVAL 30 DAY))
        `);

        // Horas consumidas por obra × item do plano.
        // `planoItemKey` vem da alocação (o item que a máquina foi desempenhar) e tem
        // precedência: é assim que a hora de uma 11T mandada para um serviço de 23T
        // conta no item 23T em vez de sumir. NULL = legado, classifica pelo subgrupo
        // do veículo (fallback: grupo). Ver docs/item-de-contrato-e-substituicao-plano.md.
        const [consumo] = await db.query(`
            SELECT l.obraId,
                   COALESCE(NULLIF(l.planoItemKey, ''), NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo,
                   SUM(l.totalHours) AS horas,
                   SUM(CASE WHEN l.date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY) THEN l.totalHours ELSE 0 END) AS horas14d
            FROM daily_work_logs l
            JOIN vehicles v ON v.id = l.vehicleId
            GROUP BY l.obraId, subgrupo
        `);

        // Máquinas atualmente alocadas por obra
        const [alocacoes] = await db.query(`
            SELECT h.obraId, h.veiculoId, h.registroInterno, h.placa, h.modelo, h.dataEntrada,
                   h.employeeName, v.operationalAssignment,
                   COALESCE(NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo
            FROM obras_historico_veiculos h
            JOIN vehicles v ON v.id = h.veiculoId
            WHERE h.dataSaida IS NULL
        `);

        // Execução por máquina (horas apontadas e último apontamento na obra)
        const [execVeiculos] = await db.query(`
            SELECT obraId, vehicleId, SUM(totalHours) AS horas, MAX(date) AS ultimoApontamento
            FROM daily_work_logs
            GROUP BY obraId, vehicleId
        `);

        // Frota disponível — linha a linha para permitir drill-down no frontend
        const [disponiveis] = await db.query(`
            SELECT id, registroInterno, placa, modelo,
                   COALESCE(NULLIF(sub_tipo, ''), tipo) AS subgrupo
            FROM vehicles
            WHERE status = 'Disponível'
        `);

        const consumoPorObra = {};
        consumo.forEach(r => {
            (consumoPorObra[r.obraId] = consumoPorObra[r.obraId] || []).push(r);
        });
        const execPorObraVeiculo = {};
        execVeiculos.forEach(r => { execPorObraVeiculo[`${r.obraId}|${r.vehicleId}`] = r; });

        const alocPorObra = {};
        alocacoes.forEach(r => {
            const exec = execPorObraVeiculo[`${r.obraId}|${r.veiculoId}`];
            const nextMission = parseJson(r.operationalAssignment)?.next_mission || {};
            (alocPorObra[r.obraId] = alocPorObra[r.obraId] || []).push({
                obraId: r.obraId,
                veiculoId: r.veiculoId,
                registroInterno: r.registroInterno,
                placa: r.placa,
                modelo: r.modelo,
                dataEntrada: r.dataEntrada,
                subgrupo: r.subgrupo,
                employeeName: r.employeeName || null,
                horasApontadas: exec ? (parseFloat(exec.horas) || 0) : 0,
                ultimoApontamento: exec ? exec.ultimoApontamento : null,
                previsaoLiberacao: nextMission.release_date || null,
                liberacaoManual: !!nextMission.release_date,
            });
        });

        const hoje = new Date();
        const emDias = (d) => d ? Math.round((new Date(d) - hoje) / 86400000) : null;

        const result = obras.map(o => {
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const plano = (planoSub && Object.keys(planoSub).length > 0) ? planoSub : (planoTipo || {});
            const planoNivelGrupo = !(planoSub && Object.keys(planoSub).length > 0) && !!planoTipo && Object.keys(planoTipo).length > 0;

            const totalContratado = Object.values(plano).reduce((s, h) => s + (parseFloat(h) || 0), 0);

            const linhasConsumo = consumoPorObra[o.id] || [];
            const consumidoPorSubgrupo = {};
            let totalConsumido = 0, horas14d = 0;
            linhasConsumo.forEach(r => {
                consumidoPorSubgrupo[r.subgrupo] = parseFloat(r.horas) || 0;
                totalConsumido += parseFloat(r.horas) || 0;
                horas14d += parseFloat(r.horas14d) || 0;
            });

            const pctConsumido = totalContratado > 0 ? (totalConsumido / totalContratado) * 100 : null;

            // Projeção de término pelo ritmo dos últimos 14 dias
            const ritmoDia = horas14d / 14;
            const horasRestantes = Math.max(totalContratado - totalConsumido, 0);
            const diasProjetados = (o.status === 'ativa' && ritmoDia > 0 && totalContratado > 0)
                ? Math.ceil(horasRestantes / ritmoDia)
                : null;

            // Perfil de demanda (obras pré-ativas): dimensionamento por subgrupo
            let perfilDemanda = null;
            if (PRE_ACTIVE.includes(o.status)) {
                perfilDemanda = Object.entries(plano)
                    .map(([subgrupo, horas]) => {
                        const dim = dimensionar(parseFloat(horas) || 0, p);
                        return dim ? { subgrupo, horasContratadas: parseFloat(horas), ...dim } : null;
                    })
                    .filter(Boolean);
            }

            // Cobertura dinâmica (obras ativas): quantas máquinas o restante do contrato
            // ainda exige, redimensionando as horas que faltam por subgrupo.
            let necessidadeAtual = null;
            if (o.status === 'ativa' && o.contractType === 'horas' && totalContratado > 0) {
                necessidadeAtual = Object.entries(plano).map(([subgrupo, horas]) => {
                    const restante = Math.max((parseFloat(horas) || 0) - (consumidoPorSubgrupo[subgrupo] || 0), 0);
                    const dim = dimensionar(restante, p);
                    return {
                        subgrupo,
                        horasRestantes: Math.round(restante * 10) / 10,
                        maquinasNecessarias: dim ? dim.maquinasPico : 0,
                        diasEstimados: dim ? dim.diasEstimados : 0,
                        regime: dim ? dim.regime : 'concluido',
                    };
                });
            }

            // Critério "Terminando" (apenas ativas)
            const diasParaFimPrevisto = emDias(o.dataFimPrevisto);
            const terminando = o.status === 'ativa' && (
                (pctConsumido != null && pctConsumido >= p.PCT_TERMINANDO) ||
                (diasParaFimPrevisto != null && diasParaFimPrevisto <= p.DIAS_TERMINANDO) ||
                (diasProjetados != null && diasProjetados <= p.DIAS_TERMINANDO)
            );

            // Faixa de evolução física (colunas computadas do Kanban)
            let faixa = null;
            if (o.status === 'ativa' && pctConsumido != null) {
                faixa = pctConsumido < 30 ? '0-30' : pctConsumido < 70 ? '30-70' : '70-100';
            }

            return {
                id: o.id, nome: o.nome, status: o.status, regiao: o.regiao,
                orgao_contratante: o.orgao_contratante, responsavel: o.responsavel,
                contractType: o.contractType,
                dataInicio: o.dataInicio, dataFim: o.dataFim,
                dataInicioPrevisto: o.dataInicioPrevisto, dataFimPrevisto: o.dataFimPrevisto,
                origemInfo: o.origemInfo, confiancaInfo: o.confiancaInfo, obsPlanejamento: o.obsPlanejamento,
                plano, planoNivelGrupo, totalContratado,
                consumidoPorSubgrupo, totalConsumido,
                pctConsumido: pctConsumido != null ? Math.round(pctConsumido * 10) / 10 : null,
                ritmoDia: Math.round(ritmoDia * 10) / 10,
                diasProjetados, terminando, faixa,
                maquinasAlocadas: alocPorObra[o.id] || [],
                perfilDemanda, necessidadeAtual,
            };
        });

        // ── Balanço demanda × oferta por subgrupo (janela) ──
        const janela = p.JANELA_BALANCO_DIAS;
        const balanco = {};
        const entry = (sg) => (balanco[sg] = balanco[sg] || {
            subgrupo: sg, demanda: 0, liberando: 0, disponiveis: 0,
            demandaObras: [], liberandoVeiculos: [], disponiveisVeiculos: [],
        });

        result.forEach(o => {
            // Demanda: obras pré-ativas que começam dentro da janela (sem data prevista = incluída)
            if (PRE_ACTIVE.includes(o.status) && o.perfilDemanda) {
                const dias = emDias(o.dataInicioPrevisto);
                if (dias == null || dias <= janela) {
                    // Mobilização já tem máquinas no canteiro — abate da demanda para não contar dobrado
                    const jaAlocadas = {};
                    (o.maquinasAlocadas || []).forEach(m => { jaAlocadas[m.subgrupo] = (jaAlocadas[m.subgrupo] || 0) + 1; });
                    o.perfilDemanda.forEach(d => {
                        const falta = Math.max(d.maquinasPico - (jaAlocadas[d.subgrupo] || 0), 0);
                        if (falta === 0) return;
                        const e = entry(d.subgrupo);
                        e.demanda += falta;
                        e.demandaObras.push({ obraNome: o.nome, maquinas: falta, inicioPrevisto: o.dataInicioPrevisto });
                    });
                }
            }
            // Oferta: máquinas em obras "terminando" — guardamos onde cada uma está hoje
            if (o.terminando) {
                o.maquinasAlocadas.forEach(m => {
                    const e = entry(m.subgrupo);
                    e.liberando += 1;
                    e.liberandoVeiculos.push({
                        veiculoId: m.veiculoId, registroInterno: m.registroInterno,
                        placa: m.placa, modelo: m.modelo, obraNome: o.nome, regiao: o.regiao,
                    });
                });
            }
        });
        disponiveis.forEach(v => {
            const e = entry(v.subgrupo);
            e.disponiveis += 1;
            e.disponiveisVeiculos.push({ veiculoId: v.id, registroInterno: v.registroInterno, placa: v.placa, modelo: v.modelo });
        });

        const balancoArr = Object.values(balanco)
            .map(b => ({ ...b, saldo: b.liberando + b.disponiveis - b.demanda }))
            .filter(b => b.demanda > 0 || b.liberando > 0)
            .sort((a, b) => a.saldo - b.saldo);

        res.json({ params: p, obras: result, balanco: balancoArr });
    } catch (error) {
        console.error('Erro no planejamento de obras:', error);
        res.status(500).json({ error: 'Erro ao montar planejamento.', details: error.message });
    }
};

// ===================================================================================
// PANORAMA DE CAPACIDADE — GET /api/obras/planejamento/panorama
//
// Responde as quatro perguntas da direção (ver docs/panorama-capacidade-plano.md):
//   1. quantas horas totais temos para executar
//   2. essas horas por categoria (plano de trabalho = subgrupo)
//   3. quantas conseguimos produzir e quantas precisam ser terceirizadas
//   4. quantas horas já foram alocadas a terceiros
//
// É uma FOTOGRAFIA: não há calendário nem projeção. Toda obra em carteira demanda
// suas máquinas ao mesmo tempo — o encaixe entre fim de uma e início de outra é
// decidido fora do sistema (premissa declarada na tela).
//
// Capacidade: 8 h por dia útil por máquina — a MESMA métrica do Aproveitamento
// Produtivo (obraSupervisorController.HORAS_POR_DIA), não os 175 h/mês usados pelo
// dimensionar() do Kanban. Duas telas com capacidades diferentes destruiriam a
// confiança da direção no número.
//
// Máquina é indivisível: o arredondamento é ceil POR OBRA × subgrupo e só depois
// se soma. Somar as horas de várias obras e dividir no fim transformaria três obras
// de 10 h restantes em "1 escavadeira" quando são 3.
// ===================================================================================

const { loadHolidaySet, isBusinessDay, fmtYmd, parseYmd } = require('../utils/businessDays');
const { anexarVigente } = require('../utils/contratoAditivos');
const { calcularCustoContratos, STATUS_ENCERRADOS, maquinasDoContrato,
        veiculoElegivel, usaListaLegada } = require('../utils/terceirosCusto');

const PANORAMA = {
    HORAS_POR_DIA: 8,          // igual ao Aproveitamento Produtivo
    PRAZO_ALVO_DIAS: 45,       // régua de negócio: toda obra fecha em 45 dias
    PCT_TERMINANDO: 70,
    DIAS_TERMINANDO: 15,
    JANELAS_PRODUCAO: [15, 30, 90],   // "quem produziu" — recortes do realizado
};

// Grupos que não são máquina de produção — mesma lista do Aproveitamento Produtivo.
const { TIPOS_EXCLUIDOS_PRODUTIVOS } = require('../utils/tiposProdutivos');

// Status de obra que entram no panorama. 'radar' fica fora: não tem plano de
// trabalho, logo não tem horas nem máquinas para dimensionar.
const STATUS_COM_PLANO = ['planejada', 'mobilizacao', 'ativa'];

const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const hoje = () => fmtYmd(new Date());

// Data de coluna MySQL -> 'YYYY-MM-DD'. O driver devolve DATE/TIMESTAMP como objeto
// Date, e `String(date).slice(0,10)` vira "Wed Mar 11" — que compara lexicograficamente
// contra 'YYYY-MM-DD' de forma sempre errada, silenciosamente. Toda comparação de
// data neste controller passa por aqui.
const ymdCol = (v) => {
    if (!v) return null;
    if (v instanceof Date) return fmtYmd(v);
    return String(v).slice(0, 10);
};
const somaDias = (ymd, dias) => {
    const d = parseYmd(ymd);
    d.setDate(d.getDate() + dias);
    return fmtYmd(d);
};

// Dias úteis entre duas datas (inclusive). businessDaysBetween não é exportado
// pelo utils, então contamos aqui com o mesmo isBusinessDay (fins de semana + feriados).
const contarDiasUteis = (iniYmd, fimYmd, holidaySet) => {
    let cur = iniYmd, total = 0, guard = 0;
    while (cur <= fimYmd && guard++ < 400) {
        if (isBusinessDay(cur, holidaySet)) total += 1;
        cur = somaDias(cur, 1);
    }
    return total;
};

const getPanorama = async (req, res) => {
    try {
        const p = { ...PANORAMA };
        const incluirRadar = req.query.incluirRadar !== '0';

        // Capacidade de UMA máquina dentro da régua de 45 dias, em horas.
        const holidaySet = await loadHolidaySet(db).catch(() => new Set());
        const inicioJanela = hoje();
        const fimJanela = somaDias(inicioJanela, p.PRAZO_ALVO_DIAS);
        const diasUteisPrazo = contarDiasUteis(inicioJanela, fimJanela, holidaySet) || 32;
        const horasPorMaquina = p.HORAS_POR_DIA * diasUteisPrazo;

        // ── Obras ────────────────────────────────────────────────────────────
        // A query das obras é o CORAÇÃO da tela: se ela falha, não há panorama. Por
        // isso ela toca só colunas garantidas. Valor de contrato vive em duas fontes
        // OPCIONAIS — a tabela obra_contracts pode não existir e obras.valorTotalContrato
        // pode não existir (ver utils/regrasAbastecimento.js, que probe essa coluna
        // justamente por isso) — então cada uma é buscada à parte, com catch. Sem
        // valor a tela perde as cifras; com a query quebrada ela perde tudo.
        const [obras] = await db.query(`
            SELECT id, nome, status, regiao, orgao_contratante, contractType,
                   dataInicioPrevisto, dataFimPrevisto, origemInfo, confiancaInfo,
                   horasContratadasPorTipo, horasContratadasPorSubTipo
            FROM obras
            WHERE (tipo_registro IS NULL OR tipo_registro = 'obra')
              AND status IN ('radar', 'planejada', 'mobilizacao', 'ativa')
        `);

        const contratoDaObra = {};
        try {
            const [rows] = await db.query(
                'SELECT obra_id, total_value, total_hours_contracted, is_hidden FROM obra_contracts');
            rows.forEach(r => { contratoDaObra[r.obra_id] = r; });
        } catch (e) {
            console.warn('⚠️ Panorama: obra_contracts indisponível —', e.code || e.message);
        }

        const valorLegadoDaObra = {};
        try {
            const [rows] = await db.query('SELECT id, valorTotalContrato FROM obras');
            rows.forEach(r => { valorLegadoDaObra[r.id] = r.valorTotalContrato; });
        } catch (e) {
            console.warn('⚠️ Panorama: obras.valorTotalContrato indisponível —', e.code || e.message);
        }

        // Horas apontadas por obra × item do plano. O `planoItemKey` da alocação tem
        // precedência sobre a classe da máquina — ver comentário em getPlanejamento.
        const [consumo] = await db.query(`
            SELECT l.obraId,
                   COALESCE(NULLIF(l.planoItemKey, ''), NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo,
                   SUM(l.totalHours) AS horas
            FROM daily_work_logs l
            JOIN vehicles v ON v.id = l.vehicleId
            GROUP BY l.obraId, subgrupo
        `);
        const consumoPorObra = {};
        consumo.forEach(r => {
            (consumoPorObra[r.obraId] = consumoPorObra[r.obraId] || {})[r.subgrupo] = n(r.horas);
        });

        // Horas apontadas por obra separando frota própria de terceira — base do
        // "quanto desta obra é terceirizado". É o histórico INTEIRO da obra, não a
        // janela de 45 dias: a pergunta é sobre a obra, não sobre o mês.
        let consumoPorOrigem = [];
        try {
            const [rows] = await db.query(`
                SELECT l.obraId,
                       (v.isOutsourced = 1 OR v.locadorId IS NOT NULL) AS terceira,
                       SUM(l.totalHours) AS horas
                FROM daily_work_logs l
                JOIN vehicles v ON v.id = l.vehicleId
                WHERE l.justificativaTipo IS NULL
                GROUP BY l.obraId, terceira
            `);
            consumoPorOrigem = rows;
        } catch (e) {
            console.warn('⚠️ Panorama: consumo por origem indisponivel —', e.code || e.message);
        }
        const origemPorObra = {};
        consumoPorOrigem.forEach(r => {
            const o = (origemPorObra[r.obraId] = origemPorObra[r.obraId] || { propria: 0, terceira: 0 });
            if (Number(r.terceira) === 1) o.terceira += n(r.horas); else o.propria += n(r.horas);
        });

        // ── Produção realizada: quem de fato trabalhou ───────────────────────
        // Toda a tela acima é foto do que FALTA fazer. Este bloco é a única coisa
        // olhando para trás, e é o que mostra se a dependência de terceiros está
        // subindo. Mesmo universo de máquinas do resto da tela (sem leves, sem
        // sucata) para os percentuais serem comparáveis.
        const janelaMaxima = Math.max(...p.JANELAS_PRODUCAO);
        let logsRecentes = [];
        let producaoOk = true;
        try {
        const [rowsRecentes] = await db.query(`
            SELECT l.vehicleId, l.date, l.totalHours,
                   (v.isOutsourced = 1 OR v.locadorId IS NOT NULL) AS terceira
            FROM daily_work_logs l
            JOIN vehicles v ON v.id = l.vehicleId
            WHERE l.justificativaTipo IS NULL
              AND l.date >= ?
              AND v.tipo NOT IN (${TIPOS_EXCLUIDOS_PRODUTIVOS.map(() => '?').join(',')})
              AND v.status <> 'Sucata'
        `, [somaDias(inicioJanela, -(janelaMaxima + 95)), ...TIPOS_EXCLUIDOS_PRODUTIVOS]);
            logsRecentes = rowsRecentes;
        } catch (e) {
            producaoOk = false;
            console.warn('⚠️ Panorama: producao recente indisponivel —', e.code || e.message);
        }

        const producao = {};
        p.JANELAS_PRODUCAO.forEach(dias => {
            const corte = somaDias(inicioJanela, -dias);
            const acc = { propria: 0, terceira: 0 };
            const frotas = { propria: new Set(), terceira: new Set() };
            logsRecentes.forEach(l => {
                if ((ymdCol(l.date) || '') < corte) return;
                const lado = Number(l.terceira) === 1 ? 'terceira' : 'propria';
                acc[lado] += n(l.totalHours);
                frotas[lado].add(String(l.vehicleId));
            });
            const total = acc.propria + acc.terceira;
            producao[dias] = {
                horasProprias: Math.round(acc.propria),
                horasTerceiras: Math.round(acc.terceira),
                frotasProprias: frotas.propria.size,
                frotasTerceiras: frotas.terceira.size,
                pctTerceiros: total > 0 ? Math.round((acc.terceira / total) * 1000) / 10 : 0,
            };
        });

        // Tendência: participação de terceiros nos 3 meses fechados mais recentes
        // (mês corrente incluído, ainda que parcial — a tela diz qual é o mês).
        const porMes = {};
        logsRecentes.forEach(l => {
            const mes = (ymdCol(l.date) || '').slice(0, 7);
            const m = (porMes[mes] = porMes[mes] || { propria: 0, terceira: 0 });
            m[Number(l.terceira) === 1 ? 'terceira' : 'propria'] += n(l.totalHours);
        });
        const tendencia = Object.keys(porMes).sort().slice(-3).map(mes => {
            const m = porMes[mes];
            const t = m.propria + m.terceira;
            return { mes, pctTerceiros: t > 0 ? Math.round((m.terceira / t) * 1000) / 10 : 0 };
        });

        // ── Frota: própria × terceira, por subgrupo e estado ─────────────────
        // Terceira = isOutsourced OU locadorId preenchido (o campo novo convive
        // com o antigo; contrato de locação grava locadorId).
        const [frotaRaw] = await db.query(`
            SELECT v.id, v.registroInterno, v.placa, v.modelo, v.status,
                   v.tipo AS grupo, NULLIF(v.sub_tipo, '') AS subTipo,
                   COALESCE(NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo,
                   (v.isOutsourced = 1 OR v.locadorId IS NOT NULL) AS terceira,
                   (h.obraId IS NOT NULL) AS alocada,
                   h.obraId AS obraAlocadaId,
                   NULLIF(h.planoItemKey, '') AS itemAlocado
            FROM vehicles v
            LEFT JOIN obras_historico_veiculos h
                   ON h.veiculoId = v.id AND h.dataSaida IS NULL
            WHERE v.tipo NOT IN (${TIPOS_EXCLUIDOS_PRODUTIVOS.map(() => '?').join(',')})
              AND (v.ativo IS NULL OR v.ativo != 0)
              AND v.status <> 'Sucata'
        `, TIPOS_EXCLUIDOS_PRODUTIVOS);

        // Um veículo com mais de um histórico em aberto (dado sujo) viria duplicado
        // pelo LEFT JOIN e seria contado duas vezes em "operando". Uma linha por id.
        const frota = [...new Map(frotaRaw.map(v => [String(v.id), v])).values()];

        const emManutencao = (st) =>
            ['Em Manutenção', 'Aguardando Manutenção', 'Em Manutencao'].includes(st);

        // ── Granularidade: subgrupo quando o cadastro permite, senão grupo ───
        // Hoje quase toda máquina PRÓPRIA está sem `sub_tipo` (só o equipamento
        // locado costuma ter), enquanto os planos de trabalho são escritos em
        // subgrupo. Sem tratamento, a demanda de "Escavadeira Hidráulica 23T" não
        // encontraria nenhuma máquina própria — ela está cadastrada como
        // "Escavadeira" — e o gap apareceria dobrado, em duas linhas da mesma frota.
        //
        // Regra: um GRUPO só é exibido em nível de subgrupo quando TODA a frota
        // própria daquele grupo tem `sub_tipo` preenchido. Enquanto houver uma
        // máquina sem, o grupo inteiro (demanda e oferta) é agregado no grupo.
        // Nada de meio-termo: granularidade parcial distribuiria a frota errado.
        // A tela se corrige sozinha conforme o cadastro for completado — sem
        // mexer em código.
        const [taxonomia] = await db.query(`
            SELECT s.nome AS sub, t.nome AS grupo
            FROM vehicle_sub_types s
            JOIN vehicle_type_sub_types v ON v.sub_type_id = s.id
            JOIN vehicle_types t ON t.id = v.type_id
        `);
        // Um subgrupo vale para VÁRIOS grupos (migração "subgrupo N:N"):
        // "Caçamba Basculante 12m³" serve Truckado, Traçado, Toco e Bitruck.
        const gruposDoSubtipo = new Map();
        taxonomia.forEach(r => {
            if (!gruposDoSubtipo.has(r.sub)) gruposDoSubtipo.set(r.sub, new Set());
            gruposDoSubtipo.get(r.sub).add(r.grupo);
        });

        const gruposIncompletos = new Set();
        const veiculosPorGrupo = new Map();
        frota.forEach(v => {
            const ehTerceiraCad = Number(v.terceira) === 1;
            veiculosPorGrupo.set(v.grupo, (veiculosPorGrupo.get(v.grupo) || 0) + 1);
            if (ehTerceiraCad) return;         // o cadastro que interessa é o da frota própria
            if (!v.subTipo) gruposIncompletos.add(v.grupo);
        });

        // Resolve qualquer chave (de plano ou de veículo) para a granularidade vigente.
        //
        // `grupoHint` é o grupo do veículo, quando a chave vem de um veículo: com o
        // subgrupo valendo para vários grupos, só o próprio veículo sabe em qual
        // deles ele está. Para chave de plano não há hint — aí o colapso só acontece
        // se TODOS os grupos daquele subgrupo estiverem com cadastro incompleto, e o
        // balde é o grupo com mais máquinas (é onde a frota efetivamente está).
        const chave = (k, grupoHint) => {
            if (!k) return k;
            const grupos = gruposDoSubtipo.get(k);
            if (!grupos) return k;             // já é grupo, ou chave livre digitada no plano

            if (grupoHint && grupos.has(grupoHint)) {
                return gruposIncompletos.has(grupoHint) ? grupoHint : k;
            }
            const lista = [...grupos];
            if (!lista.every(g => gruposIncompletos.has(g))) return k;
            return lista.sort((a, b) =>
                (veiculosPorGrupo.get(b) || 0) - (veiculosPorGrupo.get(a) || 0)
                || a.localeCompare(b, 'pt-BR'))[0];
        };

        // ── Contratos de terceiros vigentes ──────────────────────────────────
        // Vigência por EXCLUSÃO dos estados terminais, não por `status = 'ativo'`.
        //
        // `assinado` é uma PROMOÇÃO de `ativo` (terceiroContratoController: o upload
        // do contrato assinado congela a minuta e promove o status). Filtrar por
        // 'ativo' descartava justamente os contratos mais firmes — 6 deles, R$ 734 mil
        // em valor e R$ 526 mil em saldo — e o Panorama mostrava um total menor que a
        // página Terceirizados, que lista todos os contratos.
        const [contratosRaw] = await db.query(
            `SELECT * FROM terceiro_contratos
              WHERE status NOT IN (${STATUS_ENCERRADOS.map(() => '?').join(',')})`,
            STATUS_ENCERRADOS
        );
        const contratos = await anexarVigente(db, contratosRaw);

        // Horas já executadas por contrato: o apontamento pertence ao contrato pela
        // OBRA e pela DATA dele, com o veículo elegível (terceiro + subgrupo) — mesma
        // regra do frontend (utils/terceirizados.js), para os dois números baterem.
        // A máquina não está mais escrita no contrato, então o universo de busca é o
        // conjunto de veículos dos terceiros que têm contrato.
        const locadoresComContrato = [...new Set(contratos.map(c => c.locadorId).filter(Boolean))];
        const veicTerceiros = new Map();
        if (locadoresComContrato.length > 0) {
            const [vrows] = await db.query(`
                SELECT id, locadorId, isOutsourced, tipo, sub_tipo
                FROM vehicles
                WHERE isOutsourced = 1 AND locadorId IN (${locadoresComContrato.map(() => '?').join(',')})
            `, locadoresComContrato);
            vrows.forEach(v => veicTerceiros.set(String(v.id), v));
        }
        const idsLegadoPlan = [...new Set(contratos.filter(usaListaLegada).flatMap(maquinasDoContrato).map(String))];
        const idsContratados = [...new Set([...veicTerceiros.keys(), ...idsLegadoPlan])];
        let logsTerceiros = [];
        if (idsContratados.length > 0) {
            [logsTerceiros] = await db.query(`
                SELECT vehicleId, obraId, date, totalHours, justificativaTipo
                FROM daily_work_logs
                WHERE vehicleId IN (${idsContratados.map(() => '?').join(',')})
            `, idsContratados);
        }

        let tercHorasContratadas = 0, tercHorasExecutadas = 0, tercContratosFechado = 0;

        contratos.forEach(c => {
            const vig = c.vigente || {};
            const fechado = c.contractType === 'fechado';
            if (fechado) tercContratosFechado += 1;
            else tercHorasContratadas += n(vig.horasContratadas);

            const legado = usaListaLegada(c) ? new Set(maquinasDoContrato(c).map(String)) : null;
            const pertence = (vehicleId) => (legado
                ? legado.has(String(vehicleId))
                : veiculoElegivel(veicTerceiros.get(String(vehicleId)), c));

            const ini = ymdCol(c.vigenciaInicio);
            const fim = ymdCol(vig.vigenciaFim || c.vigenciaFim);
            logsTerceiros.forEach(l => {
                if (!l.obraId || String(l.obraId) !== String(c.obraId)) return;
                if (!pertence(l.vehicleId)) return;
                if (l.justificativaTipo) return;
                const d = ymdCol(l.date);
                if (!d) return;
                if (ini && d < ini) return;
                if (fim && d > fim) return;
                tercHorasExecutadas += n(l.totalHours);
            });
        });

        // ── Demanda por subgrupo ─────────────────────────────────────────────
        const sg = {};
        const linha = (k) => (sg[k] = sg[k] || {
            subgrupo: k,
            horasRestantes: 0, precisamos: 0,
            operando: 0, oficina: 0, disponiveis: 0, terceiros: 0,
            terceirasSemVinculo: 0,
            terceirosEmContrato: 0, terceirosSoObra: 0,
            liberando: 0, obras: [], substituicoes: [],
        });

        let horasContratadasTotal = 0, horasExecutadasTotal = 0;
        let obrasComPlano = 0, obrasSemPlano = 0, planosNivelGrupo = 0;
        const radar = [];
        const emExecucao = { ativa: 0, aguardando: 0 };

        // ── Tarifa da obra: R$ por hora ──────────────────────────────────────
        // Valor e horas são AMBOS fixos em contrato, então a razão entre eles é um
        // preço contratado, não projeção. É o que permite converter hora em dinheiro
        // no resto da tela sem inventar número.
        //
        // Obra sem valor ou sem horas cadastradas fica com tarifa null e sai das
        // somas de R$ (as horas dela continuam contando). O rodapé informa quantas
        // são — um valor de carteira calculado sobre metade das obras, sem avisar,
        // seria pior que não mostrar valor nenhum.
        const somaPlano = (obra) => {
            const sub = parseJson(obra.horasContratadasPorSubTipo);
            const tipo = parseJson(obra.horasContratadasPorTipo);
            const plano = (sub && Object.keys(sub).length > 0) ? sub : (tipo || {});
            return Object.values(plano).reduce((a, h) => a + n(h), 0);
        };
        // Contrato oculto (is_hidden) fica FORA das somas de R$ — mesma convenção do
        // faturamento — mas a obra continua no panorama: ela consome máquina de
        // qualquer jeito, e é a máquina que a direção precisa enxergar aqui.
        const tarifaPorObra = {};
        obras.forEach(o => {
            const c = contratoDaObra[o.id] || {};
            if (Number(c.is_hidden) === 1) { tarifaPorObra[o.id] = null; return; }
            const valor = n(c.total_value) || n(valorLegadoDaObra[o.id]);
            const horas = n(c.total_hours_contracted) || somaPlano(o);
            tarifaPorObra[o.id] = (valor > 0 && horas > 0) ? valor / horas : null;
        });
        const horasRestantesPorObra = {};
        // Máquinas exigidas somadas POR OBRA. O ceil acontece por obra×subgrupo lá
        // embaixo; aqui só reagrupamos o mesmo número pela obra, para o detalhamento
        // poder dizer "esta obra precisaria de N".
        const exigePorObra = {};
        // Contratadas e executadas POR OBRA, para o "% concluido" do detalhamento.
        // As executadas entram limitadas as contratadas do mesmo subgrupo (mesmo
        // Math.min do consolidado): sem isso, uma obra que estourou a hora de um
        // item passaria de 100% e a barra de progresso viraria mentira.
        const contratadasPorObra = {};
        const executadasPorObra = {};

        // ── Recorte por status de obra ───────────────────────────────────────
        // Os mesmos números da tela, quebrados pelo estágio do ciclo de vida
        // (planejada → mobilizacao → ativa). É o que separa "dinheiro rodando" de
        // "dinheiro que ainda vai exigir máquina": uma obra em mobilização já
        // compromete equipamento sem ter apontado hora nenhuma.
        // `radar` entra só como contagem — não tem plano, logo não tem hora nem R$.
        const ORDEM_STATUS = ['radar', 'planejada', 'mobilizacao', 'ativa'];
        const porStatus = {};
        const statusBucket = (s) => (porStatus[s] = porStatus[s] || {
            status: s, obras: 0, semPlano: 0,
            horasContratadas: 0, horasExecutadas: 0, horasRestantes: 0,
            exigeMaquinas: 0, operando: 0, terceirosMaquinas: 0,
            terceirosHoras: 0, propriasHoras: 0,
            valorCarteira: 0, valorAExecutar: 0, obrasSemTarifa: 0,
            detalhe: [],
        });

        obras.forEach(o => {
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const temSub = planoSub && Object.keys(planoSub).length > 0;
            const plano = temSub ? planoSub : (planoTipo || {});
            const temPlano = Object.keys(plano).length > 0;

            if (o.status === 'radar') {
                if (incluirRadar) { const b = statusBucket('radar'); b.obras += 1; b.semPlano += 1; }
                if (incluirRadar) radar.push({
                    id: o.id, nome: o.nome, regiao: o.regiao,
                    orgao_contratante: o.orgao_contratante,
                    confiancaInfo: o.confiancaInfo, origemInfo: o.origemInfo,
                });
                return;
            }
            if (!STATUS_COM_PLANO.includes(o.status)) return;

            const bucket = statusBucket(o.status);
            bucket.obras += 1;
            // Horas já apontadas nesta obra, separando frota própria de terceira. Vem
            // do histórico inteiro (origemPorObra), coerente com "% terceirizado".
            const origem = origemPorObra[o.id] || { propria: 0, terceira: 0 };
            bucket.propriasHoras += origem.propria;
            bucket.terceirosHoras += origem.terceira;

            if (!temPlano) { obrasSemPlano += 1; bucket.semPlano += 1; return; }
            obrasComPlano += 1;
            if (!temSub) planosNivelGrupo += 1;
            if (o.status === 'ativa') emExecucao.ativa += 1; else emExecucao.aguardando += 1;

            // Resolve as chaves ANTES de dimensionar: dois subgrupos que colapsam no
            // mesmo grupo viram uma linha só. Fazer o ceil antes do colapso somaria
            // duas máquinas onde uma resolve (10 h + 10 h = 1 máquina, não 2).
            const acumular = (origem) => {
                const out = {};
                Object.entries(origem || {}).forEach(([k, h]) => {
                    const c = chave(k);
                    out[c] = (out[c] || 0) + n(h);
                });
                return out;
            };
            const planoR = acumular(plano);
            const consumido = acumular(consumoPorObra[o.id]);

            Object.entries(planoR).forEach(([subgrupo, horas]) => {
                const contratadas = n(horas);
                const executadas = n(consumido[subgrupo]);
                const restantes = Math.max(contratadas - executadas, 0);
                horasContratadasTotal += contratadas;
                horasExecutadasTotal += Math.min(executadas, contratadas);
                bucket.horasContratadas += contratadas;
                bucket.horasExecutadas += Math.min(executadas, contratadas);
                bucket.horasRestantes += restantes;
                contratadasPorObra[o.id] = (contratadasPorObra[o.id] || 0) + contratadas;
                executadasPorObra[o.id] = (executadasPorObra[o.id] || 0) + Math.min(executadas, contratadas);
                if (restantes <= 0) return;

                // ceil POR OBRA — máquina é indivisível
                const exige = Math.ceil(restantes / horasPorMaquina);
                bucket.exigeMaquinas += exige;
                exigePorObra[o.id] = (exigePorObra[o.id] || 0) + exige;
                horasRestantesPorObra[o.id] = (horasRestantesPorObra[o.id] || 0) + restantes;
                const l = linha(subgrupo);
                l.horasRestantes += restantes;
                l.precisamos += exige;
                l.obras.push({
                    obraId: o.id, obraNome: o.nome, status: o.status,
                    regiao: o.regiao, orgao_contratante: o.orgao_contratante,
                    horasRestantes: Math.round(restantes * 10) / 10,
                    exige,
                });
            });
        });

        // ── Oferta por subgrupo ──────────────────────────────────────────────
        // Uma máquina é de terceiro se está marcada como tal no cadastro OU se está
        // vinculada a um contrato ativo. Contar só pelo contrato faria sumir da oferta
        // o equipamento locado cujo contrato ainda não foi cadastrado.
        // Com a derivação, todo veículo de terceiro em contrato já é `isOutsourced`
        // no cadastro; a lista digitada sobrevive só em contrato encerrado. O conjunto
        // continua aqui para não perder o legado na contagem de oferta.
        const idsEmContrato = new Set(idsLegadoPlan);

        // A máquina conta como oferta do ITEM que ela está desempenhando, não da sua
        // própria classe. Uma 11T alocada no item 23T atende a demanda de 23T — contá-la
        // na linha de 11T deixaria o gap de 23T inflado e o de 11T negativo ao mesmo
        // tempo. Sem item declarado (legado), vale a classe da máquina.
        const chaveOferta = (v) => chave(v.itemAlocado || v.subgrupo, v.grupo);

        frota.forEach(v => {
            const l = linha(chaveOferta(v));
            const ehTerceira = Number(v.terceira) === 1 || idsEmContrato.has(String(v.id));
            const emContrato = idsEmContrato.has(String(v.id));
            const alocada = Number(v.alocada) === 1;

            if (ehTerceira) {
                // Máquina de terceiro só é COBERTURA se estiver contratada agora ou
                // trabalhando numa obra. O cadastro de terceiros acumula todo
                // equipamento que um dia foi locado: contar esse acervo inteiro como
                // oferta inflava a cobertura e escondia o gap — a tela dizia que a
                // demanda estava atendida por máquina que não está contratada nem em
                // obra. As demais ficam num balde à parte, informativo.
                if (emContrato) { l.terceiros += 1; l.terceirosEmContrato += 1; }
                else if (alocada) {
                    // Terceira trabalhando numa obra sem contrato ativo cadastrado.
                    // Ela CONTA como cobertura (está produzindo), mas fica marcada:
                    // é hora de terceiro sem respaldo contratual no sistema, e é
                    // justamente a que não aparece em nenhuma soma de R$.
                    l.terceiros += 1; l.terceirosSoObra += 1;
                }
                else l.terceirasSemVinculo += 1;
            }
            else if (emManutencao(v.status)) { l.oficina += 1; }
            else if (alocada) { l.operando += 1; }
            else { l.disponiveis += 1; }

            // Substituição: máquina desempenhando item de outro porte. Fica registrada
            // para o drill-down — a direção precisa saber que aquele item está sendo
            // atendido por equipamento diferente do contratado.
            if (v.itemAlocado && chave(v.itemAlocado, v.grupo) !== chave(v.subgrupo, v.grupo)) {
                l.substituicoes.push({
                    veiculoId: v.id,
                    registroInterno: v.registroInterno,
                    placa: v.placa,
                    modelo: v.modelo,
                    subgrupoDaMaquina: v.subgrupo,
                    obraId: v.obraAlocadaId,
                    terceira: Number(v.terceira) === 1,
                });
            }
        });

        // ── "Prestes a finalizar": máquinas próprias em obra terminando ──────
        // Mesmo critério do Kanban: ≥70% das horas consumidas OU fim previsto ≤15 dias.
        const limite = somaDias(hoje(), p.DIAS_TERMINANDO);
        const obrasTerminando = new Set();
        const infoTerminando = {};   // obraId → { nome, pct, fimPrevisto }
        obras.forEach(o => {
            if (o.status !== 'ativa') return;
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const plano = (planoSub && Object.keys(planoSub).length > 0) ? planoSub : (planoTipo || {});
            const contratadas = Object.values(plano).reduce((a, h) => a + n(h), 0);
            const executadas = Object.values(consumoPorObra[o.id] || {}).reduce((a, h) => a + n(h), 0);
            const pct = contratadas > 0 ? (executadas / contratadas) * 100 : null;
            const fimPrev = ymdCol(o.dataFimPrevisto);
            if ((pct != null && pct >= p.PCT_TERMINANDO) || (fimPrev && fimPrev <= limite)) {
                obrasTerminando.add(String(o.id));
                infoTerminando[String(o.id)] = {
                    nome: o.nome,
                    pct: pct != null ? Math.round(pct) : null,
                    fimPrevisto: fimPrev,
                };
            }
        });

        // Lista NOMINAL do que libera. O número agregado não serve para agir: para
        // realocar uma máquina a direção precisa saber qual é, de onde sai e quando.
        const liberando = [];
        frota.forEach(v => {
            if (Number(v.terceira) === 1 || Number(v.alocada) !== 1) return;
            if (!obrasTerminando.has(String(v.obraAlocadaId))) return;
            const k = chaveOferta(v);
            linha(k).liberando += 1;
            const info = infoTerminando[String(v.obraAlocadaId)] || {};
            liberando.push({
                veiculoId: v.id,
                identificacao: v.registroInterno || v.placa || v.modelo,
                modelo: v.modelo,
                subgrupo: k,
                obraId: v.obraAlocadaId,
                obraNome: info.nome || '—',
                pctExecutado: info.pct ?? null,
                fimPrevisto: info.fimPrevisto || null,
            });
        });

        // ── Fechamento por subgrupo ──────────────────────────────────────────
        const subgrupos = Object.values(sg)
            .map(l => {
                const cobertura = l.operando + l.disponiveis + l.terceiros;
                const gap = Math.max(l.precisamos - cobertura, 0);
                const sobra = Math.max(cobertura - l.precisamos, 0);
                return {
                    ...l,
                    // 'grupo' avisa a tela que aquela linha está agregada porque o
                    // cadastro de veiculos daquele grupo ainda nao tem sub_tipo.
                    granularidade: gruposDoSubtipo.has(l.subgrupo) ? 'subgrupo' : 'grupo',
                    // Plano pede horas de uma chave que nao existe em NENHUMA maquina
                    // (propria, oficina ou terceira). Ou a empresa nao tem esse
                    // equipamento, ou o plano foi escrito com um nome que a taxonomia
                    // de veiculos nao conhece. A tela marca a linha em vez de exibir
                    // o numero como se fosse um gap normal.
                    semFrotaCorrespondente: l.precisamos > 0
                        && (l.operando + l.oficina + l.disponiveis + l.terceiros) === 0,
                    horasRestantes: Math.round(l.horasRestantes * 10) / 10,
                    gap,
                    gapComOficina: Math.max(gap - l.oficina, 0),
                    gapSeRealocar: Math.max(gap - l.liberando, 0),
                    gapHoras: Math.round(gap * horasPorMaquina),
                    sobra,
                    obras: l.obras.sort((a, b) => b.horasRestantes - a.horasRestantes),
                    // Quantas das maquinas desta linha sao de outro porte que o item pede.
                    atendidoPorOutroPorte: l.substituicoes.length,
                };
            })
            .filter(l => l.precisamos > 0 || l.operando > 0 || l.oficina > 0 || l.disponiveis > 0
                      || l.terceiros > 0 || l.terceirasSemVinculo > 0)
            .sort((a, b) => b.gap - a.gap || b.horasRestantes - a.horasRestantes);

        // Total do gap = SOMA DAS FALTAS, nunca o líquido: sobra de caçamba não
        // cobre falta de escavadeira.
        const totalGap = subgrupos.reduce((a, l) => a + l.gap, 0);
        const soma = (campo) => subgrupos.reduce((a, l) => a + l[campo], 0);
        const gapHorasTotal = Math.round(totalGap * horasPorMaquina);

        // ── Dinheiro ─────────────────────────────────────────────────────────
        // Tudo aqui é aritmética sobre dois números fixos em contrato (valor e
        // horas). Nada é projetado. A única aproximação declarada é a TARIFA MÉDIA
        // da carteira, usada para precificar o gap: o gap é por equipamento e o
        // valor é por obra, então não existe R$ por subgrupo — por isso o valor da
        // falta aparece só consolidado, nunca por linha de equipamento.
        let valorAExecutar = 0, horasComTarifa = 0, valorCarteira = 0;
        let obrasComTarifa = 0, obrasSemTarifa = 0;
        obras.forEach(o => {
            if (!STATUS_COM_PLANO.includes(o.status)) return;
            const restante = horasRestantesPorObra[o.id];
            if (restante == null) return;               // sem plano ou já concluída
            const tarifa = tarifaPorObra[o.id];
            const bucket = statusBucket(o.status);
            if (!tarifa) { obrasSemTarifa += 1; bucket.obrasSemTarifa += 1; return; }
            obrasComTarifa += 1;
            valorAExecutar += restante * tarifa;
            horasComTarifa += restante;
            valorCarteira += somaPlano(o) * tarifa;
            bucket.valorAExecutar += restante * tarifa;
            bucket.valorCarteira += somaPlano(o) * tarifa;
        });

        // Máquinas efetivamente operando em cada estágio. Usa a alocação aberta
        // (obras_historico_veiculos), a mesma fonte do `operando` por subgrupo — por
        // isso uma obra em mobilização pode já aparecer com máquina no canteiro.
        const statusDaObra = Object.fromEntries(obras.map(o => [String(o.id), o.status]));
        frota.forEach(v => {
            if (Number(v.alocada) !== 1) return;
            const s = statusDaObra[String(v.obraAlocadaId)];
            if (!s || (s === 'radar' && !incluirRadar)) return;
            const b = statusBucket(s);
            // MESMA classificação do bloco de oferta acima: máquina de terceiro não
            // entra em `operando`, vai para o balde de terceiros. Contá-la nos dois
            // faria a soma por status estourar o total da tela (273 contra 181).
            if (Number(v.terceira) === 1 || idsEmContrato.has(String(v.id))) b.terceirosMaquinas += 1;
            else if (!emManutencao(v.status)) b.operando += 1;
        });

        // ── Detalhamento por obra (o que abre ao clicar no estágio) ──────────
        // Cada estágio responde uma pergunta DIFERENTE, então o payload leva um
        // objeto por obra com todos os campos e o frontend escolhe as colunas:
        //   planejada    → o que vai cair na frota (ordena por início previsto)
        //   mobilizacao  → há quanto tempo há máquina parada sem produzir
        //   ativa        → em quantos dias fecha NO RITMO INSTALADO
        //
        // O `diasNoRitmo` é a peça central. "Faltam 510 máquinas" é um número que
        // ninguém pode executar — ninguém compra 510 máquinas. O mesmo fato dito em
        // TEMPO ("esta obra leva 1109 dias com as 2 máquinas que tem") vira decisão:
        // remanejar, contratar pontual ou renegociar prazo com o cliente.
        //
        // Ressalva honesta: horasRestantes depende do apontamento, que nem sempre é
        // preenchido — o número absoluto tem margem para MAIS. A contagem de máquinas
        // vem da alocação, que é confiável, então o RANKING entre obras é sólido.
        const primeiraEntradaPorObra = {};
        try {
            const [rows] = await db.query(`
                SELECT obraId, MIN(dataEntrada) AS primeira
                FROM obras_historico_veiculos
                WHERE dataSaida IS NULL
                GROUP BY obraId
            `);
            rows.forEach(r => { primeiraEntradaPorObra[r.obraId] = ymdCol(r.primeira); });
        } catch (e) {
            console.warn('⚠️ Panorama: primeira entrada no canteiro indisponivel —', e.code || e.message);
        }

        // Máquinas HOJE em cada obra, separando própria de terceira. Mesma regra de
        // classificação do resto da tela.
        const maqPorObra = {};
        frota.forEach(v => {
            if (Number(v.alocada) !== 1 || !v.obraAlocadaId) return;
            const m = (maqPorObra[v.obraAlocadaId] = maqPorObra[v.obraAlocadaId]
                || { propria: 0, terceira: 0 });
            if (Number(v.terceira) === 1 || idsEmContrato.has(String(v.id))) m.terceira += 1;
            else if (!emManutencao(v.status)) m.propria += 1;
        });

        const diffDias = (ymd) => {
            if (!ymd) return null;
            return Math.round((parseYmd(inicioJanela) - parseYmd(ymd)) / 86400000);
        };

        obras.forEach(o => {
            if (!STATUS_COM_PLANO.includes(o.status)) return;
            const b = porStatus[o.status];
            if (!b) return;
            const restante = horasRestantesPorObra[o.id];
            const maq = maqPorObra[o.id] || { propria: 0, terceira: 0 };
            const noCanteiro = maq.propria + maq.terceira;
            const tarifa = tarifaPorObra[o.id];
            const primeira = primeiraEntradaPorObra[o.id];

            // Dias ÚTEIS para zerar as horas restantes com as máquinas instaladas.
            // Sem máquina o resultado é infinito: mandamos null e a tela diz "sem
            // máquina no canteiro", que é a informação real — não um número enorme.
            const diasNoRitmo = (restante > 0 && noCanteiro > 0)
                ? Math.ceil(restante / (noCanteiro * p.HORAS_POR_DIA))
                : null;

            b.detalhe.push({
                obraId: o.id,
                nome: o.nome,
                regiao: o.regiao,
                orgao_contratante: o.orgao_contratante,
                horasRestantes: Math.round(restante || 0),
                horasContratadas: Math.round(contratadasPorObra[o.id] || 0),
                horasExecutadas: Math.round(executadasPorObra[o.id] || 0),
                // Quanto da obra ja saiu. Responde "falta muito?", que e diferente
                // de "exige quantas maquinas?": uma obra em 90% com prazo estourado
                // e uma conversa; a mesma obra em 5% e outra completamente.
                pctConcluido: contratadasPorObra[o.id] > 0
                    ? Math.round((executadasPorObra[o.id] / contratadasPorObra[o.id]) * 1000) / 10
                    : null,
                valorAExecutar: tarifa ? Math.round((restante || 0) * tarifa) : null,
                exige: exigePorObra[o.id] || 0,
                maquinasProprias: maq.propria,
                maquinasTerceiras: maq.terceira,
                noCanteiro,
                dataInicioPrevisto: ymdCol(o.dataInicioPrevisto),
                dataFimPrevisto: ymdCol(o.dataFimPrevisto),
                diasNoCanteiro: diffDias(primeira),
                diasNoRitmo,
                // Passa do alvo de 45 dias corridos (≈ diasUteisPrazo dias úteis).
                foraDoPrazo: diasNoRitmo != null && diasNoRitmo > diasUteisPrazo,
                semPlano: !(o.id in horasRestantesPorObra) && !exigePorObra[o.id],
            });
        });

        // Ordenação por estágio: cada um tem um eixo próprio de urgência.
        if (porStatus.planejada) {
            porStatus.planejada.detalhe.sort((a, b) =>
                String(a.dataInicioPrevisto || '9999').localeCompare(String(b.dataInicioPrevisto || '9999'))
                || b.exige - a.exige);
        }
        if (porStatus.mobilizacao) {
            porStatus.mobilizacao.detalhe.sort((a, b) =>
                (b.diasNoCanteiro ?? -1) - (a.diasNoCanteiro ?? -1));
        }
        if (porStatus.ativa) {
            // Sem máquina primeiro (anomalia), depois os piores prazos.
            porStatus.ativa.detalhe.sort((a, b) =>
                (a.noCanteiro === 0 ? 0 : 1) - (b.noCanteiro === 0 ? 0 : 1)
                || (b.diasNoRitmo ?? 0) - (a.diasNoRitmo ?? 0));
        }

        const statusResumo = ORDEM_STATUS
            .filter(s => porStatus[s])
            .map(s => {
                const b = porStatus[s];
                const apontadas = b.propriasHoras + b.terceirosHoras;
                return {
                    ...b,
                    horasContratadas: Math.round(b.horasContratadas),
                    horasExecutadas: Math.round(b.horasExecutadas),
                    horasRestantes: Math.round(b.horasRestantes),
                    propriasHoras: Math.round(b.propriasHoras),
                    terceirosHoras: Math.round(b.terceirosHoras),
                    pctTerceirizado: apontadas > 0
                        ? Math.round((b.terceirosHoras / apontadas) * 1000) / 10 : null,
                    valorCarteira: Math.round(b.valorCarteira),
                    valorAExecutar: Math.round(b.valorAExecutar),
                    pctExecutado: b.horasContratadas > 0
                        ? Math.round((b.horasExecutadas / b.horasContratadas) * 1000) / 10 : null,
                };
            });
        const tarifaMedia = horasComTarifa > 0 ? valorAExecutar / horasComTarifa : 0;

        // Custo dos contratos de terceiros (valor, diesel abatido, adiantamentos).
        let custos = new Map();
        try {
            custos = await calcularCustoContratos(db, contratos);
        } catch (e) {
            console.warn('⚠️ Panorama: custo de terceiros indisponivel —', e.code || e.message);
        }
        let tercValor = 0, tercDiesel = 0, tercAdiantamentos = 0, tercSaldo = 0;
        custos.forEach(c => {
            tercValor += c.valorTotal;
            tercDiesel += c.diesel;
            tercAdiantamentos += c.adiantamentos;
            tercSaldo += c.saldo;
        });

        // ── Onde terceirizamos ───────────────────────────────────────────────
        // Junta as duas pontas que o sistema já tem e nunca mostrou lado a lado:
        // o R$/h que a obra paga para a empresa e o R$/h que a empresa paga ao
        // terceiro naquela mesma obra.
        const contratosPorObra = {};
        contratos.forEach(c => {
            if (!c.obraId) return;
            (contratosPorObra[c.obraId] = contratosPorObra[c.obraId] || []).push(c);
        });

        const obrasTerceirizadas = obras
            .filter(o => STATUS_COM_PLANO.includes(o.status))
            .map(o => {
                const h = origemPorObra[o.id] || { propria: 0, terceira: 0 };
                const totalH = h.propria + h.terceira;
                const dosContratos = contratosPorObra[o.id] || [];
                if (h.terceira <= 0 && dosContratos.length === 0) return null;

                let saldo = 0, valorTerceiro = 0, horasTerceiro = 0;
                dosContratos.forEach(c => {
                    const k = custos.get(String(c.id));
                    if (!k) return;
                    saldo += k.saldo;
                    valorTerceiro += k.valorTotal;
                    horasTerceiro += k.horasContratadas;
                });
                // Contrato de valor fechado não declara horas: cai para as horas
                // efetivamente apontadas, que é o que se sabe sobre ele.
                const baseHoras = horasTerceiro > 0 ? horasTerceiro : h.terceira;
                const tarifaTerceiro = baseHoras > 0 ? valorTerceiro / baseHoras : null;
                const tarifa = tarifaPorObra[o.id];

                return {
                    obraId: o.id,
                    nome: o.nome,
                    orgao_contratante: o.orgao_contratante,
                    regiao: o.regiao,
                    horasProprias: Math.round(h.propria),
                    horasTerceiras: Math.round(h.terceira),
                    pctTerceirizado: totalH > 0 ? Math.round((h.terceira / totalH) * 1000) / 10 : 0,
                    contratos: dosContratos.length,
                    semContrato: dosContratos.length === 0,
                    saldoAPagar: Math.round(saldo),
                    tarifaObra: tarifa ? Math.round(tarifa * 100) / 100 : null,
                    tarifaTerceiro: tarifaTerceiro ? Math.round(tarifaTerceiro * 100) / 100 : null,
                    margemPct: (tarifa && tarifaTerceiro)
                        ? Math.round(((tarifa - tarifaTerceiro) / tarifa) * 1000) / 10
                        : null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.pctTerceirizado - a.pctTerceirizado || b.saldoAPagar - a.saldoAPagar);

        // Marca na lista de liberação qual máquina cobre uma falta real — é o que
        // separa "vai desocupar" de "vale a pena realocar".
        const comGap = new Set(subgrupos.filter(l => l.gap > 0).map(l => l.subgrupo));
        liberando.forEach(m => { m.atendeGap = comGap.has(m.subgrupo); });
        liberando.sort((a, b) =>
            (b.atendeGap ? 1 : 0) - (a.atendeGap ? 1 : 0)
            || String(a.fimPrevisto || '9999').localeCompare(String(b.fimPrevisto || '9999')));

        res.json({
            params: {
                ...p,
                diasUteisPrazo,
                horasPorMaquina,
                janela: { inicio: inicioJanela, fim: fimJanela },
                apuradoEm: new Date().toISOString(),
            },
            cobertura: {
                obrasAbertas: obrasComPlano + obrasSemPlano,
                obrasComPlano,
                obrasSemPlano,
                pct: (obrasComPlano + obrasSemPlano) > 0
                    ? Math.round((obrasComPlano / (obrasComPlano + obrasSemPlano)) * 1000) / 10
                    : 100,
                planosNivelGrupo,
                gruposAgregadosPorCadastro: [...gruposIncompletos].sort(),
                obrasComTarifa,
                obrasSemTarifa,
            },
            carteira: {
                obras: obrasComPlano,
                emOperacao: emExecucao.ativa,
                aguardandoInicio: emExecucao.aguardando,
                horasContratadas: Math.round(horasContratadasTotal),
                horasExecutadas: Math.round(horasExecutadasTotal),
                horasRestantes: Math.round(horasContratadasTotal - horasExecutadasTotal),
            },
            totais: {
                precisamos: soma('precisamos'),
                operando: soma('operando'),
                oficina: soma('oficina'),
                disponiveis: soma('disponiveis'),
                terceiros: soma('terceiros'),
                liberando: soma('liberando'),
                gap: totalGap,
                gapComOficina: subgrupos.reduce((a, l) => a + l.gapComOficina, 0),
                gapSeRealocar: subgrupos.reduce((a, l) => a + l.gapSeRealocar, 0),
                gapHoras: gapHorasTotal,
            },
            valor: {
                tarifaMedia: Math.round(tarifaMedia * 100) / 100,
                aExecutar: Math.round(valorAExecutar),
                carteira: Math.round(valorCarteira),
                gap: Math.round(gapHorasTotal * tarifaMedia),
                // O que a realocação destrava, em R$, sem contratar nada. Conta só o
                // gap EFETIVAMENTE coberto (gap − gapSeRealocar): máquina que libera
                // num subgrupo sem falta não destrava nada, e contá-la aqui inflaria
                // o ganho de uma decisão que a direção vai tomar de verdade.
                liberando: Math.round(
                    (totalGap - subgrupos.reduce((a, l) => a + l.gapSeRealocar, 0))
                    * horasPorMaquina * tarifaMedia),
                pctTerceiros: valorCarteira > 0
                    ? Math.round((tercValor / valorCarteira) * 1000) / 10
                    : null,
            },
            terceiros: {
                contratos: contratos.length,
                contratosFechado: tercContratosFechado,
                // `maquinas` = o que efetivamente cobre demanda (em contrato ativo ou
                // em obra). `cadastradas` = todo o acervo marcado como terceiro no
                // cadastro de veículos, que é sempre maior e não é oferta.
                maquinas: soma('terceiros'),
                cadastradas: soma('terceiros') + soma('terceirasSemVinculo'),
                semVinculo: soma('terceirasSemVinculo'),
                emContrato: soma('terceirosEmContrato'),
                soObra: soma('terceirosSoObra'),
                horasContratadas: Math.round(tercHorasContratadas),
                horasExecutadas: Math.round(tercHorasExecutadas),
                horasAEntregar: Math.round(Math.max(tercHorasContratadas - tercHorasExecutadas, 0)),
                valorContratado: Math.round(tercValor),
                dieselAbatido: Math.round(tercDiesel),
                adiantamentos: Math.round(tercAdiantamentos),
                saldoAPagar: Math.round(tercSaldo),
            },
            porStatus: statusResumo,
            producao: producaoOk ? { janelas: producao, tendencia } : null,
            obrasTerceirizadas,
            liberando,
            subgrupos,
            radar,
        });
    } catch (error) {
        console.error('❌ Erro no panorama de capacidade:', error);
        res.status(500).json({ error: 'Erro ao montar o panorama de capacidade.', details: error.message });
    }
};

module.exports = { getPlanejamento, getPanorama, dimensionar, DEFAULTS, PANORAMA };
