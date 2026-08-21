// services/vehicleStateService.js
//
// Transições de estado do veículo (saída de obra, entrada e saída de
// manutenção) como funções que recebem a `connection` e NÃO abrem transação
// nem respondem HTTP.
//
// Por que existe: o fechamento de um relato de ocorrência precisa, na MESMA
// transação, tirar o equipamento da obra, colocá-lo em manutenção e gerar as
// ordens de serviço. Chamar os próprios endpoints por HTTP daria duas
// transações independentes — uma falha na entrada em manutenção deixaria o
// veículo desalocado pela metade, sem obra e sem oficina.
//
// Os handlers de vehicleController agora são wrappers finos sobre estas
// funções; o comportamento dos endpoints não mudou.
//
// ORDEM IMPORTA: `deallocateFromObraTx` antes de `startMaintenanceTx`.
// startMaintenance fecha TODOS os vehicle_history abertos e zera obraAtualId,
// mas não toca em obras_historico_veiculos — se rodasse primeiro, a saída de
// obra não acharia mais o histórico e a estadia ficaria com dataSaida NULL
// para sempre.

const { closeActivePeriod: closeComboioPeriod } = require('../utils/comboioPeriodo');
const { updateVehicleReading } = require('../utils/updateVehicleReading');

const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field;
    if (typeof field === 'string' && (field.startsWith('{') || field.startsWith('['))) {
        try {
            const parsed = JSON.parse(field);
            return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
        } catch (e) {
            console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'.`);
            return defaultValue;
        }
    }
    return defaultValue;
};

/** Estadia em obra ainda aberta (dataSaida IS NULL), ou null. */
const getActiveObraAllocation = async (connection, vehicleId) => {
    const [rows] = await connection.execute(
        `SELECT h.*, o.nome AS obraNome
           FROM obras_historico_veiculos h
           LEFT JOIN obras o ON o.id = h.obraId
          WHERE h.veiculoId = ? AND h.dataSaida IS NULL
          ORDER BY h.dataEntrada DESC
          LIMIT 1`,
        [vehicleId]
    );
    return rows[0] || null;
};

/**
 * Saída de obra. Fecha vehicle_history e obras_historico_veiculos, libera o
 * operador, atualiza a leitura e, se for comboio, fecha o período na obra.
 *
 * @param {object}  connection  conexão JÁ em transação
 * @param {string}  vehicleId
 * @param {object}  opts
 * @param {boolean} opts.protegerLeitura  quando true usa updateVehicleReading
 *        (só grava se a leitura for maior que a atual) em vez de sobrescrever.
 *        O endpoint legado passa false para manter o comportamento de sempre.
 * @returns {{obraId: string|null, employeeIdReleased: string|null, hadActiveAllocation: boolean}}
 */
const deallocateFromObraTx = async (connection, vehicleId, {
    dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra, observacoes, obraId,
    protegerLeitura = false,
} = {}) => {
    const id = vehicleId;
    const exitTimestamp = new Date(dataSaida || new Date());
    const readingVal = parseFloat(readingValue) || 0;

    let targetObraId = obraId ? String(obraId) : null;
    if (!targetObraId) {
        const [vRows] = await connection.execute('SELECT obraAtualId FROM vehicles WHERE id = ?', [id]);
        if (vRows.length > 0) targetObraId = vRows[0].obraAtualId;
    }

    const [historyRows] = await connection.execute(
        'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
        [id, 'obra']
    );

    let employeeIdToRelease = null;
    const hadActiveAllocation = historyRows.length > 0;

    if (historyRows && historyRows.length > 0) {
        const activeHistory = historyRows[0];
        const historyDetails = parseJsonSafe(activeHistory.details, 'history.details') || {};
        employeeIdToRelease = historyDetails.employeeId;

        if (!targetObraId && historyDetails.obraId) targetObraId = String(historyDetails.obraId);

        const newDetails = {
            ...historyDetails,
            [`${readingType}Saida`]: readingVal,
            observacoesSaida: observacoes,
        };

        await connection.execute(
            'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
            [exitTimestamp, JSON.stringify(newDetails), activeHistory.id]
        );
    }

    const vehicleUpdateData = {
        obraAtualId: null,
        status: 'Disponível',
        localizacaoAtual: location || 'Pátio',
        alocadoEm: null,
    };
    // O endpoint legado sobrescreve a leitura direto. No fluxo do relato a
    // leitura vem de uma ficha de papel preenchida dias antes, então gravar
    // sem checar rebaixaria o odômetro do equipamento — daí protegerLeitura.
    if (!protegerLeitura) {
        vehicleUpdateData[readingType] = readingVal;
    }

    const updateFields = Object.keys(vehicleUpdateData);
    const updateValues = Object.values(vehicleUpdateData);
    const setClause = updateFields.map(field => `${field} = ?`).join(', ');

    await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

    if (protegerLeitura && readingVal > 0) {
        const [[v]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [id]);
        await updateVehicleReading(connection, id, v?.tipo, readingVal, readingType);
    }

    if (employeeIdToRelease) {
        try {
            await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdToRelease]);
        } catch (e) { console.warn('Erro ao liberar funcionário', e.message); }
    }

    if (targetObraId) {
        const obraHistoryUpdateFields = ['dataSaida = ?'];
        const obraHistoryUpdateValues = [exitTimestamp];

        if (readingType === 'odometro') {
            obraHistoryUpdateFields.push('odometroSaida = ?');
            obraHistoryUpdateValues.push(readingVal);
        } else {
            obraHistoryUpdateFields.push('horimetroSaida = ?');
            obraHistoryUpdateValues.push(readingVal);
        }

        if (observacoes) {
            obraHistoryUpdateFields.push('observacoes = CONCAT(COALESCE(observacoes, ""), " | Saída: ", ?)');
            obraHistoryUpdateValues.push(observacoes);
        }

        obraHistoryUpdateValues.push(id);
        obraHistoryUpdateValues.push(targetObraId);

        await connection.execute(
            `UPDATE obras_historico_veiculos
                SET ${obraHistoryUpdateFields.join(', ')}
              WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
            obraHistoryUpdateValues
        );
    }

    if (shouldFinalizeObra && targetObraId) {
        await connection.execute(
            'UPDATE obras SET status = ?, dataFim = ? WHERE id = ?',
            ['finalizada', new Date(dataFimObra || new Date()), targetObraId]
        );
    }

    // Fase 2.6 — Se for comboio, fecha o período de obra ativo
    try {
        const [[vRow]] = await connection.execute('SELECT isComboioVehicle FROM vehicles WHERE id = ?', [id]);
        if (vRow && (vRow.isComboioVehicle == 1 || vRow.isComboioVehicle === true)) {
            await closeComboioPeriod(connection, id, exitTimestamp);
        }
    } catch (e) {
        console.warn('[comboioPeriodo closePeriod deallocateFromObra]', e.message);
    }

    return { obraId: targetObraId, employeeIdReleased: employeeIdToRelease, hadActiveAllocation };
};

/**
 * Entrada em manutenção. Fecha TODOS os vehicle_history abertos, abre um do
 * tipo 'manutencao' e marca o veículo.
 */
const startMaintenanceTx = async (connection, vehicleId, { status, location } = {}) => {
    const id = vehicleId;
    const now = new Date();

    await connection.execute(
        'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
        [now, id]
    );

    const newHistoryEntry = {
        vehicleId: id,
        historyType: 'manutencao',
        startDate: now,
        endDate: null,
        details: JSON.stringify({ status, location }),
    };

    const historyFields = Object.keys(newHistoryEntry);
    const historyValues = Object.values(newHistoryEntry);
    const historyPlaceholders = historyFields.map(() => '?').join(', ');

    await connection.execute(
        `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
        historyValues
    );

    const maintenanceLocation = {
        type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
        details: location,
    };

    const vehicleUpdateData = {
        status,
        maintenanceLocation: JSON.stringify(maintenanceLocation),
        obraAtualId: null,
        operationalAssignment: null,
        alocadoEm: JSON.stringify({ type: 'manutencao', location, status }),
    };

    const updateFields = Object.keys(vehicleUpdateData);
    const updateValues = Object.values(vehicleUpdateData);
    const setClause = updateFields.map(field => `${field} = ?`).join(', ');

    await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

    return { status, location };
};

/** Fim da manutenção: fecha o histórico aberto e devolve o veículo à frota. */
const endMaintenanceTx = async (connection, vehicleId, { location } = {}) => {
    const id = vehicleId;
    const now = new Date();

    await connection.execute(
        'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
        [now, id, 'manutencao']
    );

    const vehicleUpdateData = {
        status: 'Disponível',
        maintenanceLocation: null,
        localizacaoAtual: location,
        alocadoEm: null,
    };

    const updateFields = Object.keys(vehicleUpdateData);
    const updateValues = Object.values(vehicleUpdateData);
    const setClause = updateFields.map(field => `${field} = ?`).join(', ');

    await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

    return { status: 'Disponível', location };
};

module.exports = {
    getActiveObraAllocation,
    deallocateFromObraTx,
    startMaintenanceTx,
    endMaintenanceTx,
};
