// scripts/test-periodos-obra.js
//
// Verifica a regra "um veículo não fica em duas obras no mesmo dia"
// (utils/periodosObra.js) nos endpoints de alocação, desalocação e edição de
// histórico. Usa o caso real que originou a regra — ACL-7D30 em Mata (SEDUR)
// até 10/08 e Mata (SEAPI) desde 05/08 — e restaura as linhas tocadas no fim.
// Rodar SÓ contra o banco local (.env.local).
//
//   node scripts/test-periodos-obra.js
require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.local', override: true, quiet: true });

const db = require('../database');
const vehicleController = require('../controllers/vehicleController');
const obraController = require('../controllers/obraController');
const { diaCivil, sobrepoe, listarSobreposicoes } = require('../utils/periodosObra');

const PLACA = 'ACL-7D30';

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

const call = (handler, ctx = {}) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(d) { resolve({ status: this.statusCode, body: d }); return this; },
        end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    handler({ params: {}, body: {}, user: { id: 1, role: 'admin' }, io: { emit() {} }, ...ctx }, res);
});

(async () => {
    // --- Funções puras -----------------------------------------------------
    check('diaCivil 00:00 BRT', diaCivil(new Date('2026-08-10T03:00:00Z')), '2026-08-10');
    check('diaCivil 21:00 BRT da véspera (new Date("AAAA-MM-DD"))', diaCivil(new Date('2026-08-10')), '2026-08-10');
    check('diaCivil string AAAA-MM-DD', diaCivil('2026-08-02'), '2026-08-02');
    check('diaCivil vazio', diaCivil(''), null);
    check('troca no mesmo dia não é sobreposição',
        sobrepoe({ inicio: '2026-07-17', fim: '2026-08-04' }, { inicio: '2026-08-04', fim: null }), false);
    check('um dia em comum é sobreposição',
        sobrepoe({ inicio: '2026-07-17', fim: '2026-08-05' }, { inicio: '2026-08-04', fim: null }), true);
    check('dois períodos abertos se sobrepõem',
        sobrepoe({ inicio: '2026-08-01', fim: null }, { inicio: '2026-09-01', fim: null }), true);

    // --- Integração (banco local) -------------------------------------------
    const [[veh]] = await db.query('SELECT * FROM vehicles WHERE placa = ?', [PLACA]);
    if (!veh) { console.log(`Veículo ${PLACA} não existe neste banco — pulando integração.`); return; }

    const [hist] = await db.query(
        `SELECT h.*, o.orgao_contratante FROM obras_historico_veiculos h JOIN obras o ON o.id = h.obraId
          WHERE h.veiculoId = ? ORDER BY h.dataEntrada`, [veh.id]);
    const sedur = hist.find(h => h.orgao_contratante === 'SEDUR' && h.dataSaida);
    const seapi = hist.find(h => h.orgao_contratante === 'SEAPI' && !h.dataSaida);
    if (!sedur || !seapi) { console.log('Histórico do ACL-7D30 diferente do esperado — pulando integração.'); return; }

    // Snapshot para restaurar
    const [vhSnap] = await db.query('SELECT * FROM vehicle_history WHERE vehicleId = ?', [veh.id]);
    const [[empSnap]] = seapi.employeeId
        ? await db.query('SELECT id, alocadoEm FROM employees WHERE id = ?', [seapi.employeeId]) : [[null]];
    const vehSnap = { ...veh };

    try {
        const antes = await listarSobreposicoes(db);
        check('auditoria acusa o ACL-7D30', antes.some(s => s.veiculoId === veh.id), true);

        // 1) Alocar enquanto a estadia na SEAPI está aberta → 409
        const [[outraObra]] = await db.query("SELECT id FROM obras WHERE id NOT IN (?, ?) AND status = 'ativa' LIMIT 1", [sedur.obraId, seapi.obraId]);
        const r1 = await call(vehicleController.allocateToObra, {
            params: { id: veh.id },
            body: { obraId: outraObra.id, employeeId: seapi.employeeId || 1, dataEntrada: '2026-09-01', readingType: 'odometro', readingValue: 1 },
        });
        check('alocar com estadia aberta → 409', r1.status, 409);
        check('409 traz code PERIODO_SOBREPOSTO', r1.body?.code, 'PERIODO_SOBREPOSTO');
        check('409 lista a obra em conflito', (r1.body?.conflicts || []).map(c => c.historyId).includes(seapi.id), true);
        const [[vDepois]] = await db.query('SELECT obraAtualId FROM vehicles WHERE id = ?', [veh.id]);
        check('alocação recusada não mexe no veículo', vDepois.obraAtualId, veh.obraAtualId);

        // 2) Esticar a SEDUR até 20/08 (cresce e invade a SEAPI) → 409
        const r2 = await call(obraController.updateObraHistoryEntry, {
            params: { obraId: sedur.obraId, historyId: sedur.id },
            body: { dataSaida: '2026-08-20' },
        });
        check('esticar período sobre outra obra → 409', r2.status, 409);

        // 3) Aumentar a SEAPI para trás (01/08) mantendo a SEDUR até 10/08 → 409
        const r3 = await call(obraController.updateObraHistoryEntry, {
            params: { obraId: seapi.obraId, historyId: seapi.id },
            body: { dataEntrada: '2026-08-01' },
        });
        check('antecipar entrada sobre outra obra → 409', r3.status, 409);

        // 4) Só trocar/confirmar operador na SEAPI (datas iguais) → 200 mesmo com legado sobreposto
        const r4 = await call(obraController.updateObraHistoryEntry, {
            params: { obraId: seapi.obraId, historyId: seapi.id },
            body: { employeeId: seapi.employeeId },
        });
        check('editar sem mudar datas não é barrado pelo legado', r4.status, 200);
        const [[seapi4]] = await db.query('SELECT * FROM obras_historico_veiculos WHERE id = ?', [seapi.id]);
        check('edição parcial preserva dataEntrada', diaCivil(seapi4.dataEntrada), diaCivil(seapi.dataEntrada));
        check('edição parcial preserva horímetro/odômetro',
            [seapi4.odometroEntrada, seapi4.horimetroEntrada], [seapi.odometroEntrada, seapi.horimetroEntrada]);

        // 5) A correção real: saída da SEDUR em 02/08 → 200
        const r5 = await call(obraController.updateObraHistoryEntry, {
            params: { obraId: sedur.obraId, historyId: sedur.id },
            body: { dataSaida: '2026-08-02' },
        });
        check('corrigir saída para 02/08 → 200', r5.status, 200);
        const [[sedur5]] = await db.query('SELECT * FROM obras_historico_veiculos WHERE id = ?', [sedur.id]);
        check('SEDUR agora termina em 02/08', diaCivil(sedur5.dataSaida), '2026-08-02');
        check('edição parcial preserva operador', sedur5.employeeId, sedur.employeeId);
        const [[vh5]] = await db.query(
            "SELECT endDate FROM vehicle_history WHERE vehicleId = ? AND historyType = 'obra' AND startDate = ?",
            [veh.id, sedur5.dataEntrada]);
        check('vehicle_history acompanha a correção', diaCivil(vh5?.endDate), '2026-08-02');
        const depois = await listarSobreposicoes(db);
        check('auditoria não acusa mais o ACL-7D30', depois.some(s => s.veiculoId === veh.id), false);

        // 6) Desalocar com saída antes da entrada → 400, nada alterado
        const r6 = await call(vehicleController.deallocateFromObra, {
            params: { id: veh.id },
            body: { dataSaida: '2026-08-01', readingType: 'odometro', readingValue: 0, obraId: seapi.obraId },
        });
        check('saída antes da entrada → 400', r6.status, 400);
        const [[seapi6]] = await db.query('SELECT dataSaida FROM obras_historico_veiculos WHERE id = ?', [seapi.id]);
        check('desalocação recusada mantém estadia aberta', seapi6.dataSaida, null);
    } finally {
        // Restaura as linhas tocadas
        for (const h of hist) {
            await db.query(
                `UPDATE obras_historico_veiculos SET dataEntrada=?, dataSaida=?, employeeId=?, employeeName=?,
                        odometroEntrada=?, odometroSaida=?, horimetroEntrada=?, horimetroSaida=? WHERE id=?`,
                [h.dataEntrada, h.dataSaida, h.employeeId, h.employeeName, h.odometroEntrada, h.odometroSaida,
                    h.horimetroEntrada, h.horimetroSaida, h.id]);
        }
        for (const v of vhSnap) {
            await db.query('UPDATE vehicle_history SET startDate=?, endDate=?, details=? WHERE id=?',
                [v.startDate, v.endDate, typeof v.details === 'string' ? v.details : JSON.stringify(v.details), v.id]);
        }
        await db.query('UPDATE vehicles SET obraAtualId=?, status=?, alocadoEm=?, odometro=?, horimetro=? WHERE id=?',
            [vehSnap.obraAtualId, vehSnap.status,
                typeof vehSnap.alocadoEm === 'string' || vehSnap.alocadoEm === null ? vehSnap.alocadoEm : JSON.stringify(vehSnap.alocadoEm),
                vehSnap.odometro, vehSnap.horimetro, veh.id]);
        if (empSnap) {
            await db.query('UPDATE employees SET alocadoEm=? WHERE id=?',
                [typeof empSnap.alocadoEm === 'string' || empSnap.alocadoEm === null ? empSnap.alocadoEm : JSON.stringify(empSnap.alocadoEm), empSnap.id]);
        }
    }
})()
    .catch(err => out.push(`FAIL  exceção: ${err.stack}`))
    .finally(async () => {
        console.log(out.join('\n'));
        const falhas = out.filter(l => l.startsWith('FAIL')).length;
        console.log(`\n${out.length - falhas}/${out.length} ok`);
        await db.end();
        process.exit(falhas ? 1 : 0);
    });
