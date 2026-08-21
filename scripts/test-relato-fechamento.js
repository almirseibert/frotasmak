// scripts/test-relato-fechamento.js
//
// Teste ponta a ponta do cenário do processo:
//   1. equipamento alocado numa obra
//   2. relato com 5 itens: 2 na Oficina X (um deles gravidade A), 2 na MAK
//      interna, 1 no Fornecedor Y
//   3. fechar informando a OS do MC, com saída de obra e manutenção
//   4. conferir ordens, vínculos, estado do veículo, cronograma e idempotência
//
// Cria e apaga tudo o que usa (inclusive dois fornecedores de teste).
//
//   node scripts/test-relato-fechamento.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../database');
const crypto = require('crypto');
const c = require('../controllers/relatoController');
const vehicleController = require('../controllers/vehicleController');
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
        user: { id: 'test-user', email: 'teste@makservicos.com', user_type: 'admin' },
        io: { emit: () => {} },
    }, res)).catch(e => resolve({ status: 500, body: { error: e.message, stack: e.stack } }));
});

const OFICINA_X = 'teste-oficina-x';
const FORNEC_Y = 'teste-fornecedor-y';
const OS_MC = 'MC-2026-4471';

(async () => {
    let relatoId = null; let vehicleId = null; let snapshot = null; let employeeId = null;
    let feriadoId = null; let ordensIds = [];
    try {
        // ── Setup ───────────────────────────────────────────────────────────
        await db.query(
            `INSERT INTO partners (id, razaoSocial, nomeFantasia, tipo_parceiro, is_oficina, status_operacional)
             VALUES (?, 'OFICINA X LTDA', 'Oficina X', 'fornecedor', 1, 'ATIVO'),
                    (?, 'FORNECEDOR Y LTDA', 'Fornecedor Y', 'fornecedor', 0, 'ATIVO')
             ON DUPLICATE KEY UPDATE razaoSocial = VALUES(razaoSocial)`,
            [OFICINA_X, FORNEC_Y]
        );

        const [[vehicle]] = await db.query(
            `SELECT id, tipo, status, odometro, horimetro, obraAtualId, localizacaoAtual
               FROM vehicles WHERE obraAtualId IS NULL AND (ativo = 1 OR ativo IS NULL) LIMIT 1`
        );
        vehicleId = vehicle.id; snapshot = { ...vehicle };
        const [[obra]] = await db.query('SELECT id, nome FROM obras LIMIT 1');
        const [[emp]] = await db.query('SELECT id, nome FROM employees WHERE alocadoEm IS NULL LIMIT 1');
        employeeId = emp.id;

        const alocRes = await call(vehicleController.allocateToObra, {
            params: { id: vehicleId },
            body: {
                obraId: obra.id, employeeId: emp.id, dataEntrada: new Date(),
                readingType: 'odometro', readingValue: Number(vehicle.odometro) || 0,
                observacoes: 'TESTE FECHAMENTO',
            },
        });
        check('setup: equipamento alocado em obra', alocRes.status, 200);

        // Feriado na segunda 10/08/2026 para provar que o prazo o despreza.
        const [fer] = await db.query(
            "INSERT INTO admin_holidays (name, date, regiao) VALUES ('TESTE Feriado', '2026-08-10', '')"
        );
        feriadoId = fer.insertId;
        require('../utils/businessDays').invalidateHolidayCache();

        // ── 1. Relato com 5 itens ───────────────────────────────────────────
        const criado = await call(c.createRelato, {
            body: {
                relatorNome: 'João Operador', relatorFuncao: 'Operador', filialCidade: 'Lajeado',
                dataRelato: '2026-08-06', vehicleId, status: 'Digitado',
                hodometro: (Number(vehicle.odometro) || 0) + 100,
                itens: [
                    { itemComponente: 'Sistema de freios', descricaoProblema: 'Pedal afunda', gravidade: 'A' },
                    { itemComponente: 'Mangueira hidráulica', descricaoProblema: 'Vazando', gravidade: 'B' },
                    { itemComponente: 'Filtro de ar', descricaoProblema: 'Saturado', gravidade: 'C' },
                    { itemComponente: 'Luz de painel', descricaoProblema: 'Queimada', gravidade: 'C' },
                    { itemComponente: 'Pintura', descricaoProblema: 'Descascando', gravidade: 'D' },
                ],
            },
        });
        check('relato criado', criado.status, 201);
        relatoId = criado.body.id;

        const det = await call(c.getRelatoById, { params: { id: relatoId } });
        const [i1, i2, i3, i4, i5] = det.body.itens;

        // Triagem: 2 na Oficina X (i1 gravidade A, i2), 2 na MAK (i3, i4), 1 no Fornecedor Y (i5)
        const triagem = [
            { id: i1.id, executorTipo: 'externo', executorPartnerId: OFICINA_X, servicoDescricao: 'Sangria e troca de fluido', valorEstimado: 480 },
            { id: i2.id, executorTipo: 'externo', executorPartnerId: OFICINA_X, servicoDescricao: 'Troca da mangueira', valorEstimado: 320 },
            { id: i3.id, executorTipo: 'interno', servicoDescricao: 'Troca do filtro', valorEstimado: 90 },
            { id: i4.id, executorTipo: 'interno', servicoDescricao: 'Troca da lâmpada', valorEstimado: 15 },
            { id: i5.id, executorTipo: 'externo', executorPartnerId: FORNEC_Y, servicoDescricao: 'Pintura da lança' },
        ];

        // ── 2. Prévia antes de fechar ───────────────────────────────────────
        const prev = await call(c.previewFechamento, {
            params: { id: relatoId }, body: { dataBase: '2026-08-07', itens: triagem },
        });
        check('prévia → 200', prev.status, 200);
        check('prévia mostra 3 ordens (uma por executor)', prev.body.grupos.length, 3);
        check('prévia detecta item bloqueante (gravidade A)', prev.body.temItemBloqueante, true);
        check('prévia vê o equipamento alocado', prev.body.veiculo.estaAlocado, true);
        check('prévia ainda não fechou', prev.body.jaFechado, false);

        // ── 3. Fechamento com a OS do MC ────────────────────────────────────
        // Status imediatamente antes do fechamento — é o que o relato deve
        // guardar em vehicleStatusAnterior (aqui 'Em Obra', porque acabou de
        // ser alocado; não o 'Disponível' do snapshot inicial).
        const [[vAntesFech]] = await db.query('SELECT status FROM vehicles WHERE id = ?', [vehicleId]);

        const fech = await call(c.fecharRelato, {
            params: { id: relatoId },
            body: {
                osMc: OS_MC, dataBase: '2026-08-07',
                employeeIdAutorizado: emp.id,
                fazerSaidaObra: true, colocarEmManutencao: true,
                statusVeiculo: 'Em Manutenção', localManutencao: 'Pátio MAK Lajeado',
                saidaObra: { dataSaida: new Date(), location: 'Pátio MAK Lajeado' },
                itens: triagem,
            },
        });
        check('fechamento → 201', fech.status, 201);
        if (fech.status !== 201) out.push(`      motivo: ${JSON.stringify(fech.body)}`);
        ordensIds = (fech.body.ordens || []).map(o => o.id);

        check('gerou 3 ordens', fech.body.ordens?.length, 3);
        check('relato passou a Em Execução', fech.body.status, 'Em Execução');
        check('saída de obra confirmada', fech.body.saidaObraFeita, true);

        // ── 4. Conferências no banco ────────────────────────────────────────
        const [ordens] = await db.query(
            'SELECT * FROM orders WHERE relatoId = ? ORDER BY orderNumber ASC', [relatoId]
        );
        check('3 ordens gravadas', ordens.length, 3);
        check('todas com a OS do MC', ordens.every(o => o.osMc === OS_MC), true);
        check('todas com origem=relato', ordens.every(o => o.origem === 'relato'), true);
        check('todas com tipo=servico', ordens.every(o => o.tipo === 'servico'), true);
        check('todas apontam para o veículo', ordens.every(o => o.vehicleId === vehicleId), true);
        check('números sequenciais sem buraco',
            ordens.map(o => o.orderNumber - ordens[0].orderNumber), [0, 1, 2]);

        const [[counter]] = await db.query("SELECT lastNumber FROM counters WHERE name='purchaseOrderCounter'");
        check('contador acompanhou a última ordem', counter.lastNumber, ordens[2].orderNumber);

        const ordemX = ordens.find(o => o.supplierId === OFICINA_X);
        const itensX = typeof ordemX.items === 'string' ? JSON.parse(ordemX.items) : ordemX.items;
        check('Oficina X: 2 itens numa ordem só', itensX.length, 2);
        check('Oficina X: total 800', Number(ordemX.totalValue), 800);
        check('ordem com valor nasce Ativa', ordemX.status, 'Ativa');
        check('descrição do item traz a gravidade', /^\[A\]/.test(itensX[0].description) || /^\[B\]/.test(itensX[0].description), true);
        check('observação cita OS do MC e o relato',
            /OS MC MC-2026-4471 · Relato #/.test(ordemX.observacoes), true);

        const ordemMak = ordens.find(o => o.supplierId === OFICINA_INTERNA_PARTNER_ID);
        check('oficina própria virou ordem', !!ordemMak, true);
        check('MAK: 2 itens', (typeof ordemMak.items === 'string' ? JSON.parse(ordemMak.items) : ordemMak.items).length, 2);

        const ordemY = ordens.find(o => o.supplierId === FORNEC_Y);
        check('sem valor estimado → Pendente de Valor', ordemY.status, 'Pendente de Valor');

        const [vinculos] = await db.query('SELECT * FROM relato_item_ordens WHERE relatoId = ?', [relatoId]);
        check('5 vínculos item↔ordem', vinculos.length, 5);

        const [desp] = await db.query(
            `SELECT * FROM expenses WHERE orderId IN (${ordens.map(() => '?').join(',')})`,
            ordens.map(o => o.id)
        );
        check('despesa só para as ordens Ativa', desp.length, ordens.filter(o => o.status === 'Ativa').length);

        // Estado do veículo
        const [[v]] = await db.query(
            'SELECT status, obraAtualId, odometro, maintenanceLocation FROM vehicles WHERE id = ?', [vehicleId]
        );
        check('veículo Em Manutenção', v.status, 'Em Manutenção');
        check('obraAtualId zerado', v.obraAtualId, null);
        check('leitura não regrediu', Number(v.odometro) >= Number(snapshot.odometro), true);
        check('local de manutenção gravado', !!v.maintenanceLocation, true);

        const [estAbertas] = await db.query(
            'SELECT id FROM obras_historico_veiculos WHERE veiculoId = ? AND dataSaida IS NULL', [vehicleId]
        );
        check('nenhuma estadia em obra aberta', estAbertas.length, 0);

        const [histObraAberto] = await db.query(
            "SELECT id FROM vehicle_history WHERE vehicleId = ? AND historyType='obra' AND endDate IS NULL", [vehicleId]
        );
        check('histórico de obra fechado', histObraAberto.length, 0);

        // Cronograma: 07/08 é sexta; 10/08 é feriado cadastrado acima.
        const [itensFinal] = await db.query(
            'SELECT sequencia, gravidade, dataInicioPrevista, dataConclusaoPrevista, ordemSequencia, status FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia',
            [relatoId]
        );
        const ymd = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : null);
        check('cronograma persistido em todos os itens',
            itensFinal.every(i => i.dataConclusaoPrevista !== null), true);
        const itemA = itensFinal.find(i => i.gravidade === 'A');
        check('item A começa na sexta 07/08', ymd(itemA.dataInicioPrevista), '2026-08-07');
        check('item A (2 d.ú.) conclui 11/08 — pula sábado, domingo e o feriado de 10/08',
            ymd(itemA.dataConclusaoPrevista), '2026-08-11');
        check('nenhuma conclusão cai em fim de semana ou feriado',
            itensFinal.every(i => {
                const d = new Date(ymd(i.dataConclusaoPrevista) + 'T12:00:00');
                return d.getDay() !== 0 && d.getDay() !== 6 && ymd(i.dataConclusaoPrevista) !== '2026-08-10';
            }), true);
        check('itens de ordem Ativa entram Em Execução',
            itensFinal.filter(i => i.gravidade !== 'D').every(i => i.status === 'Em Execução'), true);
        check('item de ordem a cotar fica Em Análise',
            itensFinal.find(i => i.gravidade === 'D').status, 'Em Análise');

        const [[rel]] = await db.query('SELECT * FROM relatos_ocorrencia WHERE id = ?', [relatoId]);
        check('relato marcado Em Execução', rel.status, 'Em Execução');
        check('OS do MC gravada no relato', rel.osMc, OS_MC);
        check('saidaObraFeita=1', rel.saidaObraFeita, 1);
        check('status anterior do veículo guardado', rel.vehicleStatusAnterior, vAntesFech.status);
        check('status anterior é o de antes da manutenção', rel.vehicleStatusAnterior, 'Em Obra');
        check('conclusão prevista geral gravada', !!rel.dataConclusaoPrevista, true);

        // ── 5. Idempotência: reenviar não duplica ───────────────────────────
        const refech = await call(c.fecharRelato, {
            params: { id: relatoId },
            body: { osMc: OS_MC, dataBase: '2026-08-07', itens: triagem },
        });
        check('refechar → 409', refech.status, 409);
        check('409 devolve as ordens já criadas', refech.body.ordens?.length, 3);
        const [ordensDepois] = await db.query('SELECT id FROM orders WHERE relatoId = ?', [relatoId]);
        check('nenhuma ordem duplicada', ordensDepois.length, 3);

        // ── 6. Fechar sem OS do MC é bloqueado ──────────────────────────────
        const semOs = await call(c.fecharRelato, { params: { id: relatoId }, body: {} });
        check('sem OS do MC → 400', semOs.status, 400);

        // ── 7. Consulta por OS do MC ────────────────────────────────────────
        const porOs = await call(c.getPorOsMc, { params: { numero: OS_MC } });
        check('consulta por OS do MC → 200', porOs.status, 200);
        check('OS do MC lista o relato', porOs.body.relatos.length, 1);
        check('OS do MC lista as 3 ordens', porOs.body.ordens.length, 3);
        check('3 ordens ainda abertas na OS', porOs.body.ordensAbertas, 3);

        // ── 8. Guarda de regressão de leitura ───────────────────────────────
        const outro = await call(c.createRelato, {
            body: {
                relatorNome: 'Regressão', vehicleId, dataRelato: '2026-08-06', status: 'Digitado',
                hodometro: 1, // muito menor que a leitura real
                itens: [{ itemComponente: 'X', descricaoProblema: 'Y', gravidade: 'C' }],
            },
        });
        const detOutro = await call(c.getRelatoById, { params: { id: outro.body.id } });
        const fechRegr = await call(c.fecharRelato, {
            params: { id: outro.body.id },
            body: {
                osMc: 'MC-TESTE-REGR', dataBase: '2026-08-07',
                itens: [{ id: detOutro.body.itens[0].id, executorTipo: 'interno' }],
            },
        });
        check('leitura menor que a atual → 400', fechRegr.status, 400);
        check('erro identificado como LEITURA_REGRESSIVA', fechRegr.body.codigo, 'LEITURA_REGRESSIVA');

        const fechForcado = await call(c.fecharRelato, {
            params: { id: outro.body.id },
            body: {
                osMc: 'MC-TESTE-REGR', dataBase: '2026-08-07', forcarLeitura: true,
                fazerSaidaObra: true, colocarEmManutencao: false,
                itens: [{ id: detOutro.body.itens[0].id, executorTipo: 'interno' }],
            },
        });
        check('com forcarLeitura → 201', fechForcado.status, 201);
        const [[vForcado]] = await db.query('SELECT odometro FROM vehicles WHERE id = ?', [vehicleId]);
        check('mesmo forçando, a leitura NÃO regride',
            Number(vForcado.odometro) >= Number(snapshot.odometro), true);

        // limpeza do relato extra
        const [ordensExtra] = await db.query('SELECT id FROM orders WHERE relatoId = ?', [outro.body.id]);
        ordensIds.push(...ordensExtra.map(o => o.id));
        await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [outro.body.id]);
        await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [outro.body.id]);
        await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [outro.body.id]);
    } catch (e) {
        out.push(`FAIL  exceção: ${e.message}\n${e.stack}`);
    } finally {
        try {
            if (ordensIds.length) {
                await db.query(`DELETE FROM expenses WHERE orderId IN (${ordensIds.map(() => '?').join(',')})`, ordensIds);
                await db.query(`DELETE FROM orders WHERE id IN (${ordensIds.map(() => '?').join(',')})`, ordensIds);
            }
            if (relatoId) {
                await db.query('DELETE FROM relato_item_ordens WHERE relatoId = ?', [relatoId]);
                await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]);
                await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [relatoId]);
            }
            if (feriadoId) await db.query('DELETE FROM admin_holidays WHERE id = ?', [feriadoId]);
            await db.query('DELETE FROM partners WHERE id IN (?, ?)', [OFICINA_X, FORNEC_Y]);
            if (employeeId) await db.query('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeId]);
            if (vehicleId && snapshot) {
                await db.query("DELETE FROM obras_historico_veiculos WHERE veiculoId = ? AND observacoes LIKE '%TESTE FECHAMENTO%'", [vehicleId]);
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
