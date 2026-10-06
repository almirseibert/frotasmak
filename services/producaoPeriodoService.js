// services/producaoPeriodoService.js
//
// Aba "Produção" de Desempenho do negócio: o que foi executado no período,
// por obra e por máquina, separando frota própria de terceiros.
//
// REGRA DO h/dia (decidida com a diretoria): horas ÷ DIAS ÚTEIS ALOCADOS, nunca
// ÷ dias trabalhados. Dividir pelos dias trabalhados faz a máquina que rodou 1
// dia muito bem parecer a mais produtiva, quando ficar parada o resto do mês é
// o cenário ruim.
//   - Alocação = estadias em obras_historico_veiculos recortadas ao período.
//   - Dia útil = seg–sex sem feriado (nacional + regional da obra).
//   - Sábado/domingo não entram no denominador, mas as horas desses dias entram
//     no numerador: é produção extra e melhora a média.
//   - Manutenção durante a alocação conta no denominador (é perda real, vale
//     igual para própria e terceira).
//   - Horas lançadas em dia sem alocação do veículo ficam FORA da média (não há
//     denominador) mas entram no total do período e aparecem como aviso de
//     cadastro em `semAlocacao`.
//
// Comparação por tipo: chave = sub_tipo (subgrupo do contrato) com fallback no
// tipo. O tipo do cadastro é inconsistente (Caçamba Truckado/Traçado/Caçamba são
// o mesmo "Caminhão Caçamba Basculante 12m³"); o subgrupo é o que se compara.
// O h/dia do grupo é agregado (Σ horas ÷ Σ dias), não média de médias.

const db = require('../database');
const { diaCivil } = require('../utils/periodosObra');
const { loadHolidaySet, businessDayList, HOLIDAY_REGIOES } = require('../utils/businessDays');
const { TIPOS_EXCLUIDOS_PRODUTIVOS } = require('../utils/tiposProdutivos');

const r1 = (v) => Math.round(v * 10) / 10;

// A partir de quantos dias úteis alocada sem lançar a máquina é sinalizada
// como "parada alocada" (provável desmobilização sem desalocar).
const DIAS_PARADA_ALOCADA = 5;

const shiftYmd = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ultimoDiaDoMes = (ymd) => {
    const [y, m] = ymd.split('-').map(Number);
    return new Date(y, m, 0).getDate();
};

/**
 * Período anterior para o delta. Se o período começa no dia 1, compara com o
 * mesmo trecho do mês anterior (01–30/09 → 01–31/08; 01–15/10 → 01–15/09).
 * Senão, a janela de mesmo tamanho imediatamente antes.
 */
const periodoAnterior = (start, end) => {
    if (start.endsWith('-01') && end.slice(0, 7) === start.slice(0, 7)) {
        const [y, m] = start.split('-').map(Number);
        const prevStart = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
        const diaEnd = Number(end.slice(8));
        const diaFim = diaEnd === ultimoDiaDoMes(end)
            ? ultimoDiaDoMes(prevStart)
            : Math.min(diaEnd, ultimoDiaDoMes(prevStart));
        return { start: prevStart, end: `${prevStart.slice(0, 8)}${String(diaFim).padStart(2, '0')}` };
    }
    const dias = Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000) + 1;
    return { start: shiftYmd(start, -dias), end: shiftYmd(start, -1) };
};

const rotuloObra = (o) => {
    if (!o) return 'Obra não identificada';
    const orgao = o.orgao_contratante && String(o.orgao_contratante).trim();
    return orgao ? `${o.nome} (${orgao})` : o.nome;
};

const grupoDoVeiculo = (v) => (v.sub_tipo && String(v.sub_tipo).trim()) || v.tipo || 'Sem tipo';

/**
 * Núcleo puro: recebe as linhas já carregadas e monta a resposta.
 *
 * @param {object} p
 * @param {string} p.start, p.end            'YYYY-MM-DD'
 * @param {Array}  p.logs        {vehicleId, obraId, date:'YYYY-MM-DD', totalHours}
 * @param {Array}  p.estadias    {veiculoId, obraId, dataEntrada, dataSaida} (qualquer formato aceito por diaCivil)
 * @param {Map}    p.veiculos    id → {id, registroInterno, placa, marca, modelo, tipo, sub_tipo, isOutsourced, locadora}
 * @param {Map}    p.obras       id → {id, nome, orgao_contratante, regiao}
 * @param {object} p.feriados    { nacional: Set, [regiao]: Set }
 * @param {number} p.horasAnterior
 */
const calcularProducao = ({ start, end, logs, estadias, veiculos, obras, feriados, horasAnterior = 0 }) => {
    const feriadosDa = (obraId) => {
        const regiao = obras.get(String(obraId))?.regiao;
        return (regiao && feriados[regiao]) || feriados.nacional;
    };

    // ── Alocação: por veículo, os dias de calendário e os dias úteis alocados ──
    // Set de datas resolve a troca no mesmo dia (sai da A e entra na B em 04/08
    // conta 1 dia, não 2).
    const aloc = new Map(); // vehicleId → { dias:Set, uteis:Set, obras:Set }
    const alocDe = (vid) => {
        if (!aloc.has(vid)) aloc.set(vid, { dias: new Set(), uteis: new Set(), obras: new Set() });
        return aloc.get(vid);
    };
    for (const e of estadias) {
        const ini = diaCivil(e.dataEntrada);
        if (!ini) continue;
        const fim = diaCivil(e.dataSaida) || end;
        const de = ini > start ? ini : start;
        const ate = fim < end ? fim : end;
        if (de > ate) continue;
        const a = alocDe(String(e.veiculoId));
        a.obras.add(String(e.obraId));
        const fer = feriadosDa(e.obraId);
        for (const d of businessDayList(de, ate, fer)) {
            a.dias.add(d.date);
            if (d.isBusinessDay) a.uteis.add(d.date);
        }
    }

    // ── Horas: por máquina, por obra, e o que caiu fora da alocação ──────────
    const maq = new Map();  // vehicleId → { horas, horasAlocadas, porObra: Map(obraId → horas) }
    const maqDe = (vid) => {
        if (!maq.has(vid)) maq.set(vid, { horas: 0, horasAlocadas: 0, diasComLancamento: new Set(), porObra: new Map() });
        return maq.get(vid);
    };
    const semAloc = new Map(); // `${vid}|${obraId}` → { vehicleId, obraId, horas, dias:Set }

    for (const l of logs) {
        const vid = String(l.vehicleId);
        const oid = l.obraId == null ? null : String(l.obraId);
        const h = Number(l.totalHours) || 0;
        const m = maqDe(vid);
        m.horas += h;
        m.diasComLancamento.add(l.date);
        m.porObra.set(oid, (m.porObra.get(oid) || 0) + h);
        if (aloc.get(vid)?.dias.has(l.date)) {
            m.horasAlocadas += h;
        } else if (h > 0) {
            const k = `${vid}|${oid}`;
            if (!semAloc.has(k)) semAloc.set(k, { vehicleId: vid, obraId: oid, horas: 0, dias: new Set() });
            const s = semAloc.get(k);
            s.horas += h;
            s.dias.add(l.date);
        }
    }

    // Universo de máquinas: quem lançou hora OU esteve alocado (equipamento
    // produtivo). A alocada que não lançou nada é justamente o pior caso e
    // precisa aparecer com 0 h/dia.
    const ids = new Set(maq.keys());
    for (const vid of aloc.keys()) {
        const v = veiculos.get(vid);
        if (v && !TIPOS_EXCLUIDOS_PRODUTIVOS.includes(v.tipo)) ids.add(vid);
    }

    const origemDe = (v) => (v && Number(v.isOutsourced) === 1 ? 'terceiro' : 'proprio');

    // ── Por máquina ──────────────────────────────────────────────────────────
    const porMaquina = [];
    for (const vid of ids) {
        const v = veiculos.get(vid) || { id: vid };
        const m = maq.get(vid) || { horas: 0, horasAlocadas: 0, diasComLancamento: new Set(), porObra: new Map() };
        const a = aloc.get(vid);
        const diasAlocados = a ? a.uteis.size : 0;
        const obrasIds = new Set([...m.porObra.keys(), ...(a ? a.obras : [])].filter(Boolean));
        // Dias úteis alocados DEPOIS do último lançamento: alocação aberta de
        // máquina que já saiu da obra (desmobilizou e ninguém desalocou) derruba
        // o h/dia. Não é corrigido aqui — é exposto para o cadastro resolver.
        const ultimoLancamento = m.diasComLancamento.size ? [...m.diasComLancamento].sort().pop() : null;
        const diasSemLancarNoFim = a
            ? [...a.uteis].filter(d => !ultimoLancamento || d > ultimoLancamento).length
            : 0;
        porMaquina.push({
            vehicleId: vid,
            registroInterno: v.registroInterno || null,
            placa: v.placa || null,
            modelo: [v.marca, v.modelo].filter(Boolean).join(' ') || null,
            tipo: v.tipo || null,
            grupo: grupoDoVeiculo(v),
            origem: origemDe(v),
            locadora: origemDe(v) === 'terceiro' ? (v.locadora || 'Locadora não informada') : null,
            obras: [...obrasIds].map(id => ({ obraId: id, nome: rotuloObra(obras.get(id)) })),
            horas: r1(m.horas),
            horasAlocadas: r1(m.horasAlocadas),
            diasAlocados,
            diasTrabalhados: m.diasComLancamento.size,
            hDia: diasAlocados > 0 ? r1(m.horasAlocadas / diasAlocados) : null,
            ultimoLancamento,
            diasSemLancarNoFim,
            paradaAlocada: diasSemLancarNoFim >= DIAS_PARADA_ALOCADA,
        });
    }
    porMaquina.sort((a, b) => b.horas - a.horas || (b.hDia ?? -1) - (a.hDia ?? -1));

    const maquinaPorId = new Map(porMaquina.map(m => [m.vehicleId, m]));

    // ── Por obra ─────────────────────────────────────────────────────────────
    const obraAcc = new Map(); // obraId → { proprio, terceiro, maquinas: Map(vid → horas) }
    const obraDe = (oid) => {
        if (!obraAcc.has(oid)) obraAcc.set(oid, { proprio: 0, terceiro: 0, maquinas: new Map() });
        return obraAcc.get(oid);
    };
    for (const [vid, m] of maq) {
        const origem = origemDe(veiculos.get(vid));
        for (const [oid, h] of m.porObra) {
            if (!oid) continue;
            const o = obraDe(oid);
            o[origem] += h;
            o.maquinas.set(vid, (o.maquinas.get(vid) || 0) + h);
        }
    }
    // Alocada na obra sem lançar nada também aparece no detalhe dela.
    for (const [vid, a] of aloc) {
        if (!ids.has(vid)) continue;
        for (const oid of a.obras) {
            const o = obraDe(oid);
            if (!o.maquinas.has(vid)) o.maquinas.set(vid, 0);
        }
    }

    const porObra = [...obraAcc.entries()]
        .map(([oid, o]) => {
            const total = o.proprio + o.terceiro;
            return {
                obraId: oid,
                nome: rotuloObra(obras.get(oid)),
                horasProprio: r1(o.proprio),
                horasTerceiro: r1(o.terceiro),
                total: r1(total),
                pctTerceiro: total > 0 ? r1((o.terceiro / total) * 100) : 0,
                maquinas: [...o.maquinas.entries()]
                    .map(([vid, h]) => {
                        const mm = maquinaPorId.get(vid) || {};
                        return {
                            vehicleId: vid,
                            registroInterno: mm.registroInterno || null,
                            placa: mm.placa || null,
                            modelo: mm.modelo || null,
                            grupo: mm.grupo || null,
                            origem: mm.origem || 'proprio',
                            locadora: mm.locadora || null,
                            horas: r1(h),
                        };
                    })
                    .sort((a, b) => b.horas - a.horas),
            };
        })
        .sort((a, b) => b.total - a.total);

    // ── Por tipo (próprio × terceiro, Σ horas alocadas ÷ Σ dias alocados) ───
    const tipoAcc = new Map();
    for (const m of porMaquina) {
        if (!tipoAcc.has(m.grupo)) {
            tipoAcc.set(m.grupo, {
                proprio: { maquinas: 0, horas: 0, dias: 0 },
                terceiro: { maquinas: 0, horas: 0, dias: 0 },
            });
        }
        const t = tipoAcc.get(m.grupo)[m.origem];
        t.maquinas += 1;
        t.horas += m.horasAlocadas;
        t.dias += m.diasAlocados;
    }
    const lado = (t) => ({
        maquinas: t.maquinas,
        horas: r1(t.horas),
        diasAlocados: t.dias,
        hDia: t.dias > 0 ? r1(t.horas / t.dias) : null,
    });
    const porTipo = [...tipoAcc.entries()]
        .map(([grupo, t]) => {
            const proprio = lado(t.proprio);
            const terceiro = lado(t.terceiro);
            const diffPct = proprio.hDia != null && terceiro.hDia
                ? r1(((proprio.hDia / terceiro.hDia) - 1) * 100)
                : null;
            return { grupo, proprio, terceiro, diffPct };
        })
        .sort((a, b) => (b.proprio.horas + b.terceiro.horas) - (a.proprio.horas + a.terceiro.horas));

    // ── Sem alocação (aviso de cadastro) ─────────────────────────────────────
    const semAlocacao = [...semAloc.values()]
        .map(s => {
            const mm = maquinaPorId.get(s.vehicleId) || {};
            return {
                vehicleId: s.vehicleId,
                registroInterno: mm.registroInterno || null,
                placa: mm.placa || null,
                origem: mm.origem || 'proprio',
                obraId: s.obraId,
                obraNome: rotuloObra(obras.get(s.obraId)),
                horas: r1(s.horas),
                dias: s.dias.size,
            };
        })
        .sort((a, b) => b.horas - a.horas);

    // ── Resumo ───────────────────────────────────────────────────────────────
    const horasTotal = porMaquina.reduce((s, m) => s + m.horas, 0);
    const horasProprio = porMaquina.reduce((s, m) => s + (m.origem === 'proprio' ? m.horas : 0), 0);
    const horasTerceiro = horasTotal - horasProprio;
    const maquinasProprias = porMaquina.filter(m => m.origem === 'proprio').length;

    return {
        range: {
            startDate: start,
            endDate: end,
            diasUteis: businessDayList(start, end, feriados.nacional).filter(d => d.isBusinessDay).length,
        },
        resumo: {
            horasTotal: r1(horasTotal),
            horasProprio: r1(horasProprio),
            horasTerceiro: r1(horasTerceiro),
            pctTerceiro: horasTotal > 0 ? r1((horasTerceiro / horasTotal) * 100) : 0,
            horasAnterior: r1(horasAnterior),
            deltaPct: horasAnterior > 0 ? r1(((horasTotal / horasAnterior) - 1) * 100) : null,
            obras: porObra.filter(o => o.total > 0).length,
            obrasComTerceiro: porObra.filter(o => o.horasTerceiro > 0).length,
            maquinas: porMaquina.length,
            maquinasProprias,
            maquinasTerceiras: porMaquina.length - maquinasProprias,
            horasSemAlocacao: r1(semAlocacao.reduce((s, x) => s + x.horas, 0)),
            paradasAlocadas: {
                proprio: porMaquina.filter(m => m.paradaAlocada && m.origem === 'proprio').length,
                terceiro: porMaquina.filter(m => m.paradaAlocada && m.origem === 'terceiro').length,
                dias: porMaquina.reduce((s, m) => s + (m.paradaAlocada ? m.diasSemLancarNoFim : 0), 0),
            },
            diasParadaAlocada: DIAS_PARADA_ALOCADA,
        },
        porObra,
        porTipo,
        porMaquina,
        semAlocacao,
    };
};

const FILTRO_LOG = "(justificativaTipo IS NULL OR justificativaTipo = '')";

/** Carrega do banco e calcula. */
const producaoPeriodo = async (start, end) => {
    const anterior = periodoAnterior(start, end);

    const [logs] = await db.query(
        `SELECT vehicleId, obraId, DATE_FORMAT(date, '%Y-%m-%d') AS date, totalHours
           FROM daily_work_logs
          WHERE date BETWEEN ? AND ? AND ${FILTRO_LOG}`,
        [start, end]
    );
    const [[prev]] = await db.query(
        `SELECT COALESCE(SUM(totalHours), 0) AS horas
           FROM daily_work_logs
          WHERE date BETWEEN ? AND ? AND ${FILTRO_LOG}`,
        [anterior.start, anterior.end]
    );
    // Folga de 1 dia nas pontas: as datas de entrada/saída podem estar gravadas
    // às 21h da véspera (ver utils/periodosObra.js); o recorte exato é feito
    // depois, por dia civil.
    const [estadias] = await db.query(
        `SELECT veiculoId, obraId, dataEntrada, dataSaida
           FROM obras_historico_veiculos
          WHERE dataEntrada < ? AND (dataSaida IS NULL OR dataSaida >= ?)`,
        [shiftYmd(end, 2), shiftYmd(start, -1)]
    );

    const vids = [...new Set([...logs.map(l => String(l.vehicleId)), ...estadias.map(e => String(e.veiculoId))])];
    const veiculos = new Map();
    if (vids.length) {
        const [rows] = await db.query(
            `SELECT v.id, v.registroInterno, v.placa, v.marca, v.modelo, v.tipo, v.sub_tipo, v.isOutsourced,
                    COALESCE(NULLIF(TRIM(p.nomeFantasia), ''), p.razaoSocial, NULLIF(TRIM(v.nomeEmpresaTerceiro), '')) AS locadora
               FROM vehicles v
               LEFT JOIN partners p ON p.id = v.locadorId
              WHERE v.id IN (?)`,
            [vids]
        );
        rows.forEach(r => veiculos.set(String(r.id), r));
    }

    const oids = [...new Set([...logs.map(l => l.obraId), ...estadias.map(e => e.obraId)].filter(Boolean).map(String))];
    const obras = new Map();
    if (oids.length) {
        const [rows] = await db.query(
            'SELECT id, nome, orgao_contratante, regiao FROM obras WHERE id IN (?)',
            [oids]
        );
        rows.forEach(r => obras.set(String(r.id), r));
    }

    const feriados = { nacional: await loadHolidaySet(db) };
    for (const regiao of HOLIDAY_REGIOES) feriados[regiao] = await loadHolidaySet(db, { regiao });

    return calcularProducao({
        start, end, logs, estadias, veiculos, obras, feriados,
        horasAnterior: Number(prev.horas) || 0,
    });
};

module.exports = { producaoPeriodo, calcularProducao, periodoAnterior };
