// services/comboioEstoqueService.js
//
// Estoque do comboio (vehicles.fuelLevels) e seus efeitos colaterais.
//
// Usado por dois controllers:
//   - comboioTransactionController: saída, drenagem, edição e exclusão;
//   - refuelingController: a ENTRADA do comboio passou a ser uma ordem ao posto
//     (refuelings.comboioEntrada = 1) e só mexe no tanque na baixa. Os ganchos da
//     baixa/edição/exclusão da ordem chamam syncEntrada/removeEntrada daqui.
//
// Regra de ouro: tudo roda DENTRO da transação do chamador, com a linha do
// comboio travada (FOR UPDATE) antes de ler o saldo — senão duas distribuições
// simultâneas liam o mesmo saldo e as duas passavam.

const crypto = require('crypto');
const { COMBOIO_TANK_KEYS, toComboioTankKey, priceKeysFor } = require('../utils/fuelTypes');
const { getActivePeriodId } = require('../utils/comboioPeriodo');

// Medidores analógicos e conversões geram sobras de fração de litro. Recusar
// por 0,2 L seria falso positivo.
const TOLERANCIA_SALDO_L = 1;

const STATUS_CONCLUIDA = 'Concluída';
const STATUS_BLOQUEADOS = ['BloqueadoLeitura', 'BloqueadoOrcamento'];

const isConcluida = (status) => status === 'Concluída' || status === 'Concluida';

const parseLevels = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw) || {}; } catch { return {}; }
};

// Trava e devolve a linha do comboio. Todas as leituras de saldo passam por aqui.
const lockComboio = async (conn, comboioVehicleId) => {
    if (!comboioVehicleId) return null;
    const [[v]] = await conn.execute(
        `SELECT id, registroInterno, placa, modelo, marca, fuelLevels, fuelCapacity, isComboioVehicle
           FROM vehicles WHERE id = ? FOR UPDATE`,
        [comboioVehicleId]
    );
    return v || null;
};

// Saldo do tanque na linha já travada. null = tanque nunca rastreado (comboio
// não inicializado) — nesse caso não bloqueamos a operação.
const getSaldoTanque = (vehicleRow, tankKey) => {
    if (!vehicleRow || !tankKey) return null;
    const levels = parseLevels(vehicleRow.fuelLevels);
    if (!(tankKey in levels) || levels[tankKey] === null) return null;
    const n = parseFloat(levels[tankKey]);
    return isNaN(n) ? null : n;
};

// Soma (delta > 0) ou subtrai (delta < 0) litros do tanque. As verificações de
// saldo acontecem ANTES, no chamador; o GREATEST(0) é só rede de segurança para
// não gravar negativo quando o admin força uma exclusão.
const ajustarTanque = async (conn, comboioVehicleId, tankKey, delta) => {
    if (!comboioVehicleId || !COMBOIO_TANK_KEYS.includes(tankKey)) return;
    const litros = parseFloat(delta);
    if (!litros) return;
    await conn.execute(
        `UPDATE vehicles
            SET fuelLevels = JSON_SET(
                COALESCE(fuelLevels, JSON_OBJECT()), ?,
                GREATEST(0, ROUND(COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?, 3))
            )
          WHERE id = ?`,
        [`$.${tankKey}`, `$.${tankKey}`, litros, comboioVehicleId]
    );
};

// Custo por litro do diesel que está no comboio: preço da última entrada
// concluída daquele tanque. Antes a saída usava a MÉDIA de preço de todos os
// postos cadastrados, que não tem relação com o diesel que realmente entrou.
// Fallbacks: mesmo tanque em qualquer comboio → média de preço cadastrado.
const getCustoUnitarioComboio = async (conn, comboioVehicleId, tankKey, atDate = new Date()) => {
    if (!tankKey) return 0;
    const sqlUltimaEntrada = (filtroComboio) => `
        SELECT COALESCE(NULLIF(pricePerLiter, 0), valorTotal / NULLIF(liters, 0)) AS preco
          FROM comboio_transactions
         WHERE type = 'entrada'
           AND status = 'Concluída'
           AND fuelType = ?
           AND date <= ?
           AND liters > 0
           AND (pricePerLiter > 0 OR valorTotal > 0)
           ${filtroComboio ? 'AND comboioVehicleId = ?' : ''}
         ORDER BY date DESC
         LIMIT 1`;

    if (comboioVehicleId) {
        const [[doComboio]] = await conn.execute(sqlUltimaEntrada(true), [tankKey, atDate, comboioVehicleId]);
        if (doComboio && parseFloat(doComboio.preco) > 0) return parseFloat(doComboio.preco);
    }
    const [[qualquer]] = await conn.execute(sqlUltimaEntrada(false), [tankKey, atDate]);
    if (qualquer && parseFloat(qualquer.preco) > 0) return parseFloat(qualquer.preco);

    const chaves = priceKeysFor(tankKey);
    if (chaves.length === 0) return 0;
    const [[media]] = await conn.query(
        `SELECT AVG(price) AS preco FROM partner_fuel_prices WHERE fuelType IN (?) AND price > 0`,
        [chaves]
    );
    return media && media.preco ? parseFloat(media.preco) : 0;
};

// Despesa mensal do posto referente ao diesel comprado para o comboio.
// obraId nulo = "Estoque Comboio" (o custo da obra entra na saída). A descrição
// é a mesma de sempre para que despesas existentes sejam atualizadas, e não
// duplicadas.
const updateEstoqueExpense = async (conn, obraId, partnerId, fuelType, dateInput) => {
    if (!partnerId || !fuelType || !dateInput) return;

    if (obraId) {
        const [obraCheck] = await conn.execute('SELECT id FROM obras WHERE id = ?', [obraId]);
        if (obraCheck.length === 0) return;
    }

    const dateObj = new Date(dateInput);
    const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
    const endDate = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0, 23, 59, 59);

    const [partners] = await conn.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';

    let querySum = `
        SELECT SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) +
            (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
            COALESCE(outrosValor, 0)
        ) AS total
          FROM refuelings
         WHERE partnerId = ?
           AND fuelType = ?
           AND status IN ('Concluída', 'Concluida')
           AND data BETWEEN ? AND ?`;
    const paramsSum = [partnerId, fuelType, startDate, endDate];
    if (obraId) {
        querySum += ' AND obraId = ?';
        paramsSum.push(obraId);
    } else {
        querySum += ' AND obraId IS NULL';
    }
    const [rows] = await conn.execute(querySum, paramsSum);
    const totalAmount = parseFloat(rows[0]?.total) || 0;

    const monthName = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const description = `Combustível: ${fuelType} - ${partnerName} (${monthName})`;

    let queryExisting = 'SELECT id FROM expenses WHERE description = ?';
    const paramsExisting = [description];
    if (obraId) {
        queryExisting += ' AND obraId = ?';
        paramsExisting.push(obraId);
    } else {
        queryExisting += ' AND obraId IS NULL';
    }
    const [existing] = await conn.execute(queryExisting, paramsExisting);

    if (totalAmount > 0) {
        if (existing.length > 0) {
            await conn.execute(
                'UPDATE expenses SET amount = ?, weekStartDate = ? WHERE id = ?',
                [totalAmount, startDate, existing[0].id]
            );
        } else {
            await conn.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, partnerName, fuelType)
                 VALUES (?, ?, ?, ?, 'Combustível', NOW(), ?, ?, ?)`,
                [crypto.randomUUID(), obraId || null, description, totalAmount, startDate, partnerName, fuelType]
            );
        }
    } else if (existing.length > 0) {
        await conn.execute('DELETE FROM expenses WHERE id = ?', [existing[0].id]);
    }
};

// ─── ENTRADA = ORDEM AO POSTO ──────────────────────────────────────────────
// Espelha a ordem de entrada (refuelings.comboioEntrada = 1) em
// comboio_transactions e no tanque. Idempotente: desfaz o efeito anterior e
// aplica o atual, então serve tanto para a baixa quanto para a edição depois
// da baixa. `previous` é a linha da ordem ANTES da alteração (para recalcular a
// despesa do mês/posto/combustível antigos quando mudarem).
const syncEntrada = async (conn, refuelingId, { actor = null, previous = null } = {}) => {
    const [[r]] = await conn.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [refuelingId]);
    if (!r || Number(r.comboioEntrada) !== 1) return null;

    await lockComboio(conn, r.vehicleId);
    const [[ct]] = await conn.execute(
        "SELECT * FROM comboio_transactions WHERE refuelingId = ? AND type = 'entrada' FOR UPDATE",
        [refuelingId]
    );

    if (ct && isConcluida(ct.status)) {
        await ajustarTanque(conn, ct.comboioVehicleId, toComboioTankKey(ct.fuelType), -(parseFloat(ct.liters) || 0));
    }

    const tankKey = toComboioTankKey(r.fuelType);
    let transactionId = ct?.id || null;

    if (isConcluida(r.status) && tankKey) {
        const litros = parseFloat(r.litrosAbastecidos) || 0;
        const preco = parseFloat(r.pricePerLiter) || 0;
        const valorTotal = Math.round(litros * preco * 100) / 100;

        if (ct) {
            await conn.execute(
                `UPDATE comboio_transactions
                    SET status = 'Concluída', authNumber = ?, date = ?, comboioVehicleId = ?,
                        partnerId = ?, partnerName = ?, employeeId = ?, liters = ?, fuelType = ?,
                        pricePerLiter = ?, valorTotal = ?, invoiceNumber = ?
                  WHERE id = ?`,
                [
                    r.authNumber, r.data, r.vehicleId, r.partnerId, r.partnerName, r.employeeId || null,
                    litros, tankKey, preco, valorTotal, r.invoiceNumber || null, ct.id,
                ]
            );
        } else {
            let periodoId = null;
            try { periodoId = await getActivePeriodId(conn, r.vehicleId); }
            catch (e) { console.warn('⚠️ [comboioEstoque] período ativo:', e.message); }

            transactionId = crypto.randomUUID();
            await conn.execute(
                `INSERT INTO comboio_transactions
                    (id, authNumber, type, status, date, comboioVehicleId, partnerId, partnerName,
                     obraName, obra_periodo_id, liters, fuelType, pricePerLiter, valorTotal,
                     responsibleUserEmail, createdByUserId, employeeId, invoiceNumber, refuelingId)
                 VALUES (?, ?, 'entrada', 'Concluída', ?, ?, ?, ?, 'Estoque Comboio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    transactionId, r.authNumber, r.data, r.vehicleId, r.partnerId, r.partnerName,
                    periodoId, litros, tankKey, preco, valorTotal,
                    actor?.email || actor?.userEmail || null, actor?.id != null ? String(actor.id) : null,
                    r.employeeId || null, r.invoiceNumber || null, refuelingId,
                ]
            );
        }
        await ajustarTanque(conn, r.vehicleId, tankKey, litros);
    } else if (ct) {
        await conn.execute('DELETE FROM comboio_transactions WHERE id = ?', [ct.id]);
        transactionId = null;
    }

    await updateEstoqueExpense(conn, null, r.partnerId, r.fuelType, r.data);
    const mesAno = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}`; };
    if (previous && (previous.partnerId !== r.partnerId || previous.fuelType !== r.fuelType
        || mesAno(previous.data) !== mesAno(r.data))) {
        await updateEstoqueExpense(conn, null, previous.partnerId, previous.fuelType, previous.data);
    }

    return { transactionId, tankKey };
};

// Chamado ANTES de apagar a ordem de entrada. Estorna o tanque e remove o
// espelho. Devolve { ok:false, status, body } se o estorno deixaria o tanque
// negativo (o diesel já foi distribuído) — só admin pode forçar.
const removeEntrada = async (conn, refueling, { force = false } = {}) => {
    const [[ct]] = await conn.execute(
        "SELECT * FROM comboio_transactions WHERE refuelingId = ? AND type = 'entrada' FOR UPDATE",
        [refueling.id]
    );
    if (!ct) return { ok: true, transaction: null };

    if (isConcluida(ct.status)) {
        const tankKey = toComboioTankKey(ct.fuelType);
        const litros = parseFloat(ct.liters) || 0;
        const v = await lockComboio(conn, ct.comboioVehicleId);
        const saldo = getSaldoTanque(v, tankKey);
        if (!force && saldo !== null && saldo - litros < -TOLERANCIA_SALDO_L) {
            return {
                ok: false,
                status: 409,
                body: {
                    error: `Excluir esta entrada deixaria o tanque negativo: saldo atual ${saldo.toFixed(2)} L, `
                        + `entrada de ${litros.toFixed(2)} L. O combustível já foi distribuído — `
                        + 'ajuste as saídas antes ou peça a um administrador para forçar.',
                    code: 'NEGATIVE_STOCK',
                    saldo,
                    litros,
                },
            };
        }
        await ajustarTanque(conn, ct.comboioVehicleId, tankKey, -litros);
    }

    await conn.execute('DELETE FROM comboio_transactions WHERE id = ?', [ct.id]);
    return { ok: true, transaction: ct };
};

module.exports = {
    TOLERANCIA_SALDO_L,
    STATUS_CONCLUIDA,
    STATUS_BLOQUEADOS,
    isConcluida,
    parseLevels,
    lockComboio,
    getSaldoTanque,
    ajustarTanque,
    getCustoUnitarioComboio,
    updateEstoqueExpense,
    syncEntrada,
    removeEntrada,
};
