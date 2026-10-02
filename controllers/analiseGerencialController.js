const db = require('../database');
const { chaveNoNivelDoMapa, itensDoPlano } = require('../utils/planoItem');
const { precificacaoDaObra, custoCombustivelPorObra } = require('../utils/obraFinanceiro');
const {
    processRange, processPlacaDay,
    _internal: {
        buildLogIntervals, serializeIntervals,
        detectMaquinaAlemDoFaturado, detectFaturadoAlemDaMaquina, detectSemLancamentoComAtividade,
    },
} = require('../services/discrepanciaService');
const { _internal: { unionIntervals } } = require('../services/confrontoService');
const { marcacoesParaIntervalos } = require('../services/pontoEspelhoService');
const { todayBRT } = require('../utils/dateBRT');
const { carregarTaxonomia } = require('../utils/consumo');

// ── Helpers ──────────────────────────────────────────────────────────────────

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return fallback; }
};

const fmtMin = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m}min`;
    if (!m) return `${h}h`;
    return `${h}h${String(m).padStart(2, '0')}min`;
};

const fmtHora = (iso) => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};

const labelTipo = (tipo) => ({
    maquina_alem_do_faturado: 'Máquina rodou fora do faturado',
    faturado_alem_da_maquina: 'Faturado sem rastreador correspondente',
    sem_lancamento_com_atividade: 'Atividade sem nenhum lançamento',
    gap_ponto_maquina_inicio: 'Operador presente, máquina ainda desligada',
    gap_ponto_maquina_fim: 'Máquina parou antes do operador sair',
}[tipo] || tipo);

const buildNarrativa = (row, discrepancias) => {
    if (!discrepancias.length) return 'Sem discrepâncias relevantes nesse dia.';
    const partes = discrepancias.map(d => {
        const ivs = d.intervalos_envolvidos || [];
        const janelas = ivs.length
            ? ivs.map(iv => `${fmtHora(iv.inicio)}–${fmtHora(iv.fim)}`).join(', ')
            : '';
        const sufixo = janelas ? ` em ${janelas}` : '';
        return `• ${labelTipo(d.tipo)} (${fmtMin(d.magnitude_min)})${sufixo}`;
    });
    return partes.join('\n');
};

// ── GET /api/analise-gerencial/discrepancias/obras ───────────────────────────

const obrasOverview = async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        // Quebra por tipo via JSON_TABLE: 1 linha por (obra, tipo)
        const [porTipo] = await db.query(
            `SELECT a.obra_id,
                    o.nome AS obra_nome,
                    JSON_UNQUOTE(JSON_EXTRACT(d.value, '$.tipo')) AS tipo,
                    SUM(JSON_EXTRACT(d.value, '$.magnitude_min')) AS gap_min,
                    COUNT(*) AS qtd
               FROM analise_dia_maquina a
               JOIN JSON_TABLE(a.discrepancias_json, '$[*]' COLUMNS(value JSON PATH '$')) d
               LEFT JOIN obras o ON o.id = a.obra_id
              WHERE a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              GROUP BY a.obra_id, o.nome, JSON_UNQUOTE(JSON_EXTRACT(d.value, '$.tipo'))`,
            [startDate, endDate]
        );

        // Máquinas envolvidas por obra (distinct vehicles em dias com discrepância)
        const [maqRows] = await db.query(
            `SELECT a.obra_id, COUNT(DISTINCT a.vehicle_id) AS maquinas
               FROM analise_dia_maquina a
              WHERE a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              GROUP BY a.obra_id`,
            [startDate, endDate]
        );

        const obrasMap = new Map();
        for (const r of porTipo) {
            const key = r.obra_id || '__none__';
            if (!obrasMap.has(key)) {
                obrasMap.set(key, {
                    obraId: r.obra_id,
                    obraNome: r.obra_nome || '(Sem obra atribuída)',
                    porTipo: {},
                    totalDiscrepancias: 0,
                    gapAcumuladoMin: 0,
                    maquinasEnvolvidas: 0,
                });
            }
            const obra = obrasMap.get(key);
            obra.porTipo[r.tipo] = { qtd: Number(r.qtd), gap: Number(r.gap_min) };
            obra.totalDiscrepancias += Number(r.qtd);
            obra.gapAcumuladoMin += Number(r.gap_min);
        }
        for (const r of maqRows) {
            const key = r.obra_id || '__none__';
            const obra = obrasMap.get(key);
            if (obra) obra.maquinasEnvolvidas = Number(r.maquinas);
        }

        const obras = [...obrasMap.values()].sort((a, b) => b.gapAcumuladoMin - a.gapAcumuladoMin);
        res.json({ startDate, endDate, obras });
    } catch (e) {
        console.error('Erro obrasOverview:', e);
        res.status(500).json({ error: 'Erro ao agregar obras.' });
    }
};

// ── GET /api/analise-gerencial/discrepancias/obra/:obraId ────────────────────

const obraDetalhe = async (req, res) => {
    const { obraId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    const obraFilter = obraId === '__none__' ? 'a.obra_id IS NULL' : 'a.obra_id = ?';
    const obraParam = obraId === '__none__' ? [] : [obraId];

    try {
        const [linhas] = await db.query(
            `SELECT a.id, a.data, a.vehicle_id, a.employee_id, a.discrepancias_json,
                    a.maior_magnitude_min, a.fontes_disponiveis_json,
                    v.placa, v.registroInterno, v.modelo,
                    e.nome AS employee_nome
               FROM analise_dia_maquina a
               LEFT JOIN vehicles v  ON v.id = a.vehicle_id
               LEFT JOIN employees e ON e.id = a.employee_id
              WHERE ${obraFilter}
                AND a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              ORDER BY a.maior_magnitude_min DESC, a.data DESC
              LIMIT 200`,
            [...obraParam, startDate, endDate]
        );

        const kpis = {
            gapMaquinaAlemFaturadoMin: 0,
            gapFaturadoAlemMaquinaMin: 0,
            gapPontoMaquinaMin: 0,
            diasSemLancamentoComAtividade: 0,
        };
        const porMaquina = new Map();
        const porOperador = new Map();

        const lista = linhas.map(r => {
            const disc = parseJson(r.discrepancias_json, []);
            for (const d of disc) {
                if (d.tipo === 'maquina_alem_do_faturado') kpis.gapMaquinaAlemFaturadoMin += d.magnitude_min;
                if (d.tipo === 'faturado_alem_da_maquina') kpis.gapFaturadoAlemMaquinaMin += d.magnitude_min;
                if (d.tipo === 'sem_lancamento_com_atividade') kpis.diasSemLancamentoComAtividade++;
                if (d.tipo && d.tipo.startsWith('gap_ponto_maquina')) kpis.gapPontoMaquinaMin += d.magnitude_min;
            }
            const totalDoDia = disc.reduce((s, d) => s + d.magnitude_min, 0);
            const placaKey = r.placa || r.vehicle_id;
            porMaquina.set(placaKey, (porMaquina.get(placaKey) || { placa: r.placa, registroInterno: r.registroInterno, min: 0 }));
            porMaquina.get(placaKey).min += totalDoDia;
            if (r.employee_nome) {
                porOperador.set(r.employee_nome, (porOperador.get(r.employee_nome) || 0) + totalDoDia);
            }
            return {
                id: r.id,
                data: r.data,
                placa: r.placa,
                registroInterno: r.registroInterno,
                operadorNome: r.employee_nome,
                maiorMagnitudeMin: r.maior_magnitude_min,
                discrepancias: disc,
            };
        });

        const topMaquinas = [...porMaquina.values()]
            .sort((a, b) => b.min - a.min).slice(0, 5);
        const topOperadores = [...porOperador.entries()]
            .map(([nome, min]) => ({ nome, min }))
            .sort((a, b) => b.min - a.min).slice(0, 5);

        res.json({ kpis, topMaquinas, topOperadores, lista });
    } catch (e) {
        console.error('Erro obraDetalhe:', e);
        res.status(500).json({ error: 'Erro ao montar detalhe da obra.' });
    }
};

// ── GET /api/analise-gerencial/discrepancias/:id ─────────────────────────────

const discrepanciaDrill = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT a.*, v.placa, v.registroInterno, v.modelo,
                    e.nome AS employee_nome,
                    o.nome AS obra_nome,
                    u.name AS justificado_por_nome
               FROM analise_dia_maquina a
               LEFT JOIN vehicles  v ON v.id = a.vehicle_id
               LEFT JOIN employees e ON e.id = a.employee_id
               LEFT JOIN obras     o ON o.id = a.obra_id
               LEFT JOIN users     u ON u.id = a.justificado_por
              WHERE a.id = ?`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Linha não encontrada.' });
        const r = rows[0];
        const discrepancias = parseJson(r.discrepancias_json, []);
        res.json({
            id: r.id,
            data: r.data,
            obraId: r.obra_id,
            obraNome: r.obra_nome,
            placa: r.placa,
            registroInterno: r.registroInterno,
            modelo: r.modelo,
            operadorNome: r.employee_nome,
            fontesDisponiveis: parseJson(r.fontes_disponiveis_json, {}),
            faturadoIntervalos: parseJson(r.faturado_intervalos_json, []),
            rastreadorIntervalos: parseJson(r.rastreador_intervalos_json, []),
            pontoIntervalos: parseJson(r.ponto_intervalos_json, null),
            fonteSinal: r.fonte_sinal,
            discrepancias,
            narrativa: buildNarrativa(r, discrepancias),
            justificadoEm: r.justificado_em,
            justificadoPor: r.justificado_por_nome,
            justificativa: r.justificativa,
        });
    } catch (e) {
        console.error('Erro discrepanciaDrill:', e);
        res.status(500).json({ error: 'Erro ao buscar drill.' });
    }
};

// ── POST /api/analise-gerencial/discrepancias/:id/justificar ─────────────────

const justificar = async (req, res) => {
    const { id } = req.params;
    const { justificativa } = req.body || {};
    if (!justificativa || !justificativa.trim()) {
        return res.status(400).json({ error: 'Justificativa é obrigatória.' });
    }
    try {
        const [r] = await db.query(
            `UPDATE analise_dia_maquina
                SET justificado_em = NOW(),
                    justificado_por = ?,
                    justificativa = ?
              WHERE id = ?`,
            [req.user.id, justificativa.trim(), id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Linha não encontrada.' });
        res.json({ ok: true });
    } catch (e) {
        console.error('Erro justificar:', e);
        res.status(500).json({ error: 'Erro ao justificar.' });
    }
};

// ── GET /api/analise-gerencial/jornadas/operador/:employeeId ─────────────────
//
// Relatório de jornadas por operador num período. Três trilhas por máquina-dia:
//   Faturado   — daily_work_logs (ao vivo);
//   Rastreador — analise_dia_maquina (materializado na madrugada);
//   Ponto      — ponto_espelho_dias (espelho de ponto importado).
// As discrepâncias são recalculadas aqui, com o faturado atual.

const sumIntervalsMin = (intervals) => {
    if (!Array.isArray(intervals) || !intervals.length) return 0;
    let ms = 0;
    for (const iv of intervals) {
        const ini = new Date(iv.inicio).getTime();
        const fim = new Date(iv.fim).getTime();
        if (fim > ini) ms += (fim - ini);
    }
    return Math.round(ms / 60000);
};

const msIntervals = (ivs) => (Array.isArray(ivs) ? ivs : [])
    .map(iv => ({ inicio: new Date(iv.inicio).getTime(), fim: new Date(iv.fim).getTime() }))
    .filter(iv => iv.fim > iv.inicio);

const jornadasOperador = async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        const [empRows] = await db.query(
            'SELECT id, nome, funcao FROM employees WHERE id = ? LIMIT 1',
            [employeeId]
        );
        if (!empRows.length) return res.status(404).json({ error: 'Operador não encontrado.' });
        const operador = empRows[0];

        // Deslocamento com veículo leve não é jornada de operação: fica fora de
        // todas as trilhas (faturado, rastreador e ponto), dos totais e do resumo.
        const { tipoParaGrupo } = await carregarTaxonomia();
        const ehLeve = (tipo) => tipoParaGrupo.get(tipo) === 'Veículos Leves';

        // Trilha FATURADO: sai direto de daily_work_logs (Faturamento e Controle),
        // e não do faturado_intervalos_json materializado. A materialização roda
        // uma vez, na madrugada seguinte ao dia; hora lançada depois disso (o caso
        // comum: o mês é digitado no fechamento) nunca entrava no relatório.
        const SELECT_LOG = `
            SELECT DATE_FORMAT(l.date, '%Y-%m-%d') AS data, l.vehicleId, l.obraId, l.employeeId,
                   l.morningStart, l.morningEnd, l.afternoonStart, l.afternoonEnd,
                   v.placa, v.registroInterno, v.modelo, v.tipo, o.nome AS obra_nome
              FROM daily_work_logs l
              LEFT JOIN vehicles v ON v.id = l.vehicleId
              LEFT JOIN obras    o ON o.id = l.obraId`;
        const [logsOperador] = await db.query(
            `${SELECT_LOG} WHERE l.employeeId = ? AND l.date BETWEEN ? AND ?`,
            [employeeId, startDate, endDate]
        );

        // Trilha RASTREADOR (+ justificativas): materializada. Traz as máquinas
        // que o operador lançou no período e as que estavam alocadas a ele.
        const [analise] = await db.query(
            `SELECT a.id, DATE_FORMAT(a.data, '%Y-%m-%d') AS data, a.vehicle_id, a.employee_id, a.obra_id,
                    a.rastreador_intervalos_json, a.fontes_disponiveis_json, a.fonte_sinal,
                    a.justificado_em, a.justificativa,
                    v.placa, v.registroInterno, v.modelo, v.tipo,
                    o.nome AS obra_nome
               FROM analise_dia_maquina a
               LEFT JOIN vehicles v ON v.id = a.vehicle_id
               LEFT JOIN obras    o ON o.id = a.obra_id
              WHERE a.data BETWEEN ? AND ?
                AND (
                    a.employee_id = ?
                    OR a.vehicle_id IN (
                        SELECT DISTINCT vehicleId FROM daily_work_logs
                         WHERE employeeId = ? AND date BETWEEN ? AND ?
                    )
                )`,
            [startDate, endDate, employeeId, employeeId, startDate, endDate]
        );

        // Lançamentos de OUTROS (ou sem operador) nas mesmas máquinas: o dia em
        // que outro operador lançou a máquina não é jornada deste; lançamento sem
        // operador numa máquina dele entra como faturado.
        const vehicleIds = [...new Set([
            ...logsOperador.map(l => l.vehicleId),
            ...analise.map(a => a.vehicle_id),
        ])];
        let logsOutros = [];
        if (vehicleIds.length) {
            [logsOutros] = await db.query(
                `${SELECT_LOG}
                  WHERE l.date BETWEEN ? AND ? AND l.vehicleId IN (?)
                    AND (l.employeeId IS NULL OR l.employeeId <> ?)`,
                [startDate, endDate, vehicleIds, employeeId]
            );
        }

        // Trilha PONTO: espelho de ponto importado (um registro por dia).
        let pontoRows = [];
        try {
            [pontoRows] = await db.query(
                `SELECT DATE_FORMAT(data, '%Y-%m-%d') AS data, marcacoes_json, observacao
                   FROM ponto_espelho_dias
                  WHERE employee_id = ? AND data BETWEEN ? AND ?`,
                [employeeId, startDate, endDate]
            );
        } catch (e) {
            if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
        }
        const pontoPorDia = new Map();
        for (const p of pontoRows) {
            const intervalos = marcacoesParaIntervalos(p.data, parseJson(p.marcacoes_json, []));
            pontoPorDia.set(p.data, {
                intervalos,
                min: sumIntervalsMin(intervalos),
                observacao: p.observacao || null,
            });
        }

        const vdKey = (vehicleId, data) => `${vehicleId}|${data}`;

        const diaDeOutro = new Set();          // máquina-dia lançado por outro operador
        const logsDoDia = new Map();           // máquina-dia → intervalos de TODOS os lançamentos
        const addLogsDoDia = (l) => {
            const k = vdKey(l.vehicleId, l.data);
            if (!logsDoDia.has(k)) logsDoDia.set(k, []);
            logsDoDia.get(k).push(...buildLogIntervals(l, l.data));
        };
        logsOperador.forEach(addLogsDoDia);
        for (const l of logsOutros) {
            addLogsDoDia(l);
            if (l.employeeId) diaDeOutro.add(vdKey(l.vehicleId, l.data));
        }

        const rastreadorDoDia = new Map();     // máquina-dia → rastreador materializado
        const analisePorObra = new Map();      // máquina-dia-obra → linha (justificativa)
        for (const a of analise) {
            const k = vdKey(a.vehicle_id, a.data);
            if (!rastreadorDoDia.has(k)) {
                rastreadorDoDia.set(k, {
                    intervalos: msIntervals(parseJson(a.rastreador_intervalos_json, [])),
                    temDados: !!parseJson(a.fontes_disponiveis_json, {}).rastreador,
                    fonteSinal: a.fonte_sinal,
                });
            }
            analisePorObra.set(`${k}|${a.obra_id || '__none__'}`, a);
        }

        // Blocos (máquina, dia, obra) com lançamento: os do operador e os sem
        // operador em máquina-dia que ninguém mais lançou.
        const blocos = new Map();
        const addAoBloco = (l) => {
            const k = `${vdKey(l.vehicleId, l.data)}|${l.obraId || '__none__'}`;
            if (!blocos.has(k)) blocos.set(k, { ref: l, vehicleId: l.vehicleId, obraId: l.obraId, intervalos: [], lancado: false });
            const b = blocos.get(k);
            b.intervalos.push(...buildLogIntervals(l, l.data));
            if (l.employeeId) b.lancado = true;
        };
        logsOperador.forEach(addAoBloco);
        logsOutros
            .filter(l => !l.employeeId && !diaDeOutro.has(vdKey(l.vehicleId, l.data)))
            .forEach(addAoBloco);

        // Máquina-dia sem lançamento nenhum, mas com a máquina alocada/usada por ele.
        const comBloco = new Set([...blocos.values()].map(b => vdKey(b.vehicleId, b.ref.data)));
        for (const a of analise) {
            const k = vdKey(a.vehicle_id, a.data);
            if (comBloco.has(k) || diaDeOutro.has(k)) continue;
            comBloco.add(k);
            blocos.set(`${k}|__sem__`, {
                ref: { ...a, vehicleId: a.vehicle_id },
                vehicleId: a.vehicle_id, obraId: a.obra_id, intervalos: [], lancado: false,
            });
        }

        const totaisMin = { faturado: 0, rastreador: 0, ponto: 0 };
        const fontesGlobais = { faturado: false, rastreador: false, ponto: pontoPorDia.size > 0 };
        let totalDiscrepancias = 0;
        let totalMagnitudeMin = 0;
        const diasMap = new Map();
        const maquinas = new Set();
        const rastreadorContado = new Set();

        const ordenados = [...blocos.values()]
            .filter(b => !ehLeve(b.ref.tipo))
            .sort((x, y) => x.ref.data.localeCompare(y.ref.data)
                || String(x.ref.registroInterno || '').localeCompare(String(y.ref.registroInterno || '')));

        for (const b of ordenados) {
            const { ref } = b;
            const k = vdKey(b.vehicleId, ref.data);
            const fatMs = unionIntervals(b.intervalos);
            const ras = rastreadorDoDia.get(k) || { intervalos: [], temDados: false, fonteSinal: null };
            const temLancamento = logsDoDia.has(k);

            // "Rodou além do faturado" compara com TODOS os lançamentos da
            // máquina no dia e entra só no 1º bloco da máquina-dia (não duplica
            // quando ela foi lançada em duas obras).
            const primeiroDoDia = !rastreadorContado.has(k);
            const disc = [
                ...(primeiroDoDia && temLancamento
                    ? detectMaquinaAlemDoFaturado(ras.intervalos, unionIntervals(logsDoDia.get(k))) : []),
                ...(temLancamento ? detectFaturadoAlemDaMaquina(ras.intervalos, fatMs) : []),
                ...(primeiroDoDia ? detectSemLancamentoComAtividade(ras.intervalos, temLancamento) : []),
            ];

            const fat = serializeIntervals(fatMs);
            const rasSer = serializeIntervals(ras.intervalos);
            const ponto = pontoPorDia.get(ref.data) || null;
            const minFat = sumIntervalsMin(fat);
            const minRas = sumIntervalsMin(rasSer);

            totaisMin.faturado += minFat;
            if (primeiroDoDia) {
                totaisMin.rastreador += minRas;
                rastreadorContado.add(k);
            }
            if (fatMs.length) fontesGlobais.faturado = true;
            if (ras.temDados) fontesGlobais.rastreador = true;
            totalDiscrepancias += disc.length;
            totalMagnitudeMin += disc.reduce((s, d) => s + (d.magnitude_min || 0), 0);
            maquinas.add(b.vehicleId);

            const linha = analisePorObra.get(`${k}|${b.obraId || '__none__'}`) || null;
            if (!diasMap.has(ref.data)) diasMap.set(ref.data, []);
            diasMap.get(ref.data).push({
                analiseId: linha ? linha.id : null,
                vehicleId: b.vehicleId,
                placa: ref.placa,
                registroInterno: ref.registroInterno,
                modelo: ref.modelo,
                obraId: b.obraId || null,
                obraNome: ref.obra_nome,
                faturadoIntervalos: fat,
                rastreadorIntervalos: rasSer,
                pontoIntervalos: ponto ? ponto.intervalos : null,
                totaisMin: { faturado: minFat, rastreador: minRas, ponto: ponto ? ponto.min : 0 },
                discrepancias: disc,
                maiorMagnitudeMin: disc.reduce((m, d) => Math.max(m, d.magnitude_min || 0), 0),
                fonteSinal: ras.fonteSinal,
                fontesDisponiveis: { faturado: fatMs.length > 0, rastreador: ras.temDados, ponto: !!ponto },
                justificadoEm: linha ? linha.justificado_em : null,
                justificativa: linha ? linha.justificativa : null,
                lancadoPeloOperador: b.lancado,
            });
        }

        // Ponto conta uma vez por DIA (não por máquina). Dia com ponto e sem
        // máquina lançada/rastreada entra como bloco próprio, sem equipamento.
        for (const [data, ponto] of pontoPorDia) {
            totaisMin.ponto += ponto.min;
            if (diasMap.has(data) || !ponto.intervalos.length) continue;
            diasMap.set(data, [{
                analiseId: null, vehicleId: null, placa: null,
                registroInterno: 'Sem equipamento lançado', modelo: null,
                obraId: null, obraNome: ponto.observacao || null,
                semEquipamento: true,
                faturadoIntervalos: [], rastreadorIntervalos: [],
                pontoIntervalos: ponto.intervalos,
                totaisMin: { faturado: 0, rastreador: 0, ponto: ponto.min },
                discrepancias: [], maiorMagnitudeMin: 0, fonteSinal: null,
                fontesDisponiveis: { faturado: false, rastreador: false, ponto: true },
                justificadoEm: null, justificativa: null, lancadoPeloOperador: false,
            }]);
        }

        const dias = [...diasMap.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([data, maquinasDoDia]) => ({ data, maquinas: maquinasDoDia }));

        res.json({
            operador,
            periodo: { startDate, endDate },
            totaisMin,
            fontesDisponiveis: fontesGlobais,
            resumo: {
                diasComAtividade: dias.length,
                maquinasOperadas: maquinas.size,
                totalDiscrepancias,
                totalMagnitudeMin,
            },
            dias,
        });
    } catch (e) {
        console.error('Erro jornadasOperador:', e);
        res.status(500).json({ error: 'Erro ao montar jornadas do operador.' });
    }
};

// ── POST /api/analise-gerencial/discrepancias/reprocessar ────────────────────

const reprocessar = async (req, res) => {
    const { startDate, endDate, placa } = req.body || {};
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        if (placa) {
            await db.query(
                'DELETE FROM analise_dia_maquina WHERE data BETWEEN ? AND ? AND justificado_em IS NULL AND vehicle_id IN (SELECT id FROM vehicles WHERE REPLACE(REPLACE(UPPER(placa),"-",""),(" "),"") = REPLACE(REPLACE(UPPER(?),"-",""),(" "),""))',
                [startDate, endDate, placa]
            );
            const result = { processed: 0, discrepancias: 0 };
            const cur = new Date(startDate);
            const end = new Date(endDate);
            while (cur <= end) {
                const d = cur.toISOString().slice(0, 10);
                const r = await processPlacaDay(placa, d);
                if (!r.skipped) {
                    result.processed++;
                    result.discrepancias += r.discrepancias || 0;
                }
                cur.setDate(cur.getDate() + 1);
            }
            return res.json(result);
        }

        await db.query(
            'DELETE FROM analise_dia_maquina WHERE data BETWEEN ? AND ? AND justificado_em IS NULL',
            [startDate, endDate]
        );
        const result = await processRange(startDate, endDate);
        if (req.io) req.io.emit('server:sync', { targets: ['analise-gerencial'] });
        res.json(result);
    } catch (e) {
        console.error('Erro reprocessar análise:', e);
        res.status(500).json({ error: 'Erro ao reprocessar.' });
    }
};

// ── GET /api/analise-gerencial/projecao/:obraId ──────────────────────────────

const getProjecaoObra = async (req, res) => {
    const { obraId } = req.params;
    try {
        const [[obra]] = await db.query('SELECT * FROM obras WHERE id = ?', [obraId]);
        if (!obra) return res.status(404).json({ error: 'Obra não encontrada.' });

        // Preço por subgrupo (nível do contrato), com o mapa legado por grupo de
        // fallback — ver utils/obraFinanceiro.js. É a mesma regra do painel.
        const { precoDaHora, horasContratadas, faturamentoContratado } = precificacaoDaObra(obra);

        // Logs diários: horas por (data, item do plano, grupo e subgrupo do
        // veículo). O item declarado na alocação vem SEPARADO da máquina porque é
        // ele que preserva a substituição (uma 11T no item 23T vale o 23T).
        // Ver docs/item-de-contrato-e-substituicao-plano.md.
        const [logRows] = await db.query(`
            SELECT DATE_FORMAT(l.date, '%Y-%m-%d')  AS data_log,
                   NULLIF(l.planoItemKey, '')       AS itemKey,
                   v.tipo                           AS grupoVeiculo,
                   NULLIF(v.sub_tipo, '')           AS subgrupoVeiculo,
                   v.id                             AS veiculoId,
                   v.registroInterno                AS registroInterno,
                   v.modelo                         AS modelo,
                   SUM(l.totalHours)                AS horas,
                   COUNT(*)                         AS lancamentos
              FROM daily_work_logs l
              LEFT JOIN vehicles v ON v.id = l.vehicleId
             WHERE l.obraId = ?
             GROUP BY data_log, itemKey, grupoVeiculo, subgrupoVeiculo,
                      veiculoId, registroInterno, modelo
             ORDER BY data_log ASC
        `, [obraId]);

        // Agrupa por data
        const porData = {};
        logRows.forEach(r => {
            const d = r.data_log;
            if (!porData[d]) porData[d] = [];
            porData[d].push({
                preco: precoDaHora(r),
                horas: parseFloat(r.horas) || 0,
            });
        });

        const todasDatas = Object.keys(porData).sort();
        const dataInicio = todasDatas[0] || null;

        // Totais acumulados
        let totalHoras = 0;
        let totalFaturamentoRS = 0;
        let temValores = false;
        todasDatas.forEach(d => {
            porData[d].forEach(e => {
                totalHoras += e.horas;
                if (e.preco > 0) temValores = true;
                totalFaturamentoRS += e.horas * e.preco;
            });
        });

        // ── Realizado por ITEM do contrato ───────────────────────────────────
        // O contrato é assinado item a item (subgrupo: "Escavadeira 13t" ≠ "26t"),
        // então o progresso agregado esconde o que interessa: um item pode estar
        // em 130% e outro em 20% e o total parecer saudável.
        //
        // A chave do realizado precisa sair no MESMO nível do plano — `itensDoPlano`
        // devolve subgrupo quando a obra tem plano por subgrupo e grupo quando não
        // tem. Hora cuja chave não existe no plano NÃO é descartada: vira item
        // "fora do contrato", que é justamente o dado que faltava (hora apontada
        // em máquina que o contrato não prevê).
        const plano = itensDoPlano(obra);
        const nivelPlano = plano[0]?.nivel || 'grupo';
        const planoMap = {};
        plano.forEach((i) => { planoMap[i.key] = i.horasContratadas; });

        const chaveDoItem = (r) => (nivelPlano === 'subgrupo'
            ? ((r.itemKey || '').trim() || r.subgrupoVeiculo || r.grupoVeiculo || null)
            : chaveNoNivelDoMapa(r.itemKey, r.grupoVeiculo, planoMap));

        const realizadoPorItem = {};
        // Série diária e frota POR ITEM — o detalhe de um item precisa do dia a
        // dia, não só do total. Mantém a mesma chave do realizado para que item
        // fora do contrato também tenha o próprio histórico.
        const diasPorItem = {};
        const veiculosPorItem = {};
        logRows.forEach((r) => {
            const chave = chaveDoItem(r) || '(sem classificação)';
            const horas = parseFloat(r.horas) || 0;
            realizadoPorItem[chave] = (realizadoPorItem[chave] || 0) + horas;

            if (!diasPorItem[chave]) diasPorItem[chave] = {};
            diasPorItem[chave][r.data_log] = (diasPorItem[chave][r.data_log] || 0) + horas;

            if (!veiculosPorItem[chave]) veiculosPorItem[chave] = {};
            const vk = r.veiculoId || r.registroInterno || '(sem veículo)';
            if (!veiculosPorItem[chave][vk]) {
                veiculosPorItem[chave][vk] = {
                    registroInterno: r.registroInterno || null,
                    modelo: r.modelo || null,
                    grupo: r.grupoVeiculo || null,
                    subgrupo: r.subgrupoVeiculo || null,
                    horas: 0,
                    lancamentos: 0,
                    primeiroDia: r.data_log,
                    ultimoDia: r.data_log,
                };
            }
            const alvo = veiculosPorItem[chave][vk];
            alvo.horas += horas;
            alvo.lancamentos += Number(r.lancamentos) || 0;
            if (r.data_log < alvo.primeiroDia) alvo.primeiroDia = r.data_log;
            if (r.data_log > alvo.ultimoDia) alvo.ultimoDia = r.data_log;
        });

        const porItem = [...new Set([...Object.keys(planoMap), ...Object.keys(realizadoPorItem)])]
            .map((key) => {
                const contratadas = parseFloat(planoMap[key]) || 0;
                const executadas = realizadoPorItem[key] || 0;
                let acum = 0;
                const serieDiaria = Object.entries(diasPorItem[key] || {})
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([data, horas]) => {
                        acum += horas;
                        return {
                            data,
                            horas: Math.round(horas * 10) / 10,
                            horasAcumuladas: Math.round(acum * 10) / 10,
                            percentualAcumulado: contratadas > 0
                                ? Math.round((acum / contratadas) * 1000) / 10
                                : null,
                        };
                    });

                const veiculos = Object.values(veiculosPorItem[key] || {})
                    .map((v) => ({ ...v, horas: Math.round(v.horas * 10) / 10 }))
                    .sort((a, b) => b.horas - a.horas);

                return {
                    key,
                    nivel: nivelPlano,
                    foraDoContrato: !Object.prototype.hasOwnProperty.call(planoMap, key),
                    horasContratadas: Math.round(contratadas * 10) / 10,
                    horasExecutadas: Math.round(executadas * 10) / 10,
                    percentual: contratadas > 0 ? Math.round((executadas / contratadas) * 1000) / 10 : null,
                    diasComLancamento: serieDiaria.length,
                    serieDiaria,
                    veiculos,
                };
            })
            // Fora do contrato primeiro (é exceção e precisa ser vista), depois do
            // item mais estourado para o menos executado.
            .sort((a, b) => {
                if (a.foraDoContrato !== b.foraDoContrato) return a.foraDoContrato ? -1 : 1;
                return (b.percentual ?? -1) - (a.percentual ?? -1);
            });

        // Quinzenas: janelas fixas de 15 dias a partir da data de início operacional
        const quinzenas = [];
        if (dataInicio) {
            const today = todayBRT();
            let horasAcum = 0;
            let faturAcum = 0;

            const inicioMs = new Date(dataInicio + 'T12:00:00').getTime();
            const hojeMs   = new Date(today + 'T12:00:00').getTime();
            const maxQuinzenas = Math.min(
                60,
                Math.max(1, Math.floor((hojeMs - inicioMs) / (15 * 24 * 60 * 60 * 1000)) + 1)
            );

            for (let q = 0; q < maxQuinzenas; q++) {
                const ini = new Date(dataInicio + 'T12:00:00');
                ini.setDate(ini.getDate() + q * 15);
                const fim = new Date(ini);
                fim.setDate(fim.getDate() + 14);

                const iniStr = ini.toISOString().slice(0, 10);
                const fimStr = fim.toISOString().slice(0, 10);

                if (iniStr > today) break;

                const datasNaQ = todasDatas.filter(d => d >= iniStr && d <= fimStr);
                let horasQ = 0;
                let faturQ = 0;
                datasNaQ.forEach(d => {
                    porData[d].forEach(e => {
                        horasQ += e.horas;
                        faturQ += e.horas * e.preco;
                    });
                });

                horasAcum += horasQ;
                faturAcum += faturQ;

                const percentAcum  = horasContratadas > 0 ? (horasAcum  / horasContratadas) * 100 : 0;
                const deltaPercent = horasContratadas > 0 ? (horasQ     / horasContratadas) * 100 : 0;

                quinzenas.push({
                    numero:            q + 1,
                    dataInicio:        iniStr,
                    dataFim:           fimStr,
                    horasLancadas:     Math.round(horasQ  * 10) / 10,
                    faturamentoRS:     Math.round(faturQ  * 100) / 100,
                    percentualAcumulado: Math.round(percentAcum  * 10) / 10,
                    deltaPercent:      Math.round(deltaPercent * 10) / 10,
                    atingiuMeta:       deltaPercent >= 30,
                    encerrada:         fimStr < today,
                    excedeuContratado: horasContratadas > 0 && horasAcum > horasContratadas,
                });
            }
        }

        // Ritmo e projeção de prazo
        const diasComLancamento = todasDatas.length;
        const ritmoHorasPorDia  = diasComLancamento > 0 ? totalHoras / diasComLancamento : 0;
        const horasRestantes    = Math.max(0, horasContratadas - totalHoras);
        const diasParaFinalizar = ritmoHorasPorDia > 0 ? Math.ceil(horasRestantes / ritmoHorasPorDia) : null;
        const percentConcluido  = horasContratadas > 0 ? (totalHoras / horasContratadas) * 100 : 0;

        // Custo de combustível da obra: abastecimentos concluídos (litros
        // abastecidos × preço) + despesas de combustível que não derivam de
        // abastecimento (saída de comboio, drenagem, manuais). Somar `expenses`
        // direto contava em dobro o mês de posto renomeado — ver
        // utils/obraFinanceiro.js. Mesmo número do painel Obras em foco.
        const custoComb = (await custoCombustivelPorObra(db, [obraId])).get(String(obraId))
            || { total: 0, abastecimentos: 0, outros: 0 };
        const totalCustoCombust = custoComb.total;

        // Litros consumidos (informativo) — somados dos abastecimentos vinculados
        // à obra. Serve só para exibição; o custo NÃO deriva mais daqui.
        const [[litrosRow]] = await db.query(`
            SELECT COALESCE(SUM(litrosLiberados), 0) AS total
              FROM refuelings
             WHERE obraId = ? AND litrosLiberados IS NOT NULL
        `, [obraId]);
        const totalLitros = parseFloat(litrosRow.total) || 0;

        // Lista dos abastecimentos da obra — a memória do consumo físico. Inclui
        // ordens abertas, que ainda não entram no custo.
        const [abastecimentosRows] = await db.query(`
            SELECT r.id,
                   DATE_FORMAT(r.data, '%Y-%m-%d %H:%i') AS data,
                   COALESCE(NULLIF(r.vehicleInternalId,''), v.registroInterno) AS veiculo,
                   v.modelo                              AS modelo,
                   r.partnerName                         AS posto,
                   r.employeeName                        AS operador,
                   r.fuelType                            AS combustivel,
                   r.litrosLiberados                     AS litros,
                   r.litrosAbastecidos                   AS litrosAbastecidos,
                   r.pricePerLiter                       AS precoLitro,
                   r.is_full_tank                        AS tanqueCheio,
                   r.status                              AS status
              FROM refuelings r
              LEFT JOIN vehicles v ON v.id = r.vehicleId
             WHERE r.obraId = ?
             ORDER BY r.data DESC
             LIMIT 500
        `, [obraId]);

        const abastecimentos = abastecimentosRows.map((r) => {
            const liberados = parseFloat(r.litros) || 0;
            const abastecidos = parseFloat(r.litrosAbastecidos) || 0;
            // O volume que vale para leitura é o efetivamente abastecido; o
            // liberado é a autorização. Metade dos registros só tem um dos dois,
            // então exibir um campo só deixaria linhas zeradas sem motivo.
            const litros = abastecidos || liberados;
            const preco = parseFloat(r.precoLitro) || 0;
            return {
                id: r.id,
                data: r.data,
                veiculo: r.veiculo || null,
                modelo: r.modelo || null,
                posto: r.posto || null,
                operador: r.operador || null,
                combustivel: r.combustivel || null,
                litros: Math.round(litros * 10) / 10,
                litrosLiberados: Math.round(liberados * 10) / 10,
                litrosAbastecidos: abastecidos ? Math.round(abastecidos * 10) / 10 : null,
                precoLitro: preco || null,
                valorRS: preco > 0 ? Math.round(litros * preco * 100) / 100 : null,
                tanqueCheio: !!r.tanqueCheio,
                status: r.status || null,
            };
        });

        // % combustível sobre faturamento já realizado
        const percentCombust = totalFaturamentoRS > 0
            ? (totalCustoCombust / totalFaturamentoRS) * 100
            : 0;

        // Projeção linear: o custo de combustível cresce com o progresso físico,
        // então a 100% ele vale custo / (X/100). O percentual final é esse custo
        // sobre o faturamento a 100% (horas contratadas × valor hora) — a MESMA
        // base do percentual atual, para os dois serem comparáveis.
        // NÃO dividir percentCombust por X: ele já está sobre o faturamento
        // realizado, que também cresce com X — dividir de novo conta o progresso
        // duas vezes (41% a 61% virava 67,5%).
        // NÃO usar valorTotalContrato: ele inclui km de prancha, que não tem hora,
        // e mudaria a base (a projeção sairia artificialmente abaixo do atual).
        // Sem preços ou com progresso < 1%, fica a proporção atual.
        // `faturamentoContratado` vem de precificacaoDaObra (mesmo nível do preço).
        const custoCombustProjetado = percentConcluido > 1
            ? totalCustoCombust / (percentConcluido / 100)
            : null;
        const projecaoFinalPercent = custoCombustProjetado != null && faturamentoContratado > 0
            ? (custoCombustProjetado / faturamentoContratado) * 100
            : percentCombust;

        res.json({
            obra: {
                id:               obra.id,
                nome:             obra.nome,
                contractType:     obra.contractType || 'horas',
                horasContratadas,
                temValoresPorTipo: temValores,
                dataInicio,
            },
            faturamento: {
                totalHorasFaturadas:  Math.round(totalHoras          * 10)  / 10,
                totalRS:              Math.round(totalFaturamentoRS   * 100) / 100,
                percentualConcluido:  Math.round(percentConcluido     * 10)  / 10,
                ritmoHorasPorDia:     Math.round(ritmoHorasPorDia     * 10)  / 10,
                diasParaFinalizar,
                diasComLancamento,
                quinzenas,
                porItem,
            },
            combustivel: {
                totalLitros:           Math.round(totalLitros        * 10)  / 10,
                totalCustoRS:          Math.round(totalCustoCombust  * 100) / 100,
                // Composição do custo: abastecimentos concluídos + comboio/manuais.
                custoAbastecimentosRS: Math.round(custoComb.abastecimentos * 100) / 100,
                custoOutrosRS:         Math.round(custoComb.outros * 100) / 100,
                percentualAtual:       Math.round(percentCombust     * 10)  / 10,
                projecaoFinalPercent:  Math.round(projecaoFinalPercent * 10) / 10,
                custoProjetadoRS:      custoCombustProjetado != null ? Math.round(custoCombustProjetado * 100) / 100 : null,                alertaCritico:         projecaoFinalPercent > 20,
                semDados:              totalCustoCombust === 0 && totalLitros === 0,
                abastecimentos,
            },
        });
    } catch (e) {
        console.error('[projecaoObra]', e);
        res.status(500).json({ error: 'Erro ao calcular projeção da obra.' });
    }
};

module.exports = {
    obrasOverview,
    obraDetalhe,
    discrepanciaDrill,
    justificar,
    reprocessar,
    jornadasOperador,
    getProjecaoObra,
};
