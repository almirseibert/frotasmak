// scripts/test-vehicle-state.js
//
// Verifica que a extração para services/vehicleStateService.js NÃO mudou o
// comportamento dos endpoints de alocação/manutenção: aloca um veículo de
// teste numa obra, desaloca, manda para manutenção e finaliza, conferindo
// vehicle_history, obras_historico_veiculos, employees e vehicles em cada
// passo. Restaura o estado original do veículo no fim.
//
//   node scripts/test-vehicle-state.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../database');
const vehicleController = require('../controllers/vehicleController');
const {
    getActiveObraAllocation, deallocateFromObraTx, startMaintenanceTx, endMaintenanceTx,
} = require('../services/vehicleStateService');

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
    };
    Promise.resolve(handler({
        params: ctx.params || {}, query: {}, body: ctx.body || {},
        user: { id: 'test', email: 'teste@makservicos.com', user_type: 'admin' },
        io: { emit: () => {} },
    }, res)).catch(e => resolve({ status: 500, body: { error: e.message, stack: e.stack } }));
});

(async () => {
    let vehicleId = null;
    let snapshot = null;
    let employeeId = null;
    try {
        // Um veículo que NÃO esteja alocado, para não mexer em operação real.
        const [[vehicle]] = await db.query(
            `SELECT id, tipo, status, odometro, horimetro, obraAtualId, localizacaoAtual
               FROM vehicles
              WHERE obraAtualId IS NULL AND (ativo = 1 OR ativo IS NULL)
              LIMIT 1`
        );
        if (!vehicle) throw new Error('Nenhum veículo livre para testar.');
        vehicleId = vehicle.id;
        snapshot = { ...vehicle };

        const [[obra]] = await db.query("SELECT id, nome FROM obras LIMIT 1");
        if (!obra) throw new Error('Nenhuma obra para testar.');

        // allocateToObra exige um funcionário (vira o operador da estadia).
        const [[employee]] = await db.query('SELECT id, nome, alocadoEm FROM employees WHERE alocadoEm IS NULL LIMIT 1');
        if (!employee) throw new Error('Nenhum funcionário livre para testar.');
        employeeId = employee.id;
        console.log(`Veículo: ${vehicleId} | Obra: ${obra.nome} | Operador: ${employee.nome}\n`);

        const readingType = 'odometro';
        const leituraInicial = Number(vehicle.odometro) || 0;

        // ── Alocação (endpoint intocado, serve de setup) ─────────────────────
        const aloc = await call(vehicleController.allocateToObra, {
            params: { id: vehicleId },
            body: {
                obraId: obra.id, employeeId: employee.id, dataEntrada: new Date(), readingType,
                readingValue: leituraInicial + 10, observacoes: 'TESTE AUTOMATIZADO',
            },
        });
        check('alocar em obra → 200', aloc.status, 200);
        if (aloc.status !== 200) out.push(`      motivo: ${JSON.stringify(aloc.body)}`);

        const conn = await db.getConnection();
        const ativa = await getActiveObraAllocation(conn, vehicleId);
        conn.release();
        check('getActiveObraAllocation acha a estadia aberta', ativa?.obraId, obra.id);
        check('estadia traz o nome da obra', ativa?.obraNome, obra.nome);
        const estadiaId = ativa?.id;

        const [[vAloc]] = await db.query('SELECT obraAtualId, status FROM vehicles WHERE id = ?', [vehicleId]);
        check('veículo marcado na obra', vAloc.obraAtualId, obra.id);

        // ── Saída de obra pelo endpoint (agora um wrapper do service) ────────
        const desaloc = await call(vehicleController.deallocateFromObra, {
            params: { id: vehicleId },
            body: {
                dataSaida: new Date(), readingType, readingValue: leituraInicial + 50,
                location: 'Pátio MAK Lajeado', observacoes: 'TESTE saída',
            },
        });
        check('desalocar → 200', desaloc.status, 200);

        const [[vDes]] = await db.query(
            'SELECT obraAtualId, status, localizacaoAtual, odometro, alocadoEm FROM vehicles WHERE id = ?', [vehicleId]
        );
        check('obraAtualId zerado', vDes.obraAtualId, null);
        check('status volta para Disponível', vDes.status, 'Disponível');
        check('localizacaoAtual gravada', vDes.localizacaoAtual, 'Pátio MAK Lajeado');
        check('alocadoEm limpo', vDes.alocadoEm, null);
        check('leitura de saída gravada', Number(vDes.odometro), leituraInicial + 50);

        const [[hObra]] = await db.query(
            "SELECT endDate, details FROM vehicle_history WHERE vehicleId = ? AND historyType = 'obra' ORDER BY startDate DESC, id DESC LIMIT 1",
            [vehicleId]
        );
        check('vehicle_history de obra fechado', hObra.endDate !== null, true);
        const det = typeof hObra.details === 'string' ? JSON.parse(hObra.details) : hObra.details;
        check('leitura de saída no details', det.odometroSaida, leituraInicial + 50);
        check('observação de saída no details', det.observacoesSaida, 'TESTE saída');

        const [[vEmp]] = await db.query('SELECT alocadoEm FROM employees WHERE id = ?', [employeeId]);
        check('operador liberado na saída', vEmp.alocadoEm, null);

        // Busca a estadia EXATA criada acima. obras_historico_veiculos.id é um
        // UUID varchar, então ordenar por id não devolve a mais recente.
        const [[hEstadia]] = await db.query(
            'SELECT dataSaida, odometroSaida, observacoes FROM obras_historico_veiculos WHERE id = ?',
            [estadiaId]
        );
        check('obras_historico_veiculos fechado (dataSaida)', hEstadia.dataSaida !== null, true);
        check('odometroSaida na estadia', Number(hEstadia.odometroSaida), leituraInicial + 50);
        check('observação concatenada na estadia', /Saída: TESTE saída/.test(hEstadia.observacoes || ''), true);

        const conn2 = await db.getConnection();
        check('nenhuma estadia aberta sobrou', await getActiveObraAllocation(conn2, vehicleId), null);
        conn2.release();

        // ── Entrada em manutenção ───────────────────────────────────────────
        const startM = await call(vehicleController.startMaintenance, {
            params: { id: vehicleId },
            body: { status: 'Em Manutenção', location: 'Pátio MAK Lajeado' },
        });
        check('iniciar manutenção → 200', startM.status, 200);

        const [[vMan]] = await db.query(
            'SELECT status, maintenanceLocation, obraAtualId, alocadoEm FROM vehicles WHERE id = ?', [vehicleId]
        );
        check('status = Em Manutenção', vMan.status, 'Em Manutenção');
        const ml = typeof vMan.maintenanceLocation === 'string' ? JSON.parse(vMan.maintenanceLocation) : vMan.maintenanceLocation;
        check('pátio conhecido classificado como Pátio', ml.type, 'Pátio');
        check('detalhe do local preservado', ml.details, 'Pátio MAK Lajeado');

        const [[hMan]] = await db.query(
            "SELECT endDate FROM vehicle_history WHERE vehicleId = ? AND historyType = 'manutencao' ORDER BY id DESC LIMIT 1",
            [vehicleId]
        );
        check('histórico de manutenção aberto', hMan.endDate, null);

        // Local fora dos pátios conhecidos deve cair em 'Outros'.
        await call(vehicleController.startMaintenance, {
            params: { id: vehicleId },
            body: { status: 'Aguardando Manutenção', location: 'Oficina do Zé' },
        });
        const [[vMan2]] = await db.query('SELECT maintenanceLocation FROM vehicles WHERE id = ?', [vehicleId]);
        const ml2 = typeof vMan2.maintenanceLocation === 'string' ? JSON.parse(vMan2.maintenanceLocation) : vMan2.maintenanceLocation;
        check('local desconhecido classificado como Outros', ml2.type, 'Outros');

        // ── Fim da manutenção ───────────────────────────────────────────────
        const endM = await call(vehicleController.endMaintenance, {
            params: { id: vehicleId },
            body: { location: 'Pátio MAK Lajeado' },
        });
        check('finalizar manutenção → 200', endM.status, 200);

        const [[vFim]] = await db.query(
            'SELECT status, maintenanceLocation, localizacaoAtual FROM vehicles WHERE id = ?', [vehicleId]
        );
        check('status volta para Disponível', vFim.status, 'Disponível');
        check('maintenanceLocation limpo', vFim.maintenanceLocation, null);

        const [abertos] = await db.query(
            "SELECT id FROM vehicle_history WHERE vehicleId = ? AND endDate IS NULL", [vehicleId]
        );
        check('nenhum histórico aberto no fim', abertos.length, 0);

        // ── protegerLeitura: novidade usada pelo fechamento do relato ────────
        const conn3 = await db.getConnection();
        await conn3.beginTransaction();
        const [[vAntes]] = await conn3.execute('SELECT odometro FROM vehicles WHERE id = ?', [vehicleId]);
        await deallocateFromObraTx(conn3, vehicleId, {
            dataSaida: new Date(), readingType, readingValue: 1, // leitura MENOR de propósito
            location: 'Pátio', protegerLeitura: true,
        });
        const [[vDepois]] = await conn3.execute('SELECT odometro FROM vehicles WHERE id = ?', [vehicleId]);
        check('protegerLeitura impede regressão do odômetro', Number(vDepois.odometro), Number(vAntes.odometro));
        await conn3.rollback();
        conn3.release();

        // Sem a proteção (comportamento legado), a leitura é sobrescrita.
        const conn4 = await db.getConnection();
        await conn4.beginTransaction();
        await deallocateFromObraTx(conn4, vehicleId, {
            dataSaida: new Date(), readingType, readingValue: 1, location: 'Pátio',
        });
        const [[vLegado]] = await conn4.execute('SELECT odometro FROM vehicles WHERE id = ?', [vehicleId]);
        check('sem proteção, comportamento legado sobrescreve', Number(vLegado.odometro), 1);
        await conn4.rollback();
        conn4.release();

        // ── As funções Tx compõem numa transação só ─────────────────────────
        const conn5 = await db.getConnection();
        await conn5.beginTransaction();
        await startMaintenanceTx(conn5, vehicleId, { status: 'Em Manutenção', location: 'Pátio MAK Lajeado' });
        await endMaintenanceTx(conn5, vehicleId, { location: 'Pátio MAK Lajeado' });
        const [[vTx]] = await conn5.execute('SELECT status FROM vehicles WHERE id = ?', [vehicleId]);
        check('start + end na mesma transação', vTx.status, 'Disponível');
        await conn5.rollback();
        conn5.release();
        check('rollback desfez tudo',
            (await db.query('SELECT status FROM vehicles WHERE id = ?', [vehicleId]))[0][0].status, 'Disponível');
    } catch (e) {
        out.push(`FAIL  exceção: ${e.message}\n${e.stack}`);
    } finally {
        // Limpeza: remove os registros de teste e restaura o veículo.
        if (vehicleId && snapshot) {
            await db.query("DELETE FROM vehicle_history WHERE vehicleId = ? AND (JSON_EXTRACT(details,'$.observacoes') LIKE '%TESTE AUTOMATIZADO%' OR JSON_EXTRACT(details,'$.observacoesSaida') LIKE '%TESTE saída%')", [vehicleId]);
            await db.query("DELETE FROM obras_historico_veiculos WHERE veiculoId = ? AND observacoes LIKE '%TESTE AUTOMATIZADO%'", [vehicleId]);
            await db.query("DELETE FROM vehicle_history WHERE vehicleId = ? AND historyType = 'manutencao' AND JSON_EXTRACT(details,'$.location') IN ('Pátio MAK Lajeado','Oficina do Zé') AND startDate >= NOW() - INTERVAL 10 MINUTE", [vehicleId]);
            await db.query(
                'UPDATE vehicles SET status = ?, odometro = ?, horimetro = ?, obraAtualId = ?, localizacaoAtual = ?, maintenanceLocation = NULL, alocadoEm = NULL WHERE id = ?',
                [snapshot.status, snapshot.odometro, snapshot.horimetro, snapshot.obraAtualId, snapshot.localizacaoAtual, vehicleId]
            );
            console.log('(estado original do veículo restaurado)\n');
        }
        if (employeeId) await db.query('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeId]);
        console.log(out.join('\n'));
        const falhas = out.filter(r => r.startsWith('FAIL')).length;
        console.log(falhas ? `\n>>> ${falhas} FALHA(S)` : '\n>>> TODOS OS TESTES PASSARAM');
        process.exit(falhas ? 1 : 0);
    }
})();
