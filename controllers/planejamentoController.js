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

const PANORAMA = {
    HORAS_POR_DIA: 8,          // igual ao Aproveitamento Produtivo
    PRAZO_ALVO_DIAS: 45,       // régua de negócio: toda obra fecha em 45 dias
    PCT_TERMINANDO: 70,
    DIAS_TERMINANDO: 15,
};

// Grupos que não são máquina de produção — mesma lista do Aproveitamento Produtivo.
const TIPOS_EXCLUIDOS_PRODUTIVOS = [
    'Leve', 'Passeio', 'Utilitario', 'Moto', 'Administrativo', 'Carro',
    'Automóvel', 'Camionete', 'Semirreboques', 'Caminhão Carroceria', 'Caminhão Prancha',
];

// Status de obra que entram no panorama. 'radar' fica fora: não tem plano de
// trabalho, logo não tem horas nem máquinas para dimensionar.
const STATUS_COM_PLANO = ['planejada', 'mobilizacao', 'ativa'];

const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const hoje = () => fmtYmd(new Date());
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
        const [obras] = await db.query(`
            SELECT id, nome, status, regiao, orgao_contratante, contractType,
                   dataInicioPrevisto, dataFimPrevisto, origemInfo, confiancaInfo,
                   horasContratadasPorTipo, horasContratadasPorSubTipo
            FROM obras
            WHERE (tipo_registro IS NULL OR tipo_registro = 'obra')
              AND status IN ('radar', 'planejada', 'mobilizacao', 'ativa')
        `);

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
        const [contratosRaw] = await db.query(
            `SELECT * FROM terceiro_contratos WHERE status = 'ativo'`
        );
        const contratos = await anexarVigente(db, contratosRaw);

        const maquinasDoContrato = (c) => {
            let m = c.maquinas;
            if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = []; } }
            return Array.isArray(m) ? m.filter(Boolean) : [];
        };

        // Horas já executadas por contrato: máquina do contrato E obra do contrato,
        // dentro da vigência, ignorando dias com justificativa — mesma regra do
        // frontend (utils/terceirizados.js), para os dois números baterem.
        const idsContratados = [...new Set(contratos.flatMap(maquinasDoContrato))];
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

            const ids = new Set(maquinasDoContrato(c).map(String));

            const ini = c.vigenciaInicio ? String(c.vigenciaInicio).slice(0, 10) : null;
            const fim = (vig.vigenciaFim || c.vigenciaFim) ? String(vig.vigenciaFim || c.vigenciaFim).slice(0, 10) : null;
            logsTerceiros.forEach(l => {
                if (!ids.has(String(l.vehicleId))) return;
                if (c.obraId && String(l.obraId) !== String(c.obraId)) return;
                if (l.justificativaTipo) return;
                const d = String(l.date).slice(0, 10);
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
            liberando: 0, obras: [], substituicoes: [],
        });

        let horasContratadasTotal = 0, horasExecutadasTotal = 0;
        let obrasComPlano = 0, obrasSemPlano = 0, planosNivelGrupo = 0;
        const radar = [];
        const emExecucao = { ativa: 0, aguardando: 0 };

        obras.forEach(o => {
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const temSub = planoSub && Object.keys(planoSub).length > 0;
            const plano = temSub ? planoSub : (planoTipo || {});
            const temPlano = Object.keys(plano).length > 0;

            if (o.status === 'radar') {
                if (incluirRadar) radar.push({
                    id: o.id, nome: o.nome, regiao: o.regiao,
                    orgao_contratante: o.orgao_contratante,
                    confiancaInfo: o.confiancaInfo, origemInfo: o.origemInfo,
                });
                return;
            }
            if (!STATUS_COM_PLANO.includes(o.status)) return;

            if (!temPlano) { obrasSemPlano += 1; return; }
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
                if (restantes <= 0) return;

                // ceil POR OBRA — máquina é indivisível
                const exige = Math.ceil(restantes / horasPorMaquina);
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
        const idsEmContrato = new Set(contratos.flatMap(maquinasDoContrato).map(String));

        // A máquina conta como oferta do ITEM que ela está desempenhando, não da sua
        // própria classe. Uma 11T alocada no item 23T atende a demanda de 23T — contá-la
        // na linha de 11T deixaria o gap de 23T inflado e o de 11T negativo ao mesmo
        // tempo. Sem item declarado (legado), vale a classe da máquina.
        const chaveOferta = (v) => chave(v.itemAlocado || v.subgrupo, v.grupo);

        frota.forEach(v => {
            const l = linha(chaveOferta(v));
            const ehTerceira = Number(v.terceira) === 1 || idsEmContrato.has(String(v.id));
            if (ehTerceira) { l.terceiros += 1; }
            else if (emManutencao(v.status)) { l.oficina += 1; }
            else if (Number(v.alocada) === 1) { l.operando += 1; }
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
        obras.forEach(o => {
            if (o.status !== 'ativa') return;
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const plano = (planoSub && Object.keys(planoSub).length > 0) ? planoSub : (planoTipo || {});
            const contratadas = Object.values(plano).reduce((a, h) => a + n(h), 0);
            const executadas = Object.values(consumoPorObra[o.id] || {}).reduce((a, h) => a + n(h), 0);
            const pct = contratadas > 0 ? (executadas / contratadas) * 100 : null;
            const fimPrev = o.dataFimPrevisto ? String(o.dataFimPrevisto).slice(0, 10) : null;
            if ((pct != null && pct >= p.PCT_TERMINANDO) || (fimPrev && fimPrev <= limite)) {
                obrasTerminando.add(String(o.id));
            }
        });
        frota.forEach(v => {
            if (Number(v.terceira) === 1 || Number(v.alocada) !== 1) return;
            if (!obrasTerminando.has(String(v.obraAlocadaId))) return;
            linha(chaveOferta(v)).liberando += 1;
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
                    granularidade: grupoDoSubtipo.has(l.subgrupo) ? 'subgrupo' : 'grupo',
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
            .filter(l => l.precisamos > 0 || l.operando > 0 || l.oficina > 0 || l.disponiveis > 0 || l.terceiros > 0)
            .sort((a, b) => b.gap - a.gap || b.horasRestantes - a.horasRestantes);

        // Total do gap = SOMA DAS FALTAS, nunca o líquido: sobra de caçamba não
        // cobre falta de escavadeira.
        const totalGap = subgrupos.reduce((a, l) => a + l.gap, 0);
        const soma = (campo) => subgrupos.reduce((a, l) => a + l[campo], 0);

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
                gapHoras: Math.round(totalGap * horasPorMaquina),
            },
            terceiros: {
                contratos: contratos.length,
                contratosFechado: tercContratosFechado,
                maquinas: soma('terceiros'),
                horasContratadas: Math.round(tercHorasContratadas),
                horasExecutadas: Math.round(tercHorasExecutadas),
                horasAEntregar: Math.round(Math.max(tercHorasContratadas - tercHorasExecutadas, 0)),
            },
            subgrupos,
            radar,
        });
    } catch (error) {
        console.error('❌ Erro no panorama de capacidade:', error);
        res.status(500).json({ error: 'Erro ao montar o panorama de capacidade.', details: error.message });
    }
};

module.exports = { getPlanejamento, getPanorama, dimensionar, DEFAULTS, PANORAMA };
