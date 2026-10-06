// scripts/test-producao-periodo.js
//
// Verifica as regras da aba "Produção" (services/producaoPeriodoService.js):
// h/dia = horas ÷ dias úteis ALOCADOS, sábado só no numerador, troca de obra no
// mesmo dia conta 1 dia, horas sem alocação ficam fora da média. Depois roda o
// cálculo real no banco local e mostra o resumo do mês.
//
//   node scripts/test-producao-periodo.js [AAAA-MM-DD AAAA-MM-DD]
require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.local', override: true, quiet: true });

const db = require('../database');
const { calcularProducao, periodoAnterior, producaoPeriodo } = require('../services/producaoPeriodoService');

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

// Setembro/2026: 22 dias úteis sem feriado (01/09 é terça, 30/09 quarta).
const START = '2026-09-01';
const END = '2026-09-30';
const veiculos = new Map([
    ['A', { id: 'A', registroInterno: 'ESC-A', tipo: 'Escavadeira', sub_tipo: 'Escavadeira Hidráulica 23T', isOutsourced: 0 }],
    ['B', { id: 'B', registroInterno: 'ESC-B', tipo: 'Escavadeira', sub_tipo: 'Escavadeira Hidráulica 23T', isOutsourced: 0 }],
    ['T', { id: 'T', registroInterno: 'ESC-T', tipo: 'Escavadeira', sub_tipo: 'Escavadeira Hidráulica 23T', isOutsourced: 1, locadora: 'Locadora X' }],
    ['Z', { id: 'Z', registroInterno: 'ROL-Z', tipo: 'Rolo', sub_tipo: 'Rolo Compactador', isOutsourced: 0 }],
    ['L', { id: 'L', registroInterno: 'CAR-L', tipo: 'Leve', isOutsourced: 0 }],
]);
const obras = new Map([
    ['1', { id: '1', nome: 'Mata', orgao_contratante: 'SEDUR', regiao: null }],
    ['2', { id: '2', nome: 'Mata', orgao_contratante: 'SEAPI', regiao: null }],
]);
const feriados = { nacional: new Set() };

const r = calcularProducao({
    start: START, end: END, veiculos, obras, feriados, horasAnterior: 100,
    estadias: [
        // A: mês inteiro na obra 1, trabalhou 1 dia de 10h → 10/22 = 0,5
        { veiculoId: 'A', obraId: '1', dataEntrada: '2026-08-10', dataSaida: null },
        // B: obra 1 até 15/09, obra 2 a partir de 15/09 (troca no mesmo dia)
        { veiculoId: 'B', obraId: '1', dataEntrada: '2026-08-01', dataSaida: '2026-09-15' },
        { veiculoId: 'B', obraId: '2', dataEntrada: '2026-09-15', dataSaida: null },
        // T: terceira, só de 21/09 em diante (8 dias úteis)
        { veiculoId: 'T', obraId: '2', dataEntrada: '2026-09-21', dataSaida: null },
        // Z: alocado o mês todo e nunca lançou → aparece com 0
        { veiculoId: 'Z', obraId: '2', dataEntrada: '2026-09-01', dataSaida: null },
        // L: carro alocado sem horas → não é produtivo, fica fora
        { veiculoId: 'L', obraId: '1', dataEntrada: '2026-09-01', dataSaida: null },
    ],
    logs: [
        { vehicleId: 'A', obraId: '1', date: '2026-09-02', totalHours: 10 },
        // B: 22 dias × 8h + sábado 05/09 com 8h (sábado só soma no numerador)
        ...['01', '02', '03', '04', '08', '09', '10', '11', '14', '15', '16', '17', '18', '21', '22', '23', '24', '25', '28', '29', '30', '07']
            .map(d => ({ vehicleId: 'B', obraId: Number(d) < 15 ? '1' : '2', date: `2026-09-${d}`, totalHours: 8 })),
        { vehicleId: 'B', obraId: '1', date: '2026-09-05', totalHours: 8 },
        // T: 8 dias alocados × 9h = 72h, e 2 dias ANTES da alocação (sem alocação)
        ...['21', '22', '23', '24', '25', '28', '29', '30'].map(d => ({ vehicleId: 'T', obraId: '2', date: `2026-09-${d}`, totalHours: 9 })),
        { vehicleId: 'T', obraId: '2', date: '2026-09-17', totalHours: 7 },
        { vehicleId: 'T', obraId: '2', date: '2026-09-18', totalHours: 7 },
    ],
});

const m = (id) => r.porMaquina.find(x => x.vehicleId === id);
check('A: 1 dia de 10h no mês alocado → 0,5 h/dia', m('A').hDia, 0.5);
check('A: 22 dias úteis alocados', m('A').diasAlocados, 22);
check('B: troca no mesmo dia não duplica o dia (22 úteis)', m('B').diasAlocados, 22);
check('B: sábado soma no numerador (184h ÷ 22 = 8,4)', m('B').hDia, 8.4);
check('T: só 8 dias úteis alocados', m('T').diasAlocados, 8);
check('T: horas fora da alocação não entram na média (72 ÷ 8 = 9)', m('T').hDia, 9);
check('T: total inclui as horas sem alocação (86h)', m('T').horas, 86);
check('T: origem terceiro com locadora', [m('T').origem, m('T').locadora], ['terceiro', 'Locadora X']);
check('Z: alocado sem lançamento aparece com 0 h/dia', [m('Z')?.horas, m('Z')?.hDia], [0, 0]);
check('A: 20 dias úteis alocada depois do último lançamento → parada alocada', [m('A').diasSemLancarNoFim, m('A').paradaAlocada], [20, true]);
check('B: lançou até o fim → não é parada', m('B').paradaAlocada, false);
check('Resumo: paradas alocadas por origem', r.resumo.paradasAlocadas, { proprio: 2, terceiro: 0, dias: 42 });
check('L: veículo leve alocado sem horas fica fora', m('L'), undefined);
check('Sem alocação: 14h da T na obra 2', r.semAlocacao.map(s => [s.vehicleId, s.horas, s.dias]), [['T', 14, 2]]);
check('Resumo: total 280h', r.resumo.horasTotal, 280);
check('Resumo: terceiro 86h', r.resumo.horasTerceiro, 86);
check('Resumo: delta vs 100h anterior', r.resumo.deltaPct, 180);
check('Resumo: obras homônimas separadas', r.porObra.map(o => o.nome).sort(), ['Mata (SEAPI)', 'Mata (SEDUR)']);
check('Por obra: Z aparece no detalhe da obra 2 com 0h', r.porObra.find(o => o.obraId === '2').maquinas.some(x => x.vehicleId === 'Z' && x.horas === 0), true);
const esc = r.porTipo.find(t => t.grupo === 'Escavadeira Hidráulica 23T');
// Próprio: (10 + 184) ÷ (22 + 22) = 4,4 ; terceiro: 72 ÷ 8 = 9
check('Por tipo: próprio agregado Σh÷Σdias', esc.proprio.hDia, 4.4);
check('Por tipo: terceiro', esc.terceiro.hDia, 9);
check('Por tipo: diferença próprio vs terceiro', esc.diffPct, -51.1);

check('Período anterior de mês cheio', periodoAnterior('2026-09-01', '2026-09-30'), { start: '2026-08-01', end: '2026-08-31' });
check('Período anterior de mês parcial', periodoAnterior('2026-10-01', '2026-10-06'), { start: '2026-09-01', end: '2026-09-06' });
check('Período anterior de março (fev curto)', periodoAnterior('2026-03-01', '2026-03-31'), { start: '2026-02-01', end: '2026-02-28' });
check('Período anterior de janela livre', periodoAnterior('2026-09-10', '2026-09-19'), { start: '2026-08-31', end: '2026-09-09' });

// Passa pelo handler HTTP (validação de datas), não só pelo serviço.
const { getProducao } = require('../controllers/analiseGerencialController');
const chamar = (query) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    getProducao({ query }, res);
});

(async () => {
    try {
        check('Handler: datas válidas → 200', (await chamar({ startDate: START, endDate: END })).status, 200);
        check('Handler: sem datas → 400', (await chamar({})).status, 400);
        check('Handler: data fora do formato → 400', (await chamar({ startDate: '01/09/2026', endDate: END })).status, 400);
        check('Handler: início depois do fim → 400', (await chamar({ startDate: END, endDate: START })).status, 400);
        console.log(out.join('\n'));
        const [start, end] = process.argv.slice(2);
        const real = await producaoPeriodo(start || START, end || END);
        console.log('\n── Banco local ──', real.range);
        console.log(real.resumo);
        console.log('\nTop 5 obras:');
        real.porObra.slice(0, 5).forEach(o => console.log(`  ${o.nome}: ${o.total}h (terceiro ${o.pctTerceiro}%) · ${o.maquinas.length} máq.`));
        console.log('\nPor tipo:');
        real.porTipo.slice(0, 8).forEach(t => console.log(`  ${t.grupo}: próprio ${t.proprio.hDia ?? '—'} (${t.proprio.maquinas}) × terceiro ${t.terceiro.hDia ?? '—'} (${t.terceiro.maquinas}) → ${t.diffPct ?? '—'}%`));
        console.log('\nPiores h/dia (com dias alocados):');
        real.porMaquina.filter(x => x.diasAlocados > 0).sort((a, b) => a.hDia - b.hDia).slice(0, 5)
            .forEach(x => console.log(`  ${x.registroInterno || x.placa} ${x.grupo} ${x.origem}: ${x.horas}h em ${x.diasAlocados} dias → ${x.hDia}`));
        if (out.some(l => l.startsWith('FAIL'))) process.exitCode = 1;
    } catch (e) {
        console.error('❌', e);
        process.exitCode = 1;
    } finally {
        await db.end();
        process.exit();
    }
})();
