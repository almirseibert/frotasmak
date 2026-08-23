const crypto = require('crypto');
const consumo = require('./consumo');

// Faixa plausível de consumo por unidade. Serve de filtro contra erro de
// digitação de leitura, que é comum e silencioso: o RE616 tinha um odômetro
// gravado como 161795162280 (o valor anterior concatenado com o novo), gerando
// um intervalo de 161 bilhões de km e uma "média" de 3,98 bilhões de Km/L —
// o suficiente para estourar o DECIMAL(10,3) da coluna e abortar o UPSERT.
//
// Descartar o intervalo é melhor que gravar ou que falhar: os demais intervalos
// do veículo seguem válidos, e uma média envenenada faria o portão de média do
// aceite automático liberar (ou barrar) por um motivo inexistente.
//
// A faixa inicial (Km/L 0,1–100 · L/h 0,1–500) só pegava o absurdo aritmético.
// O backfill em produção mostrou que ela deixava passar dois erros de leitura
// bem mais comuns, e ambos envenenavam a média sem nenhum sinal:
//
//   - km gravado no campo de HORÍMETRO: delta enorme com litragem normal, e o
//     resultado cai entre 0,1 e 1 L/h. Deixou `Caminhão Carroceria` com média
//     de tipo de 0,687 L/h e `Caçamba` com 0,758 — fisicamente impossível.
//   - horímetro parado (ou quase) com tanque cheio: delta minúsculo, litragem
//     alta, resultado nas dezenas ou centenas. RE735 fechou em 250 L/h, RE786
//     em 178 e RE440 em 170, empurrando a média da Motoniveladora para 25,5
//     L/h quando a operação real gira em torno de 18.
//
// Os limites abaixo vêm da própria frota, com folga deliberada nas duas pontas:
// a maior média legítima observada é uma escavadeira em ~50 L/h e a menor é um
// caminhão pesado em ~1,4 Km/L; do lado do Km/L o teto precisa acomodar as motos
// (RE549 em 32,4 Km/L). Apertar mais do que isso começaria a descartar dado bom.
//
// Efeito de estreitar: o veículo cujo intervalo cai fora perde aquele intervalo e
// pode ficar com histórico insuficiente — o portão de média manda para o humano,
// que é o desfecho certo. Era o mesmo desfecho de antes (a média podre reprovava
// contra o cadastro), mas agora sem contaminar `avg_by_tipo` de toda a frota.
const FAIXA_PLAUSIVEL = {
    'Km/L': [0.5, 40],     // prancha carregada ~1,4 · moto ~32
    'L/Km': [0.025, 2],    // recíproco de Km/L
    'L/h':  [1, 60],       // retro ~4 · escavadeira grande ~50
    'h/L':  [1 / 60, 1],   // recíproco de L/h
};

const consumoPlausivel = (unidade, valor) => {
    const faixa = FAIXA_PLAUSIVEL[unidade];
    if (!faixa) return true;
    return valor >= faixa[0] && valor <= faixa[1];
};

/**
 * Recalcula as médias de consumo de combustível para um veículo e faz UPSERT em
 * vehicle_fuel_averages.
 *
 * Lógica:
 *  - Busca as últimas 4 ordens concluídas do veículo (precisa de 4 para calcular 3 intervalos)
 *  - Para cada par consecutivo, aplica computeConsumption na UNIDADE DO GRUPO
 *  - avg_last_1 = média do par mais recente, avg_last_2 = média dos 2 pares, avg_last_3 = 3 pares
 *  - avg_by_tipo / avg_by_subtipo = média dos veículos de mesmo tipo/sub_tipo NA MESMA UNIDADE
 *
 * ---------------------------------------------------------------------------
 * CORREÇÃO DE UNIDADE (era um bug silencioso)
 * ---------------------------------------------------------------------------
 * A versão anterior fazia `parseFloat(newer.odometro || newer.horimetro || 0)`
 * e devolvia sempre `diff / litros`. Isso tinha dois efeitos:
 *
 *   a) escolhia o odômetro sempre que ele fosse != 0, ignorando o tipo de leitura
 *      real do veículo (máquinas frequentemente têm os dois campos preenchidos);
 *   b) para grupos em L/h gravava o INVERSO (h/L). Uma motoniveladora que gasta
 *      17,5 L/h aparecia como 0,057 — e toda a UI rotula o campo como "L/h".
 *
 * Como consequência, `avg_by_tipo` fazia AVG() misturando linhas em Km/L com
 * linhas em h/L: o tipo `Cavalo` tinha avg_last_1 = 2,958 e avg_by_tipo = 0,094.
 *
 * Agora a leitura é escolhida pela unidade do grupo (tabela `vehicle_groups`,
 * via utils/consumo) e a unidade usada fica gravada na própria linha, tornando
 * o valor auto-descritivo. As agregações por tipo/sub_tipo filtram por unidade.
 *
 * @param {object} connection  - Conexão MySQL (pool ou transaction)
 * @param {string} vehicleId
 */
async function recalcFuelAverage(connection, vehicleId) {
    if (!vehicleId) return;

    // Dados do veículo
    const [[vehicle]] = await connection.execute(
        'SELECT tipo, sub_tipo FROM vehicles WHERE id = ?',
        [vehicleId]
    );
    if (!vehicle) return;

    // Unidade do grupo define tanto a fórmula quanto qual leitura usar.
    const unidade = await consumo.getUnidadeDoTipo(vehicle.tipo, connection);
    const campoLeitura = consumo.getReadingSourceForUnit(unidade); // 'odometro' | 'horimetro'

    // O nome da coluna entra interpolado no SQL (placeholder ? não vale para
    // identificador). A whitelist garante que continue não-injetável mesmo que
    // getReadingSourceForUnit passe a devolver outra coisa no futuro.
    if (campoLeitura !== 'odometro' && campoLeitura !== 'horimetro') {
        throw new Error(`[recalcFuelAverage] campo de leitura inesperado: ${campoLeitura}`);
    }

    // Últimas 4 ordens concluídas com leitura e litros registrados.
    // Ajustes de drenagem (litrosAbastecidos < 0, sem leitura) ficam de fora
    // por causa dos filtros — eles são tratados separadamente abaixo.
    // O filtro de leitura agora olha o campo CERTO para o tipo de veículo.
    const [orders] = await connection.execute(
        `SELECT id, odometro, horimetro, litrosAbastecidos, isFillUp, data
           FROM refuelings
          WHERE vehicleId = ?
            AND status = 'Concluída'
            AND litrosAbastecidos > 0
            AND ${campoLeitura} > 0
          ORDER BY data DESC
          LIMIT 4`,
        [vehicleId]
    );

    // Ajustes de drenagem (litros retirados do veículo). São negativos e não têm
    // leitura, então não entram como "pontos" do cálculo — apenas descontam a
    // litragem efetiva do intervalo onde ocorreram.
    const [drenagens] = await connection.execute(
        `SELECT litrosAbastecidos, data
           FROM refuelings
          WHERE vehicleId = ?
            AND drenagemTransactionId IS NOT NULL
            AND litrosAbastecidos < 0`,
        [vehicleId]
    );

    // Soma dos litros drenados (negativos) com older.data < data <= newer.data.
    const drenagemBetween = (olderData, newerData) => drenagens.reduce((sum, d) => {
        const dt = new Date(d.data).getTime();
        if (dt > new Date(olderData).getTime() && dt <= new Date(newerData).getTime()) {
            return sum + parseFloat(d.litrosAbastecidos || 0);
        }
        return sum;
    }, 0);

    // Precisa de pelo menos 2 registros para calcular 1 intervalo
    const avgLast = [null, null, null];
    let intervalosValidos = 0;
    let intervalosTanqueCheio = 0;
    let intervalosDescartados = 0;

    if (orders.length >= 2) {
        const intervals = [];
        for (let i = 0; i < orders.length - 1; i++) {
            const newer = orders[i];
            const older = orders[i + 1];
            const readingNewer = parseFloat(newer[campoLeitura] || 0);
            const readingOlder = parseFloat(older[campoLeitura] || 0);
            const diff = readingNewer - readingOlder;
            // Litragem efetiva = abastecido no intervalo menos o que foi drenado nele.
            const liters = parseFloat(newer.litrosAbastecidos || 0) + drenagemBetween(older.data, newer.data);

            const media = consumo.computeConsumption(unidade, diff, liters);
            if (media == null) continue;

            if (!consumoPlausivel(unidade, media)) {
                intervalosDescartados++;
                console.warn(
                    `[recalcFuelAverage] intervalo implausível descartado no veículo ${vehicleId}: `
                    + `${media.toFixed(3)} ${unidade} (delta=${diff}, litros=${liters}, ordem=${newer.id}). `
                    + 'Provável erro de digitação de leitura.'
                );
                continue;
            }

            intervals.push(media);
            // Um intervalo só é "tanque a tanque" quando os dois extremos foram
            // enchimentos completos. Serve de indicador de confiabilidade — o
            // cálculo em si continua usando todos os intervalos.
            if (newer.isFillUp == 1 && older.isFillUp == 1) intervalosTanqueCheio++;
        }

        intervalosValidos = intervals.length;

        // avg_last_1: só o intervalo mais recente
        if (intervals.length >= 1) avgLast[0] = round3(intervals[0]);
        // avg_last_2: média dos 2 mais recentes
        if (intervals.length >= 2) avgLast[1] = round3(avg(intervals.slice(0, 2)));
        // avg_last_3: média dos 3 mais recentes
        if (intervals.length >= 3) avgLast[2] = round3(avg(intervals.slice(0, 3)));
    }

    // Média por tipo — só entram linhas na MESMA unidade, senão o AVG soma
    // Km/L com h/L e devolve um número sem significado.
    const [[byTipo]] = await connection.execute(
        `SELECT AVG(avg_last_1) AS media
           FROM vehicle_fuel_averages
          WHERE vehicle_tipo = ? AND unidade = ? AND avg_last_1 IS NOT NULL`,
        [vehicle.tipo, unidade]
    );

    // Média por sub_tipo (só quando há sub_tipo definido)
    let avgBySubtipo = null;
    if (vehicle.sub_tipo) {
        const [[bySub]] = await connection.execute(
            `SELECT AVG(avg_last_1) AS media
               FROM vehicle_fuel_averages
              WHERE vehicle_sub_tipo = ? AND unidade = ? AND avg_last_1 IS NOT NULL`,
            [vehicle.sub_tipo, unidade]
        );
        if (bySub && bySub.media) avgBySubtipo = round3(parseFloat(bySub.media));
    }

    const lastRefuelingId = orders.length > 0 ? orders[0].id : null;
    const avgByTipoVal = (byTipo && byTipo.media) ? round3(parseFloat(byTipo.media)) : null;

    // UPSERT — `unidade` é sempre gravada, mesmo sem intervalos suficientes.
    // É ela que marca a linha como já migrada (o backfill procura unidade IS NULL).
    await connection.execute(
        `INSERT INTO vehicle_fuel_averages
           (id, vehicle_id, vehicle_tipo, vehicle_sub_tipo, last_refueling_id,
            avg_last_1, avg_last_2, avg_last_3, avg_by_tipo, avg_by_subtipo,
            unidade, intervalos_validos, intervalos_tanque_cheio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vehicle_tipo             = VALUES(vehicle_tipo),
           vehicle_sub_tipo         = VALUES(vehicle_sub_tipo),
           last_refueling_id        = VALUES(last_refueling_id),
           avg_last_1               = VALUES(avg_last_1),
           avg_last_2               = VALUES(avg_last_2),
           avg_last_3               = VALUES(avg_last_3),
           avg_by_tipo              = VALUES(avg_by_tipo),
           avg_by_subtipo           = VALUES(avg_by_subtipo),
           unidade                  = VALUES(unidade),
           intervalos_validos       = VALUES(intervalos_validos),
           intervalos_tanque_cheio  = VALUES(intervalos_tanque_cheio)`,
        [
            crypto.randomUUID(), vehicleId,
            vehicle.tipo, vehicle.sub_tipo || null, lastRefuelingId,
            avgLast[0], avgLast[1], avgLast[2],
            avgByTipoVal, avgBySubtipo,
            unidade, intervalosValidos, intervalosTanqueCheio,
        ]
    );
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

module.exports = { recalcFuelAverage };
