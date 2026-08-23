// backend/utils/regrasAbastecimento.js
//
// =============================================================================
// REGRAS SOBERANAS DE EMISSÃO DE ORDEM DE ABASTECIMENTO
// =============================================================================
//
// Estas quatro travas viviam soltas dentro de controllers/refuelingController.js:
// duas como funções privadas e duas inline no meio de createRefuelingOrder,
// misturadas com rollback e res.status(). Foram extraídas para cá como PREDICADOS
// PUROS (recebem conexão, devolvem motivo ou null) por um motivo específico:
//
// o aceite automático por IA precisa avaliar EXATAMENTE as mesmas regras que o
// gestor humano. Se ele reimplementasse as verificações, qualquer ajuste futuro
// numa das cópias faria a automação divergir do fluxo manual em silêncio — e a
// promessa de "as regras existentes são soberanas" viraria ficção.
//
// Agora existe uma implementação só, consumida pelos dois caminhos.

const { vehicleGroups } = require('./vehicleRules');

// Feriados nacionais de data fixa. Em feriado e fim de semana a trava de ordem
// duplicada é dispensada (a obra pode precisar abastecer fora do expediente).
// NOTA: o frontend consulta a tabela `admin_holidays`, que inclui feriados
// móveis e municipais — divergência conhecida, registrada na revisão.
const FERIADOS_BR_FIXOS = new Set([
    '01-01', '04-21', '05-01', '09-07',
    '10-12', '11-02', '11-15', '12-25',
]);

const STATUS_ORDEM_ENCERRADA = ['Concluída', 'Concluida', 'Cancelada', 'Negada', 'Baixada'];

const ehFimDeSemanaOuFeriado = (ymd) => {
    const dow = new Date(`${ymd}T12:00:00-03:00`).getDay();
    const mmdd = ymd.slice(5, 10);
    return dow === 0 || dow === 6 || FERIADOS_BR_FIXOS.has(mmdd);
};

/**
 * Leitura informada é aceitável? Regressão e salto excessivo bloqueiam.
 * Compara contra a leitura CORRENTE do veículo (vehicles.odometro/horimetro),
 * não contra o último abastecimento.
 *
 * @returns {Promise<string|null>} motivo do bloqueio, ou null se passou
 */
const checkLeituraBloqueada = async (connection, vehicleId, odometro, horimetro) => {
    if (!vehicleId) return null;
    try {
        const [[v]] = await connection.execute(
            'SELECT tipo, odometro AS odoAtual, horimetro AS horiAtual FROM vehicles WHERE id = ?',
            [vehicleId]
        );
        if (!v) return null;

        // Exceção: grupo "Caminhões de Trecho" (Caminhão Prancha / Semirreboques)
        // pode deslocar até 2000 km entre abastecidas.
        const ODO_MAX_JUMP = vehicleGroups['Caminhões de Trecho']?.includes(v.tipo) ? 2000 : 1000;
        const HORI_MAX_JUMP = 50;

        const odo = odometro != null ? parseFloat(odometro) : NaN;
        const hori = horimetro != null ? parseFloat(horimetro) : NaN;
        const odoAtual = parseFloat(v.odoAtual || 0);
        const horiAtual = parseFloat(v.horiAtual || 0);

        if (!isNaN(odo) && odoAtual > 0) {
            if (odo < odoAtual) {
                return `Odômetro informado (${odo} Km) é inferior ao atual do veículo (${odoAtual} Km).`;
            }
            if (odo - odoAtual > ODO_MAX_JUMP) {
                return `Salto de odômetro excessivo: ${odo - odoAtual} Km (máx. ${ODO_MAX_JUMP} Km).`;
            }
        }
        if (!isNaN(hori) && horiAtual > 0) {
            if (hori < horiAtual) {
                return `Horímetro informado (${hori} Hr) é inferior ao atual do veículo (${horiAtual} Hr).`;
            }
            if (hori - horiAtual > HORI_MAX_JUMP) {
                return `Salto de horímetro excessivo: ${hori - horiAtual} Hr (máx. ${HORI_MAX_JUMP} Hr).`;
            }
        }
        return null;
    } catch (e) {
        // Antes o catch devolvia null, ou seja: falha de query virava "leitura
        // aprovada" e a ordem passava SEM validação nenhuma, em silêncio.
        // Falhar para o lado seguro: bloqueia e deixa o admin liberar na mão.
        console.error('[regrasAbastecimento] falha ao validar leitura:', e.message);
        return 'Não foi possível validar a leitura (falha ao consultar o veículo). Ordem retida para conferência.';
    }
};

// Quais colunas de valor de contrato existem em `obras` neste banco.
// Descoberto uma vez e memorizado.
//
// POR QUE: o código original fazia `SELECT valorContrato FROM obras`. Em banco
// onde essa coluna não existe (o de teste só tem `valorTotalContrato`), a query
// estourava ER_BAD_FIELD_ERROR e o `catch { return false; }` engolia o erro —
// resultado: a trava dos 20% NUNCA disparava, sem nenhum sinal no log.
let colunasContrato = null;
const resolverColunasContrato = async (connection) => {
    if (colunasContrato) return colunasContrato;
    const candidatas = ['valorTotalContrato', 'valorContrato'];
    try {
        const [linhas] = await connection.query(
            `SELECT COLUMN_NAME AS nome
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'obras'
                AND COLUMN_NAME IN (?, ?)`,
            candidatas
        );
        const existentes = linhas.map((l) => l.nome);
        // Ordem = precedência: valorTotalContrato vence, igual ao frontend
        // (`valorTotalContrato || valorContrato`).
        colunasContrato = candidatas.filter((c) => existentes.includes(c));
    } catch (e) {
        console.error('[regrasAbastecimento] falha ao inspecionar colunas de obras:', e.message);
        colunasContrato = [];
    }
    if (colunasContrato.length === 0) {
        console.warn('[regrasAbastecimento] tabela `obras` sem coluna de valor de contrato — trava dos 20% inativa.');
    }
    return colunasContrato;
};

/**
 * A obra já consumiu 20% ou mais do valor de contrato em combustível?
 *
 * @returns {Promise<boolean>}
 */
const checkOrcamentoBloqueado = async (connection, obraId) => {
    if (!obraId || obraId === 'Patio') return false;
    try {
        // Base do contrato: havia TRÊS definições diferentes para a mesma regra
        // dos 20% — aqui só `valorContrato`, em checkObraFuelPercent só
        // `valorTotalContrato`, e no frontend `valorTotalContrato || valorContrato`.
        // Unificado no critério do frontend, que é o mais abrangente, e só com as
        // colunas que existirem de fato neste banco.
        const colunas = await resolverColunasContrato(connection);
        if (colunas.length === 0) return false;

        const [[obraRow]] = await connection.execute(
            `SELECT ${colunas.join(', ')} FROM obras WHERE id = ?`, [obraId]
        );
        if (!obraRow) return false;

        let valorContrato = 0;
        for (const c of colunas) {
            const v = parseFloat(obraRow[c] || 0);
            if (v > 0) { valorContrato = v; break; }
        }
        if (!(valorContrato > 0)) return false;

        const [[expRow]] = await connection.execute(
            'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE obraId = ? AND category = "Combustível"',
            [obraId]
        );
        const totalGasto = parseFloat(expRow.total || 0);
        return totalGasto >= valorContrato * 0.20;
    } catch (e) {
        // Bloquear toda ordem por uma falha de query pararia a operação inteira,
        // então registramos alto e liberamos — a trava de leitura ainda vale.
        console.error('[regrasAbastecimento] falha ao validar orçamento da obra', obraId, ':', e.message);
        return false;
    }
};

/**
 * Já existe ordem em aberto para este veículo?
 *
 * A regra NUNCA ignora ordens reservadas: permitir uma 2ª ordem aberta no mesmo
 * veículo geraria risco de abastecimento duplo no posto.
 *
 * @param {object} opts { travar: boolean } — travar=true usa FOR UPDATE (só faz
 *        sentido dentro da transação que vai inserir; a IA lê sem travar).
 * @returns {Promise<{ordem, ocultaDeTerceiro}|null>} null se pode emitir
 */
const checkOrdemAbertaDuplicada = async (connection, vehicleId, ymdAbastecimento, opts = {}) => {
    if (!vehicleId) return null;

    const [[v]] = await connection.execute(
        'SELECT permiteMultiplosAbastecimentos, isOutsourced FROM vehicles WHERE id = ?',
        [vehicleId]
    );
    if (!v) return null;

    const allowMultiple = v.permiteMultiplosAbastecimentos == 1 || v.permiteMultiplosAbastecimentos === true;
    const isOutsourced = v.isOutsourced == 1 || v.isOutsourced === true;

    // Fim de semana / feriado, veículo fictício e terceirizado dispensam a trava.
    if (ehFimDeSemanaOuFeriado(ymdAbastecimento) || allowMultiple || isOutsourced) return null;

    const placeholders = STATUS_ORDEM_ENCERRADA.map(() => '?').join(',');
    const [openRows] = await connection.execute(
        `SELECT id, authNumber, status, is_hidden, hidden_by_user_id
           FROM refuelings
          WHERE vehicleId = ?
            AND status NOT IN (${placeholders})
          LIMIT 1
          ${opts.travar ? 'FOR UPDATE' : ''}`,
        [vehicleId, ...STATUS_ORDEM_ENCERRADA]
    );
    if (openRows.length === 0) return null;

    const ordem = openRows[0];
    return {
        ordem,
        // Ordem reservada de OUTRO usuário não pode ter número nem status
        // revelados na mensagem de erro.
        ocultaDeTerceiro: ordem.is_hidden == 1 && ordem.hidden_by_user_id !== opts.usuarioId,
    };
};

/**
 * Veículo está há mais de 7 dias na obra com operador "placeholder"
 * (COLABORADOR, TESTE, MAK SERVIÇOS…) em vez do operador real?
 *
 * @returns {Promise<{employeeName, diasNaObra}|null>}
 */
const checkOperadorPlaceholder = async (connection, vehicleId) => {
    if (!vehicleId) return null;

    const [[v]] = await connection.execute('SELECT isOutsourced FROM vehicles WHERE id = ?', [vehicleId]);
    // Terceirizados não usam nossa malha de alocação de operadores.
    if (!v || v.isOutsourced == 1 || v.isOutsourced === true) return null;

    const [linhas] = await connection.execute(
        `SELECT h.dataEntrada, e.nome AS employeeName
           FROM obras_historico_veiculos h
           INNER JOIN employees e ON e.id = h.employeeId
          WHERE h.veiculoId = ?
            AND h.dataSaida IS NULL
            AND e.isPlaceholder = 1
            AND h.dataEntrada <= DATE_SUB(NOW(), INTERVAL 7 DAY)
          ORDER BY h.dataEntrada ASC
          LIMIT 1`,
        [vehicleId]
    );
    if (linhas.length === 0) return null;

    return {
        employeeName: linhas[0].employeeName,
        diasNaObra: Math.floor((Date.now() - new Date(linhas[0].dataEntrada).getTime()) / 86400000),
    };
};

module.exports = {
    FERIADOS_BR_FIXOS,
    resolverColunasContrato,
    STATUS_ORDEM_ENCERRADA,
    ehFimDeSemanaOuFeriado,
    checkLeituraBloqueada,
    checkOrcamentoBloqueado,
    checkOrdemAbertaDuplicada,
    checkOperadorPlaceholder,
};
