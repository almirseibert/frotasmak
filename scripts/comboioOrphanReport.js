// Relatório (SOMENTE LEITURA) de inconsistências do comboio.
//
// Uso:
//   node scripts/comboioOrphanReport.js            # resumo
//   node scripts/comboioOrphanReport.js --detalhe  # lista as linhas
//
// POR QUE EXISTE
// Até a revisão de 2026-09, excluir uma saída ou entrada de comboio apagava a
// linha de comboio_transactions mas deixava a cópia em `refuelings`. Essas
// cópias órfãs seguem aparecendo no histórico do veículo, entram na média de
// consumo e — no caso das entradas — na despesa mensal do posto.
//
// O código novo mantém as duas tabelas em sincronia, mas NÃO apaga órfãos
// antigos por conta própria: a decisão de limpar é humana. Este script só lista.
//
// Também compara o nível físico do tanque (vehicles.fuelLevels) com o saldo
// teórico (entradas + drenagens devolvidas − saídas).

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../database');
const { toComboioTankKey } = require('../utils/fuelTypes');

const detalhe = process.argv.includes('--detalhe');

(async () => {
    try {
        // Saídas: cópia com partner-espelho do comboio e sem movimentação que a referencie.
        const [saidasOrfas] = await db.query(`
            SELECT r.id, r.authNumber, r.data, r.vehicleId, r.litrosAbastecidos, r.partnerName
              FROM refuelings r
             WHERE r.partnerId LIKE 'comboio-%'
               AND r.drenagemTransactionId IS NULL
               AND NOT EXISTS (SELECT 1 FROM comboio_transactions ct WHERE ct.refuelingId = r.id)
               AND NOT EXISTS (
                    SELECT 1 FROM comboio_transactions ct
                     WHERE ct.type = 'saida' AND ct.authNumber = r.authNumber AND ct.receivingVehicleId = r.vehicleId
               )
             ORDER BY r.data DESC`);

        // Entradas: ordem marcada como entrada de comboio, concluída, sem espelho.
        const [entradasOrfas] = await db.query(`
            SELECT r.id, r.authNumber, r.data, r.vehicleId, r.litrosAbastecidos, r.partnerName
              FROM refuelings r
              JOIN vehicles v ON v.id = r.vehicleId AND v.isComboioVehicle = 1
             WHERE r.obraId IS NULL
               AND r.status = 'Concluída'
               AND r.drenagemTransactionId IS NULL
               AND (r.odometro IS NULL OR r.odometro = 0)
               AND (r.horimetro IS NULL OR r.horimetro = 0)
               AND NOT EXISTS (SELECT 1 FROM comboio_transactions ct WHERE ct.refuelingId = r.id)
               AND NOT EXISTS (
                    SELECT 1 FROM comboio_transactions ct
                     WHERE ct.type = 'entrada' AND ct.authNumber = r.authNumber AND ct.comboioVehicleId = r.vehicleId
               )
             ORDER BY r.data DESC`);

        // Movimentações ainda sem vínculo (o backfill não achou par único).
        const [semVinculo] = await db.query(`
            SELECT type, COUNT(*) AS qtd
              FROM comboio_transactions
             WHERE refuelingId IS NULL AND type IN ('entrada', 'saida') AND status = 'Concluída'
             GROUP BY type`);

        // Nível físico × saldo teórico.
        const [comboios] = await db.query(
            'SELECT id, registroInterno, fuelLevels FROM vehicles WHERE isComboioVehicle = 1 ORDER BY registroInterno'
        );
        const [teorico] = await db.query(`
            SELECT comboioVehicleId, fuelType,
                   SUM(CASE
                       WHEN type = 'entrada' AND status = 'Concluída' THEN liters
                       WHEN type = 'drenagem' AND COALESCE(destino, 'comboio') = 'comboio' THEN liters
                       WHEN type = 'saida' THEN -liters
                       ELSE 0 END) AS saldo
              FROM comboio_transactions
             WHERE comboioVehicleId IS NOT NULL
             GROUP BY comboioVehicleId, fuelType`);

        console.log('\n=== COMBOIO — relatório de inconsistências (somente leitura) ===\n');
        console.log(`Cópias de SAÍDA órfãs em refuelings:   ${saidasOrfas.length}`);
        console.log(`Cópias de ENTRADA órfãs em refuelings: ${entradasOrfas.length} (heurística: comboio, sem obra e sem leitura)`);
        console.log('Movimentações concluídas sem vínculo:', semVinculo.length
            ? semVinculo.map(s => `${s.type}=${s.qtd}`).join(', ') : 'nenhuma');

        console.log('\nTanque físico × saldo teórico:');
        for (const c of comboios) {
            let niveis = c.fuelLevels;
            if (typeof niveis === 'string') { try { niveis = JSON.parse(niveis); } catch { niveis = {}; } }
            niveis = niveis || {};
            const linhas = teorico.filter(t => t.comboioVehicleId === c.id);
            for (const key of ['dieselS10', 'dieselComum']) {
                const fisico = parseFloat(niveis[key]) || 0;
                const calc = linhas
                    .filter(t => toComboioTankKey(t.fuelType) === key)
                    .reduce((s, t) => s + (parseFloat(t.saldo) || 0), 0);
                const diff = fisico - calc;
                if (fisico || calc) {
                    const alerta = Math.abs(diff) > 5 ? '  ⚠️' : '';
                    console.log(`  ${c.registroInterno.padEnd(8)} ${key.padEnd(12)} físico ${fisico.toFixed(1).padStart(9)} L | teórico ${calc.toFixed(1).padStart(9)} L | diferença ${diff.toFixed(1).padStart(8)} L${alerta}`);
                }
            }
        }

        if (detalhe) {
            console.log('\n--- Saídas órfãs ---');
            console.table(saidasOrfas);
            console.log('\n--- Entradas órfãs ---');
            console.table(entradasOrfas);
        }
        console.log('\nNada foi alterado. Para limpar órfãos, avalie caso a caso.\n');
    } catch (e) {
        console.error('❌ Falha no relatório:', e.message);
        process.exitCode = 1;
    } finally {
        await db.end().catch(() => {});
    }
})();
