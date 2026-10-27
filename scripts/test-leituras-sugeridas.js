// scripts/test-leituras-sugeridas.js
//
// Regras da sugestão de leitura para estadia retroativa
// (utils/leiturasSugeridas.js), com um banco falso: cada fonte devolve as
// linhas do cenário.
//
//   node scripts/test-leituras-sugeridas.js
const { sugerirLeituras } = require('../utils/leiturasSugeridas');

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

// Timestamps reais às 10h de Brasília (13h UTC).
const ts = (dia) => new Date(`${dia}T13:00:00Z`);
const fakeConn = ({ abast = [], comboio = [], fotos = [], estadias = [] }) => ({
    query: async (sql) => {
        if (sql.includes('FROM refuelings')) return [abast.map(([dia, valor]) => ({ data: ts(dia), valor, partnerName: 'POSTO' }))];
        if (sql.includes('FROM comboio_transactions')) return [comboio.map(([dia, valor]) => ({ date: ts(dia), valor, comboioVehicleName: 'CB1' }))];
        if (sql.includes('FROM evidencia_registro')) return [fotos.map(([dia, tipo, valor]) => ({ dia, tipo, valor }))];
        if (sql.includes('FROM obras_historico_veiculos')) return [estadias.map(([ent, sai, entrada, saida]) => ({
            dataEntrada: ent, dataSaida: sai, entrada, saida, nome: 'Mata', orgao_contratante: 'SEDUR',
        }))];
        throw new Error(`SQL inesperado: ${sql}`);
    },
});
const resumo = (r) => ({
    partida: r.partida && [r.partida.valor, r.partida.dia, !!r.partida.estimada],
    volta: r.volta && [r.volta.valor, r.volta.dia, !!r.volta.estimada],
    proxima: r.proxima && [r.proxima.valor, r.proxima.dia],
});

(async () => {
    // Abastecimento antes, abastecimento depois que fecha com as horas.
    let r = await sugerirLeituras(fakeConn({ abast: [['2026-09-28', 1000], ['2026-09-20', 900], ['2026-10-08', 1045]] }),
        'V', '2026-10-01', '2026-10-05', 'horimetro', 40);
    check('Última leitura antes e primeira depois', resumo(r), { partida: [1000, '2026-09-28', false], volta: [1045, '2026-10-08', false], proxima: null });

    // Foto do horímetro no próprio dia vence o abastecimento.
    r = await sugerirLeituras(fakeConn({
        abast: [['2026-09-28', 1000], ['2026-10-08', 1045]],
        fotos: [['2026-10-01', 'horimetro_inicio', 1002], ['2026-10-05', 'horimetro_fim', 1040]],
    }), 'V', '2026-10-01', '2026-10-05', 'horimetro', 40);
    check('Foto de início/fim do dia tem prioridade', resumo(r), { partida: [1002, '2026-10-01', false], volta: [1040, '2026-10-05', false], proxima: null });

    // Saída de uma estadia e entrada na seguinte com a MESMA leitura (copiada).
    r = await sugerirLeituras(fakeConn({ estadias: [['2026-08-01', '2026-09-30', 900, 1014], ['2026-10-05', null, 1014, 0]] }),
        'V', '2026-10-01', '2026-10-02', 'horimetro', 18.4);
    check('Leitura copiada (Δ0) → partida + horas lançadas, real em "proxima"', resumo(r),
        { partida: [1014, '2026-09-30', false], volta: [1032.4, '2026-10-02', true], proxima: [1014, '2026-10-05'] });

    // Andou menos que o lançado: fica a real (estimar passaria dela).
    r = await sugerirLeituras(fakeConn({ abast: [['2026-09-01', 9073.9], ['2026-10-20', 9138]] }),
        'V', '2026-10-01', '2026-10-17', 'horimetro', 87.8);
    check('Andou menos que o lançado → mantém a leitura real', resumo(r).volta, [9138, '2026-10-20', false]);

    // Fontes em escalas diferentes (163 × 9920).
    r = await sugerirLeituras(fakeConn({ abast: [['2026-09-18', 163], ['2026-10-09', 9920]] }),
        'V', '2026-10-08', '2026-10-08', 'horimetro', 8);
    check('Salto absurdo → estima e mostra a real', resumo(r), { partida: [163, '2026-09-18', false], volta: [171, '2026-10-08', true], proxima: [9920, '2026-10-09'] });

    // Terceiro sem leitura antes; "1" é placeholder e não conta.
    r = await sugerirLeituras(fakeConn({ abast: [['2026-09-01', 1]], estadias: [['2026-09-07', null, 1638.8, 0]] }),
        'V', '2026-09-03', '2026-09-04', 'horimetro', 17.8);
    check('Sem leitura antes → partida = volta − horas', resumo(r), { partida: [1621, '2026-09-03', true], volta: [1638.8, '2026-09-07', false], proxima: null });

    // Nada registrado.
    r = await sugerirLeituras(fakeConn({}), 'V', '2026-09-03', '2026-09-04', 'horimetro', 17.8);
    check('Sem nenhuma leitura → 0 até as horas lançadas', resumo(r), { partida: [0, '2026-09-03', true], volta: [17.8, '2026-09-04', true], proxima: null });

    // Só leitura depois, baixa demais para descontar as horas → também 0 + horas.
    r = await sugerirLeituras(fakeConn({ abast: [['2026-09-10', 10]] }), 'V', '2026-09-03', '2026-09-04', 'horimetro', 17.8);
    check('Volta menor que as horas → 0 até as horas, real em "proxima"', resumo(r), { partida: [0, '2026-09-03', true], volta: [17.8, '2026-09-04', true], proxima: [10, '2026-09-10'] });

    // Sem horas informadas (estadia aberta pelo cadastro do veículo): sem chute.
    r = await sugerirLeituras(fakeConn({}), 'V', '2026-09-03', '2026-09-04', 'horimetro', null);
    check('Sem leitura e sem horas → sem sugestão', resumo(r), { partida: null, volta: null, proxima: null });

    // Odômetro não confere com horas; leitura que volta para trás é descartada.
    r = await sugerirLeituras(fakeConn({ abast: [['2026-09-28', 50000], ['2026-10-08', 49000]] }),
        'V', '2026-10-01', '2026-10-05', 'odometro', 40);
    check('Odômetro que anda para trás → sem volta', resumo(r).volta, null);

    console.log(out.join('\n'));
    const falhas = out.filter(l => l.startsWith('FAIL')).length;
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
    process.exit(falhas ? 1 : 0);
})();
