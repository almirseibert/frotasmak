// scripts/test-relato-ciclo.js
//
// Fecha o ciclo: com o relato Em Execução, conclui as ordens e confere que os
// itens, o relato e o veículo acompanham. Testa também a guarda de "outro
// relato aberto no mesmo equipamento" — concluir um não pode liberar um
// equipamento ainda quebrado por outro.
//
//   node scripts/test-relato-ciclo.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../database');
const c = require('../controllers/relatoController');
const orderController = require('../controllers/orderController');
const { syncRelatoFromOrder } = require('../services/relatoStatusService');
const { OFICINA_INTERNA_PARTNER_ID } = require('../utils/ensureOficinaInternaPartner');

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

const call = (handler, ctx = {}) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        status(s) { this.statusCode = s; return this; },
        json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    Promise.resolve(handler({
        params: ctx.params || {}, query: {}, body: ctx.body || {},
        user: { id: 'test', email: 'teste@makservicos.com', user_type: 'admin' },
        io: { emit: () => {} },
    }, res)).catch(e => resolve({ status: 500, body: { error: e.message, stack: e.stack } }));
});

// Cria um relato já fechado, pronto para o ciclo.
const criarRelatoFechado = async (vehicleId, osMc, itens) => {
    const criado = await call(c.createRelato, {
        body: {
            relatorNome: 'Ciclo', vehicleId, dataRelato: '2026-08-06', status: 'Digitado',
            itens: itens.map((g, i) => ({
                itemComponente: `Item ${i + 1}`, descricaoProblema: 'defeito', gravidade: g,
            })),
        },
    });
    const det = await call(c.getRelatoById, { params: { id: criado.body.id } });
    const triagem = det.body.itens.map(i => ({ id: i.id, executorTipo: 'interno', valorEstimado: 100 }));
    const fech = await call(c.fecharRelato, {
        params: { id: criado.body.id },
        body: {
            osMc, dataBase: '2026-08-07', forcarLeitura: true,
            fazerSaidaObra: false, colocarEmManutencao: true, statusVeiculo: 'Em Manutenção',
            localManutencao: 'Pátio MAK Lajeado', itens: triagem,
        },
    });
    return { relatoId: criado.body.id, fech };
};

(async () => {
    let relatoA = null; let relatoB = null; let vehicleId = null; let snapshot = null;
    const ordensIds = [];
    try {
        const [[vehicle]] = await db.query(
            `SELECT id, status, odometro, horimetro, obraAtualId, localizacaoAtual
               FROM vehicles WHERE obraAtualId IS NULL AND (ativo = 1 OR ativo IS NULL) LIMIT 1`
        );
        vehicleId = vehicle.id; snapshot = { ...vehicle };

        // ── Relato A: 2 itens, ambos na oficina interna → 1 ordem ───────────
        const a = await criarRelatoFechado(vehicleId, 'MC-CICLO-A', ['A', 'C']);
        relatoA = a.relatoId;
        check('relato A fechado', a.fech.status, 201);
        check('relato A gerou 1 ordem (mesmo executor)', a.fech.body.ordens.length, 1);
        const ordemA = a.fech.body.ordens[0];
        ordensIds.push(ordemA.id);

        const [[vDepoisFech]] = await db.query('SELECT status FROM vehicles WHERE id = ?', [vehicleId]);
        check('equipamento em manutenção', vDepoisFech.status, 'Em Manutenção');

        // ── Relato B no MESMO equipamento, ainda aberto ─────────────────────
        const b = await criarRelatoFechado(vehicleId, 'MC-CICLO-B', ['B']);
        relatoB = b.relatoId;
        check('relato B fechado', b.fech.status, 201);
        ordensIds.push(...b.fech.body.ordens.map(o => o.id));

        // ── Concluir a ordem do relato A ────────────────────────────────────
        await db.query("UPDATE orders SET status = 'Concluída' WHERE id = ?", [ordemA.id]);
        const sync = await syncRelatoFromOrder(ordemA.id, null);
        check('propagação encontrou o relato', sync?.relatoId, relatoA);
        check('relato A concluído', sync?.relatoConcluido, true);

        const [itensA] = await db.query(
            'SELECT status, dataConclusaoReal FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoA]
        );
        check('itens do A concluídos', itensA.every(i => i.status === 'Concluído'), true);
        check('data de conclusão real gravada', itensA.every(i => i.dataConclusaoReal !== null), true);

        const [[relA]] = await db.query('SELECT status, concluidoEm FROM relatos_ocorrencia WHERE id = ?', [relatoA]);
        check('relato A marcado Concluído', relA.status, 'Concluído');
        check('concluidoEm preenchido', relA.concluidoEm !== null, true);

        // A GUARDA: o relato B ainda está aberto no mesmo equipamento.
        check('equipamento NÃO liberado (outro relato aberto)', sync?.veiculoLiberado, false);
        const [[vAindaMan]] = await db.query('SELECT status FROM vehicles WHERE id = ?', [vehicleId]);
        check('equipamento segue em manutenção', vAindaMan.status, 'Em Manutenção');

        // ── Concluir o relato B: agora sim libera ───────────────────────────
        const concl = await call(c.concluirRelato, {
            params: { id: relatoB },
            body: { providenciaAdotada: 'Serviço finalizado na oficina.', responsavelManutencao: 'Saulo' },
        });
        check('concluir relato B → 200', concl.status, 200);
        check('agora o equipamento é liberado', concl.body.veiculoLiberado, true);

        const [[vLivre]] = await db.query(
            'SELECT status, maintenanceLocation FROM vehicles WHERE id = ?', [vehicleId]
        );
        check('equipamento volta a Disponível', vLivre.status, 'Disponível');
        check('local de manutenção limpo', vLivre.maintenanceLocation, null);

        const [abertos] = await db.query(
            "SELECT id FROM vehicle_history WHERE vehicleId = ? AND historyType = 'manutencao' AND endDate IS NULL",
            [vehicleId]
        );
        check('histórico de manutenção fechado', abertos.length, 0);

        const [[relB]] = await db.query('SELECT status, providenciaAdotada FROM relatos_ocorrencia WHERE id = ?', [relatoB]);
        check('relato B Concluído', relB.status, 'Concluído');
        check('providência gravada', relB.providenciaAdotada, 'Serviço finalizado na oficina.');

        // ── Reconcluir é bloqueado ──────────────────────────────────────────
        const rec = await call(c.concluirRelato, { params: { id: relatoB }, body: {} });
        check('reconcluir → 409', rec.status, 409);

        // ── Cancelamento exige ordens fechadas ──────────────────────────────
        const cc = await criarRelatoFechado(vehicleId, 'MC-CICLO-C', ['C']);
        ordensIds.push(...cc.fech.body.ordens.map(o => o.id));
        const cancelBloqueado = await call(c.cancelarRelato, {
            params: { id: cc.relatoId }, body: { motivo: 'Teste' },
        });
        check('cancelar com ordem aberta → 409', cancelBloqueado.status, 409);
        check('mensagem orienta cancelar as ordens antes',
            /Cancele-as em Ordens/.test(cancelBloqueado.body.error), true);

        await db.query("UPDATE orders SET status = 'Cancelada' WHERE relatoId = ?", [cc.relatoId]);
        const cancelOk = await call(c.cancelarRelato, {
            params: { id: cc.relatoId }, body: { motivo: 'Equipamento vendido' },
        });
        check('cancelar com ordens fechadas → 200', cancelOk.status, 200);
        const [itensC] = await db.query(
            'SELECT status, motivoCancelamento FROM relato_ocorrencia_itens WHERE relatoId = ?', [cc.relatoId]
        );
        check('itens cancelados', itensC.every(i => i.status === 'Cancelado'), true);
        check('motivo registrado no item', itensC[0].motivoCancelamento, 'Equipamento vendido');

        await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [cc.relatoId]);
        await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [cc.relatoId]);
        await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [cc.relatoId]);

        // ── Ordem cancelada → item cancelado, não concluído ─────────────────
        const d = await criarRelatoFechado(vehicleId, 'MC-CICLO-D', ['C']);
        const ordemD = d.fech.body.ordens[0];
        ordensIds.push(ordemD.id);
        await db.query("UPDATE orders SET status = 'Cancelada' WHERE id = ?", [ordemD.id]);
        await syncRelatoFromOrder(ordemD.id, null);
        const [itensD] = await db.query('SELECT status FROM relato_ocorrencia_itens WHERE relatoId = ?', [d.relatoId]);
        check('ordem cancelada → item Cancelado (não Concluído)', itensD[0].status, 'Cancelado');

        await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [d.relatoId]);
        await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [d.relatoId]);
        await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [d.relatoId]);

        // ── updateOrder preserva o vínculo com relato/OS do MC ──────────────
        const e = await criarRelatoFechado(vehicleId, 'MC-CICLO-E', ['C']);
        const ordemE = e.fech.body.ordens[0];
        ordensIds.push(ordemE.id);
        const [[antes]] = await db.query('SELECT relatoId, osMc, tipo, origem FROM orders WHERE id = ?', [ordemE.id]);
        // Simula o modal genérico da OrdersPage, que não conhece esses campos.
        await call(orderController.updateOrder, {
            params: { id: ordemE.id },
            body: {
                supplierId: OFICINA_INTERNA_PARTNER_ID, supplier: 'MAK', status: 'Ativa',
                totalValue: 500, items: [{ quantity: 1, description: 'x', unitPrice: 500 }],
            },
        });
        const [[depois]] = await db.query('SELECT relatoId, osMc, tipo, origem FROM orders WHERE id = ?', [ordemE.id]);
        check('updateOrder preserva relatoId', depois.relatoId, antes.relatoId);
        check('updateOrder preserva osMc', depois.osMc, antes.osMc);
        check('updateOrder preserva origem', depois.origem, 'relato');
        check('updateOrder preserva tipo', depois.tipo, antes.tipo);

        await db.query('DELETE FROM expenses WHERE orderId = ?', [ordemE.id]);
        await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [e.relatoId]);
        await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [e.relatoId]);
        await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [e.relatoId]);
    } catch (err) {
        out.push(`FAIL  exceção: ${err.message}\n${err.stack}`);
    } finally {
        try {
            for (const rid of [relatoA, relatoB].filter(Boolean)) {
                await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [rid]);
                await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [rid]);
                await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [rid]);
            }
            if (ordensIds.length) {
                await db.query(`DELETE FROM expenses WHERE orderId IN (${ordensIds.map(() => '?').join(',')})`, ordensIds);
                await db.query(`DELETE FROM orders WHERE id IN (${ordensIds.map(() => '?').join(',')})`, ordensIds);
            }
            if (vehicleId && snapshot) {
                await db.query("DELETE FROM vehicle_history WHERE vehicleId = ? AND startDate >= NOW() - INTERVAL 10 MINUTE", [vehicleId]);
                await db.query(
                    'UPDATE vehicles SET status = ?, odometro = ?, horimetro = ?, obraAtualId = ?, localizacaoAtual = ?, maintenanceLocation = NULL, alocadoEm = NULL WHERE id = ?',
                    [snapshot.status, snapshot.odometro, snapshot.horimetro, snapshot.obraAtualId, snapshot.localizacaoAtual, vehicleId]
                );
            }
            console.log('(dados de teste removidos)\n');
        } catch (e) { console.warn('AVISO na limpeza:', e.message); }

        console.log(out.join('\n'));
        const falhas = out.filter(r => r.startsWith('FAIL')).length;
        console.log(falhas ? `\n>>> ${falhas} FALHA(S)` : '\n>>> TODOS OS TESTES PASSARAM');
        process.exit(falhas ? 1 : 0);
    }
})();
