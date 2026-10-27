// scripts/test-acao-horas-sem-alocacao.js
//
// Regras de utils/acaoHorasSemAlocacao.js: quando um trecho de horas sem
// alocação vira "estender a alocação da obra", "antecipar a entrada" ou
// estadia retroativa avulsa.
//
//   node scripts/test-acao-horas-sem-alocacao.js
const { acaoDoTrecho } = require('../utils/acaoHorasSemAlocacao');

const out = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};
const pres = (obraId, ...dias) => dias.map(dia => ({ dia, obraId }));
const resumo = (a) => a && (a.tipo === 'estender'
    ? [a.tipo, a.historyId, a.novaSaida]
    : [a.tipo, a.historyId, a.novaEntrada]);
const HOJE = '2026-10-26';

// Caso RE779: desalocada de U em 22/09, seguiu lançando em U até ir para E em 19/10.
check('Saiu e seguiu lançando na mesma obra → estende até a próxima estadia', resumo(acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-09-23', ultimoDia: '2026-09-25' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-09', fim: '2026-09-22' }, { id: 'e', obraId: 'E', inicio: '2026-10-19', fim: null }],
    presenca: [...pres('U', '2026-09-23', '2026-09-25', '2026-09-28', '2026-10-14', '2026-10-19'), ...pres('E', '2026-10-20')],
    hoje: HOJE,
})), ['estender', 'u', '2026-10-19']);

check('Trecho de outubro da mesma máquina sugere a mesma correção', resumo(acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-14', ultimoDia: '2026-10-18' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-09', fim: '2026-09-22' }, { id: 'e', obraId: 'E', inicio: '2026-10-19', fim: null }],
    presenca: pres('U', '2026-09-23', '2026-09-25', '2026-09-28', '2026-10-14', '2026-10-18', '2026-10-19'),
    hoje: HOJE,
})), ['estender', 'u', '2026-10-19']);

check('Sem próxima estadia → estende até o último lançamento na obra', resumo(acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-01', ultimoDia: '2026-10-02' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-01', fim: '2026-09-30' }],
    presenca: pres('U', '2026-10-01', '2026-10-02', '2026-10-09'),
    hoje: HOJE,
})), ['estender', 'u', '2026-10-09']);

check('Foi para outra obra depois → estende só até o último dia antes dela', resumo(acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-01', ultimoDia: '2026-10-02' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-01', fim: '2026-09-30' }],
    presenca: [...pres('U', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-20'), ...pres('B', '2026-10-08')],
    hoje: HOJE,
})), ['estender', 'u', '2026-10-05']);

check('Buraco longo depois da saída (1 mês sem lançar) → não estende', acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-01', ultimoDia: '2026-10-17' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-08-14', fim: '2026-09-01' }],
    presenca: pres('U', '2026-10-01', '2026-10-17'),
    hoje: HOJE,
}), null);

check('Lançou em outra obra entre a saída e o trecho → não estende', acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-03', ultimoDia: '2026-10-03' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-01', fim: '2026-09-30' }],
    presenca: [...pres('U', '2026-10-03'), ...pres('B', '2026-10-01')],
    hoje: HOJE,
}), null);

check('Lançou dias antes de entrar na obra → antecipa a entrada', resumo(acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-09-15', ultimoDia: '2026-09-15' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-16', fim: null }],
    presenca: pres('U', '2026-09-15', '2026-09-16'),
    hoje: HOJE,
})), ['antecipar', 'u', '2026-09-15']);

check('Lançou muito antes da entrada → não antecipa', acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-09-01', ultimoDia: '2026-09-01' },
    estadias: [{ id: 'u', obraId: 'U', inicio: '2026-09-20', fim: null }],
    presenca: pres('U', '2026-09-01', '2026-09-20'),
    hoje: HOJE,
}), null);

check('Estadia vizinha em outra obra → estadia retroativa', acaoDoTrecho({
    trecho: { obraId: 'U', primeiroDia: '2026-10-01', ultimoDia: '2026-10-01' },
    estadias: [{ id: 'b', obraId: 'B', inicio: '2026-09-01', fim: '2026-09-30' }],
    presenca: pres('U', '2026-10-01'),
    hoje: HOJE,
}), null);

console.log(out.join('\n'));
const falhas = out.filter(l => l.startsWith('FAIL')).length;
console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
