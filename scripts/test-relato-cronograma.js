// scripts/test-relato-cronograma.js
//
// Testa o cronograma em dias úteis e o agrupamento das ordens por executor.
// computeCronograma e agruparPorExecutor são funções puras — rodam sem banco.
// A parte que toca o banco (montarPreview / preview-fechamento) é exercitada no
// fim, criando e apagando um relato de teste.
//
//   node scripts/test-relato-cronograma.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../database');
const crypto = require('crypto');
const {
    computeCronograma, agruparPorExecutor, montarPreview,
} = require('../services/relatoCronogramaService');
const { OFICINA_INTERNA_PARTNER_ID } = require('../utils/ensureOficinaInternaPartner');
const relatoController = require('../controllers/relatoController');

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

// A=2, B=5, C=10, D=30 dias úteis (o seed real).
const SLA = {
    A: { gravidade: 'A', slaDiasUteis: 2, bloqueiaOperacao: 1, ordemPrioridade: 1 },
    B: { gravidade: 'B', slaDiasUteis: 5, bloqueiaOperacao: 0, ordemPrioridade: 2 },
    C: { gravidade: 'C', slaDiasUteis: 10, bloqueiaOperacao: 0, ordemPrioridade: 3 },
    D: { gravidade: 'D', slaDiasUteis: 30, bloqueiaOperacao: 0, ordemPrioridade: 4 },
};

const item = (o) => ({
    id: o.id, sequencia: o.seq, gravidade: o.g, itemComponente: o.nome || `Item ${o.seq}`,
    descricaoProblema: 'x', status: o.status || 'Em Análise',
    executorTipo: o.tipo || 'externo', executorPartnerId: o.exec || null,
    quantidade: o.qtd ?? 1, valorEstimado: o.valor ?? null,
    inventoryItemId: o.estoque || null, slaDiasUteis: o.sla || null,
});

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
    }, res)).catch(e => resolve({ status: 500, body: { error: e.message } }));
});

(async () => {
    let relatoId = null;
    try {
        // ── 1. Dias úteis, sem feriado ──────────────────────────────────────
        // 2026-08-07 é SEXTA-FEIRA. Semântica adotada: o prazo conta A PARTIR
        // da data base, incluindo-a quando é dia útil (o gestor escolhe a data
        // base no wizard, então adiar é decisão dele, não do sistema).
        // A = 2 d.ú. → sexta (1º) + segunda (2º).
        const semFeriado = new Set();
        let r = computeCronograma(
            [item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' })],
            '2026-08-07', semFeriado, SLA
        );
        check('A (2 d.ú.) fechado na sexta: começa na própria sexta', r.cronograma[0].dataInicioPrevista, '2026-08-07');
        check('A (2 d.ú.): conclui segunda (pula sábado e domingo)', r.cronograma[0].dataConclusaoPrevista, '2026-08-10');

        // ── 2. Com feriado na segunda ───────────────────────────────────────
        const comFeriado = new Set(['2026-08-10']);
        r = computeCronograma([item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' })], '2026-08-07', comFeriado, SLA);
        check('feriado na segunda: ainda começa sexta', r.cronograma[0].dataInicioPrevista, '2026-08-07');
        check('feriado na segunda: empurra a conclusão para terça', r.cronograma[0].dataConclusaoPrevista, '2026-08-11');

        // Data base caindo no sábado: o início escorrega para segunda.
        r = computeCronograma([item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' })], '2026-08-08', semFeriado, SLA);
        check('data base no sábado: começa segunda', r.cronograma[0].dataInicioPrevista, '2026-08-10');
        check('data base não-útil gera aviso', r.avisos.some(a => /não é dia útil/i.test(a)), true);

        // ── 3. Sequencial dentro do MESMO executor ──────────────────────────
        r = computeCronograma([
            item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' }),   // 2 d.ú.
            item({ id: 'i2', seq: 2, g: 'B', exec: 'of-x' }),   // 5 d.ú.
        ], '2026-08-07', semFeriado, SLA);
        const c1 = r.cronograma.find(c => c.itemId === 'i1');
        const c2 = r.cronograma.find(c => c.itemId === 'i2');
        check('mesmo executor: A conclui 10/08', c1.dataConclusaoPrevista, '2026-08-10');
        check('mesmo executor: B só começa depois de A', c2.dataInicioPrevista, '2026-08-11');
        check('mesmo executor: B (5 d.ú.) conclui 17/08', c2.dataConclusaoPrevista, '2026-08-17');

        // ── 4. Paralelo entre executores DIFERENTES ─────────────────────────
        r = computeCronograma([
            item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' }),
            item({ id: 'i2', seq: 2, g: 'B', exec: 'of-y' }),
        ], '2026-08-07', semFeriado, SLA);
        check('executores distintos começam no mesmo dia',
            r.cronograma.map(c => c.dataInicioPrevista), ['2026-08-07', '2026-08-07']);

        // ── 5. Prioridade da gravidade dentro do executor ───────────────────
        r = computeCronograma([
            item({ id: 'iD', seq: 1, g: 'D', exec: 'of-x' }),   // aparece 1º na ficha
            item({ id: 'iA', seq: 2, g: 'A', exec: 'of-x' }),   // mas é o mais grave
        ], '2026-08-07', semFeriado, SLA);
        check('A é atendido antes de D mesmo vindo depois na ficha',
            r.cronograma.find(c => c.itemId === 'iA').dataInicioPrevista, '2026-08-07');
        check('D só começa depois de A',
            r.cronograma.find(c => c.itemId === 'iD').dataInicioPrevista, '2026-08-11');

        // ── 6. SLA sobrescrito no item ──────────────────────────────────────
        r = computeCronograma([item({ id: 'i1', seq: 1, g: 'D', exec: 'of-x', sla: 1 })], '2026-08-07', semFeriado, SLA);
        check('sla do item (1 d.ú.) vence o padrão da gravidade D (30)',
            r.cronograma[0].dataConclusaoPrevista, '2026-08-07');

        // ── 7. Item cancelado sai do cronograma ─────────────────────────────
        r = computeCronograma([
            item({ id: 'i1', seq: 1, g: 'A', exec: 'of-x' }),
            item({ id: 'i2', seq: 2, g: 'A', exec: 'of-x', status: 'Cancelado' }),
        ], '2026-08-07', semFeriado, SLA);
        check('cancelado não entra no cronograma', r.cronograma.length, 1);

        // ── 8. ordemSequencia e data geral ──────────────────────────────────
        r = computeCronograma([
            item({ id: 'i1', seq: 1, g: 'D', exec: 'of-x' }),   // 30 d.ú.
            item({ id: 'i2', seq: 2, g: 'A', exec: 'of-y' }),   // 2 d.ú.
        ], '2026-08-07', semFeriado, SLA);
        check('sequência global ordenada por conclusão',
            r.cronograma.map(c => `${c.itemId}:${c.ordemSequencia}`), ['i2:1', 'i1:2']);
        check('conclusão geral = a mais distante',
            r.dataConclusaoPrevistaGeral, r.cronograma[1].dataConclusaoPrevista);

        // ── 9. Item sem executor gera aviso ─────────────────────────────────
        r = computeCronograma([item({ id: 'i1', seq: 1, g: 'A', exec: null })], '2026-08-07', semFeriado, SLA);
        check('sem executor → aviso', r.avisos.some(a => /sem executor/i.test(a)), true);

        // ── 10. Agrupamento por executor ────────────────────────────────────
        const itensGrupo = [
            item({ id: 'a1', seq: 1, g: 'A', exec: 'of-x', valor: 100, qtd: 2 }),
            item({ id: 'a2', seq: 2, g: 'B', exec: 'of-x', valor: 50 }),
            item({ id: 'b1', seq: 3, g: 'C', tipo: 'interno' }),
            item({ id: 'c1', seq: 4, g: 'D', exec: 'of-y', valor: 300 }),
        ];
        const cr = computeCronograma(itensGrupo, '2026-08-07', semFeriado, SLA);
        const porItem = new Map(cr.cronograma.map(c => [c.itemId, c]));
        const partners = new Map([
            ['of-x', { id: 'of-x', razaoSocial: 'Oficina X Ltda', nomeFantasia: 'Oficina X', is_interno: 0 }],
            ['of-y', { id: 'of-y', razaoSocial: 'Fornecedor Y', is_interno: 0 }],
            [OFICINA_INTERNA_PARTNER_ID, { id: OFICINA_INTERNA_PARTNER_ID, razaoSocial: 'MAK SERVIÇOS - OFICINA PRÓPRIA', is_interno: 1 }],
        ]);
        const grupos = agruparPorExecutor(itensGrupo, porItem, partners);
        check('3 executores → 3 ordens', grupos.length, 3);
        const gx = grupos.find(g => g.executorPartnerId === 'of-x');
        check('Oficina X agrupa 2 itens numa ordem só', gx.itens.length, 2);
        check('total estimado soma qtd x valor', gx.totalEstimado, 250);
        check('usa nome fantasia quando existe', gx.executorNome, 'Oficina X');
        const gi = grupos.find(g => g.executorPartnerId === OFICINA_INTERNA_PARTNER_ID);
        check('interno vira o partner-espelho da MAK', !!gi, true);
        check('interno marcado como executorInterno', gi.executorInterno, true);
        check('sem item de estoque → ordem de serviço', gx.tipo, 'servico');

        const soEstoque = [item({ id: 'p1', seq: 1, g: 'C', exec: 'of-x', estoque: 'inv-1', valor: 10 })];
        const crE = computeCronograma(soEstoque, '2026-08-07', semFeriado, SLA);
        const gE = agruparPorExecutor(soEstoque, new Map(crE.cronograma.map(c => [c.itemId, c])), partners);
        check('tudo de estoque → ordem de compra', gE[0].tipo, 'compra');

        const semExec = [item({ id: 'x1', seq: 1, g: 'A', exec: null })];
        const crS = computeCronograma(semExec, '2026-08-07', semFeriado, SLA);
        check('item sem executor não vira ordem',
            agruparPorExecutor(semExec, new Map(crS.cronograma.map(c => [c.itemId, c])), partners).length, 0);

        // ── 11. montarPreview + endpoint, contra o banco ────────────────────
        const [[vehicle]] = await db.query('SELECT id FROM vehicles LIMIT 1');
        const criado = await call(relatoController.createRelato, {
            body: {
                relatorNome: 'Teste Cronograma', vehicleId: vehicle.id, dataRelato: '2026-08-07',
                status: 'Digitado',
                itens: [
                    { itemComponente: 'Freio', descricaoProblema: 'Pedal afunda', gravidade: 'A' },
                    { itemComponente: 'Mangueira', descricaoProblema: 'Vazando', gravidade: 'B' },
                    { itemComponente: 'Pintura', descricaoProblema: 'Descascando', gravidade: 'D' },
                ],
            },
        });
        relatoId = criado.body.id;

        const det = await call(relatoController.getRelatoById, { params: { id: relatoId } });
        const [iA, iB, iD] = det.body.itens;

        const prev = await call(relatoController.previewFechamento, {
            params: { id: relatoId },
            body: {
                dataBase: '2026-08-07',
                itens: [
                    { id: iA.id, executorTipo: 'interno', valorEstimado: 480 },
                    { id: iB.id, executorTipo: 'interno', valorEstimado: 120 },
                    { id: iD.id, executorTipo: 'externo', executorPartnerId: 'nao-existe-xyz' },
                ],
            },
        });
        check('preview → 200', prev.status, 200);
        check('preview agrupa MAK + externo em 2 ordens', prev.body.grupos.length, 2);
        const gMak = prev.body.grupos.find(g => g.executorPartnerId === OFICINA_INTERNA_PARTNER_ID);
        check('ordem da MAK tem 2 itens', gMak.itens.length, 2);
        check('ordem da MAK soma 600', gMak.totalEstimado, 600);
        check('nome da oficina interna resolvido do banco', gMak.executorNome, 'Oficina MAK (interna)');
        check('tem item bloqueante (gravidade A)', prev.body.temItemBloqueante, true);
        check('cronograma cobre os 3 itens', prev.body.cronograma.length, 3);
        check('preview NÃO persiste cronograma',
            (await db.query('SELECT dataConclusaoPrevista FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]))[0]
                .every(i => i.dataConclusaoPrevista === null), true);
        check('devolve situação do veículo', !!prev.body.veiculo, true);
        check('sabe se está alocado', typeof prev.body.veiculo.estaAlocado, 'boolean');
        check('triagem do preview não foi gravada',
            (await db.query('SELECT executorTipo FROM relato_ocorrencia_itens WHERE id = ?', [iA.id]))[0][0].executorTipo, null);

        const semItens = await call(relatoController.createRelato, {
            body: { relatorNome: 'Vazio', vehicleId: vehicle.id, dataRelato: '2026-08-07' },
        });
        const prevVazio = await call(relatoController.previewFechamento, { params: { id: semItens.body.id } });
        check('preview de relato sem itens → 400', prevVazio.status, 400);
        await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [semItens.body.id]);
    } catch (e) {
        out.push(`FAIL  exceção: ${e.message}\n${e.stack}`);
    } finally {
        if (relatoId) {
            await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]);
            await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [relatoId]);
        }
        console.log(out.join('\n'));
        const falhas = out.filter(r => r.startsWith('FAIL')).length;
        console.log(falhas ? `\n>>> ${falhas} FALHA(S)` : '\n>>> TODOS OS TESTES PASSARAM');
        process.exit(falhas ? 1 : 0);
    }
})();
