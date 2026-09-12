// backend/services/evidenciaAderenciaService.js
// -----------------------------------------------------------------------------
// Consolidação de aderência + PROJEÇÃO da cobrança — Evidências de Campo, Fase 5.
// MODO SEGURO (decisão do negócio): o sistema apenas PROJETA os faltantes na
// tabela evidencia_cobranca_fila com status PENDENTE. NADA é enviado aqui — o
// envio é feito por aprovação manual, item a item, no controller. Assim não há
// disparo em massa a ~200 operadores enquanto o módulo não está testado.
// -----------------------------------------------------------------------------
const db = require('../database');
const { randomUUID } = require('crypto');
const { resolveRegraObra, exigeEvidencia, diaSolicitado } = require('../utils/evidenciaRegras');
const { loadHolidaySet } = require('../utils/businessDays');
const rotinaSvc = require('./evidenciaRotinaService');
const { TIPOS_ROTINA } = require('../utils/evidenciaRotinas');

const TODOS_MOMENTOS = ['horimetro_inicio', 'foto_manha', 'foto_tarde', 'horimetro_fim'];
const MOMENTO_COL = {
    horimetro_inicio: 'tem_horimetro_inicio',
    foto_manha: 'tem_foto_manha',
    foto_tarde: 'tem_foto_tarde',
    horimetro_fim: 'tem_horimetro_fim',
};

// Momentos cobertos por uma dispensa conforme o período.
function momentosDoPeriodo(periodo) {
    if (periodo === 'manha') return ['horimetro_inicio', 'foto_manha'];
    if (periodo === 'tarde') return ['foto_tarde', 'horimetro_fim'];
    return TODOS_MOMENTOS; // 'dia'
}

// Veículos no escopo §2 alocados hoje (dataSaida IS NULL).
async function veiculosAlocados() {
    const [rows] = await db.query(
        `SELECT DISTINCT v.id, v.tipo, v.placa, v.registroInterno, v.modelo,
                h.obraId AS obra_id, h.employeeId AS employee_id,
                o.nome AS obra_nome, o.regiao
           FROM obras_historico_veiculos h
           JOIN vehicles v ON v.id = h.veiculoId
           LEFT JOIN obras o ON o.id = h.obraId
          WHERE h.dataSaida IS NULL`
    );
    return rows.filter(v => exigeEvidencia(v.tipo));
}

// Cache de feriados por região dentro de uma consolidação (o próprio
// businessDays já tem TTL de 5 min; isto evita o round-trip repetido).
async function _feriadosPorRegiao(cache, regiao) {
    const chave = regiao || '';
    if (!(chave in cache)) {
        try { cache[chave] = await loadHolidaySet(db, { regiao: regiao || null }); }
        catch { cache[chave] = new Set(); }
    }
    return cache[chave];
}

async function dispensasDoDia(dataRef) {
    const [rows] = await db.query(
        'SELECT obra_id, veiculo_id, periodo FROM evidencia_dispensa WHERE data_ref = ? AND revogada_em IS NULL',
        [dataRef]
    );
    return rows;
}

async function registrosDoDia(dataRef) {
    const [rows] = await db.query(
        `SELECT veiculo_id, tipo FROM evidencia_registro WHERE data_ref = ? AND estado <> 'descartado'`,
        [dataRef]
    );
    const map = {};
    for (const r of rows) (map[r.veiculo_id] = map[r.veiculo_id] || new Set()).add(r.tipo);
    return map;
}

// Consolida a linha de aderência de cada equipamento no dia.
async function consolidarDia(dataRef) {
    const [veics, disp, enviados] = await Promise.all([veiculosAlocados(), dispensasDoDia(dataRef), registrosDoDia(dataRef)]);
    const regraCache = {};
    const feriadoCache = {};
    let n = 0;
    for (const v of veics) {
        if (!regraCache[v.obra_id]) regraCache[v.obra_id] = await resolveRegraObra(db, v.obra_id);
        const regra = regraCache[v.obra_id];
        const feriadoSet = await _feriadosPorRegiao(feriadoCache, v.regiao);
        const solicitado = diaSolicitado(dataRef, regra, feriadoSet);
        const exigidosBase = (regra.momentos_exigidos || TODOS_MOMENTOS).filter(m => TODOS_MOMENTOS.includes(m));

        const dispSet = new Set();
        disp.filter(d => d.obra_id === v.obra_id && (d.veiculo_id === v.id || d.veiculo_id == null))
            .forEach(d => momentosDoPeriodo(d.periodo).forEach(m => dispSet.add(m)));

        const presentes = enviados[v.id] || new Set();
        const flags = { tem_horimetro_inicio: 0, tem_foto_manha: 0, tem_foto_tarde: 0, tem_horimetro_fim: 0 };
        for (const m of TODOS_MOMENTOS) if (presentes.has(m)) flags[MOMENTO_COL[m]] = 1;

        // Sábado/domingo/feriado: nada é EXIGIDO, mas o que o equipamento
        // eventualmente enviou continua contado e visível no painel. Não basta
        // pular a linha — o dia trabalhado no fim de semana tem que aparecer.
        const exigidas = solicitado ? exigidosBase.filter(m => !dispSet.has(m)) : [];
        const cumpridas = solicitado
            ? exigidas.filter(m => presentes.has(m)).length
            : exigidosBase.filter(m => presentes.has(m)).length;
        const dispensadas = solicitado ? exigidosBase.filter(m => dispSet.has(m)).length : 0;
        const completo = exigidas.length === 0 ? 1 : (cumpridas >= exigidas.length ? 1 : 0);

        // Rotinas contam À PARTE. Entrar em exigidas/cumpridas derrubaria a
        // métrica 4/4 de toda a frota no deploy e quebraria o corte do WhatsApp.
        let rot = { exigidas: 0, cumpridas: 0 };
        try { rot = await rotinaSvc.contarDoDia(db, v.id, dataRef); } catch { /* */ }

        await db.query(
            `INSERT INTO evidencia_aderencia_dia
               (id, obra_id, veiculo_id, employee_id, data_ref,
                tem_horimetro_inicio, tem_horimetro_fim, tem_foto_manha, tem_foto_tarde,
                exigidas, cumpridas, dispensadas, completo,
                dia_solicitado, rotinas_exigidas, rotinas_cumpridas)
             VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?)
             ON DUPLICATE KEY UPDATE
               obra_id=VALUES(obra_id), employee_id=VALUES(employee_id),
               tem_horimetro_inicio=VALUES(tem_horimetro_inicio), tem_horimetro_fim=VALUES(tem_horimetro_fim),
               tem_foto_manha=VALUES(tem_foto_manha), tem_foto_tarde=VALUES(tem_foto_tarde),
               exigidas=VALUES(exigidas), cumpridas=VALUES(cumpridas),
               dispensadas=VALUES(dispensadas), completo=VALUES(completo),
               dia_solicitado=VALUES(dia_solicitado),
               rotinas_exigidas=VALUES(rotinas_exigidas), rotinas_cumpridas=VALUES(rotinas_cumpridas)`,
            [randomUUID(), v.obra_id, v.id, v.employee_id, dataRef,
             flags.tem_horimetro_inicio, flags.tem_horimetro_fim, flags.tem_foto_manha, flags.tem_foto_tarde,
             exigidas.length, cumpridas, dispensadas, completo,
             solicitado ? 1 : 0, rot.exigidas, rot.cumpridas]
        );
        n++;
    }
    return { veiculos: n };
}

// Projeta na fila de cobrança os momentos exigidos que faltam (não enviados e não
// dispensados). NÃO envia nada — só cria itens PENDENTE para aprovação manual.
async function projetarCobrancas(dataRef) {
    const [veics, disp, enviados] = await Promise.all([veiculosAlocados(), dispensasDoDia(dataRef), registrosDoDia(dataRef)]);
    const regraCache = {};
    const feriadoCache = {};
    let criadas = 0;
    for (const v of veics) {
        if (!regraCache[v.obra_id]) regraCache[v.obra_id] = await resolveRegraObra(db, v.obra_id);
        const regra = regraCache[v.obra_id];
        // Fim de semana e feriado não geram cobrança. O envio continua liberado.
        const feriadoSet = await _feriadosPorRegiao(feriadoCache, v.regiao);
        if (!diaSolicitado(dataRef, regra, feriadoSet)) continue;

        const exigidosBase = (regra.momentos_exigidos || TODOS_MOMENTOS).filter(m => TODOS_MOMENTOS.includes(m));

        const dispSet = new Set();
        disp.filter(d => d.obra_id === v.obra_id && (d.veiculo_id === v.id || d.veiculo_id == null))
            .forEach(d => momentosDoPeriodo(d.periodo).forEach(m => dispSet.add(m)));

        const presentes = enviados[v.id] || new Set();
        const faltantes = exigidosBase.filter(m => !presentes.has(m) && !dispSet.has(m));

        // Rotinas semanais abertas (inclusive arrastadas de dias anteriores) entram
        // na MESMA fila de aprovação manual — elas não contam na aderência 4/4, mas
        // o gestor precisa conseguir cobrá-las.
        if (!dispSet.size) {
            try {
                const [abertas] = await db.query(
                    `SELECT tipo FROM evidencia_rotina_agenda
                      WHERE veiculo_id = ? AND status = 'PENDENTE' AND data_prevista <= ?`,
                    [v.id, dataRef]);
                for (const a of abertas) {
                    if (TIPOS_ROTINA.includes(a.tipo) && !presentes.has(a.tipo)) faltantes.push(a.tipo);
                }
            } catch { /* tabela ainda não criada */ }
        }

        if (!faltantes.length) continue;

        // operador (user) do veículo, para o push manual.
        let operadorUserId = null, operadorNome = null;
        if (v.employee_id) {
            const [[u]] = await db.query('SELECT id, name FROM users WHERE employeeId = ? LIMIT 1', [v.employee_id]);
            operadorUserId = u?.id || null; operadorNome = u?.name || null;
        }
        const veicLabel = [v.registroInterno, v.placa].filter(Boolean).join(' · ') || v.modelo || v.id;

        for (const m of faltantes) {
            const horaLimite = (regra.horarios_limite && regra.horarios_limite[m]) || null;
            try {
                await db.query(
                    `INSERT INTO evidencia_cobranca_fila
                       (id, data_ref, obra_id, veiculo_id, employee_id, operador_user_id, tipo, hora_limite,
                        veic_label, obra_nome, operador_nome, status, canal)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PENDENTE','push')
                     ON DUPLICATE KEY UPDATE
                       operador_user_id=VALUES(operador_user_id), operador_nome=VALUES(operador_nome),
                       veic_label=VALUES(veic_label), obra_nome=VALUES(obra_nome), hora_limite=VALUES(hora_limite)`,
                    [randomUUID(), dataRef, v.obra_id, v.id, v.employee_id, operadorUserId, m, horaLimite,
                     veicLabel, v.obra_nome, operadorNome]
                );
                criadas++;
            } catch (e) { console.warn('[evid cobranca] projetar:', e.message); }
        }
    }
    // Momentos que já foram cumpridos e ainda estão como PENDENTE saem da fila.
    await db.query(
        `UPDATE evidencia_cobranca_fila f
            SET f.status='IGNORADA', f.ignorado_em=NOW()
          WHERE f.data_ref=? AND f.status='PENDENTE'
            AND EXISTS (SELECT 1 FROM evidencia_registro r
                        WHERE r.veiculo_id=f.veiculo_id AND r.data_ref=f.data_ref
                          AND r.tipo=f.tipo AND r.estado<>'descartado')`,
        [dataRef]
    );
    return { cobrancas: criadas };
}

module.exports = { consolidarDia, projetarCobrancas };
