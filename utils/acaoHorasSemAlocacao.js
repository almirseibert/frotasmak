// utils/acaoHorasSemAlocacao.js
//
// O que fazer com um trecho de "horas sem alocação" (aviso da aba Produção).
//
// Quando a máquina lançou horas na obra X logo depois de sair de X (ou logo
// antes de entrar em X), quase sempre ela nunca saiu: alguém desalocou antes
// da hora ou alocou depois. A correção certa é mexer na alocação de X, não
// criar uma estadia avulsa só com os dias que faltam — que deixaria buracos
// nos dias sem lançamento e a máquina "fora" da obra entre um e outro.
//
//   estender  — a estadia anterior é em X e entre a saída dela e o trecho não
//               há lançamento em outra obra: a saída passa para o último dia
//               com lançamento em X antes de a máquina aparecer em outra obra
//               (ou da próxima estadia). Próxima estadia também em X → emenda
//               na entrada dela.
//   antecipar — a próxima estadia é em X e entre o trecho e ela não há
//               lançamento em outra obra: a entrada passa para o 1º dia do trecho.
//   null      — nenhuma das duas: estadia retroativa só do trecho.
//
// Só quando o buraco é curto: a máquina tem que voltar a lançar em X até
// FOLGA_DIAS depois da saída registrada (ou ter lançado em X até FOLGA_DIAS
// antes da entrada registrada). Buraco maior pode ser a máquina parada fora da
// obra — estender encheria de dias alocados sem lançamento e derrubaria o
// h/dia; aí fica a estadia só do trecho.
//
// Presença = qualquer lançamento do dia, inclusive justificado (chuva é a
// máquina parada NA obra). Todas as datas em dia civil 'AAAA-MM-DD'.

const FOLGA_DIAS = 7;

const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/**
 * @param {object} p
 * @param {{obraId: string, primeiroDia: string, ultimoDia: string}} p.trecho
 * @param {Array<{id, obraId, inicio, fim}>} p.estadias  todas as estadias do veículo (fim null = aberta)
 * @param {Array<{dia, obraId}>} p.presenca             lançamentos do veículo
 * @param {string} p.hoje
 */
const acaoDoTrecho = ({ trecho, estadias, presenca, hoje }) => {
    const X = String(trecho.obraId);
    const d1 = trecho.primeiroDia;
    const d2 = trecho.ultimoDia;
    const emOutra = (a, b) => presenca.some(l => String(l.obraId) !== X && l.dia > a && l.dia < b);
    const diasEmX = presenca.filter(l => String(l.obraId) === X).map(l => l.dia).sort();

    const anterior = estadias
        .filter(e => e.fim && e.fim < d1)
        .sort((a, b) => b.fim.localeCompare(a.fim))[0] || null;
    const proxima = estadias
        .filter(e => e.inicio > d2)
        .sort((a, b) => a.inicio.localeCompare(b.inicio))[0] || null;

    const voltouLogo = anterior && diasEntre(anterior.fim, diasEmX.find(d => d > anterior.fim) || d1) <= FOLGA_DIAS;
    if (anterior && String(anterior.obraId) === X && !emOutra(anterior.fim, d1) && voltouLogo) {
        if (proxima && String(proxima.obraId) === X && !emOutra(d2, proxima.inicio)) {
            return { tipo: 'estender', historyId: anterior.id, obraId: X, entrada: anterior.inicio, saidaAtual: anterior.fim, novaSaida: proxima.inicio, proxima };
        }
        const limite = proxima ? proxima.inicio : hoje;
        const primeiraOutra = presenca
            .filter(l => String(l.obraId) !== X && l.dia > d2 && l.dia <= limite)
            .map(l => l.dia).sort()[0] || null;
        const teto = primeiraOutra || limite;
        const ultimaEmX = presenca
            .filter(l => String(l.obraId) === X && l.dia >= d2 && (primeiraOutra ? l.dia < teto : l.dia <= teto))
            .map(l => l.dia).sort().pop() || d2;
        return { tipo: 'estender', historyId: anterior.id, obraId: X, entrada: anterior.inicio, saidaAtual: anterior.fim, novaSaida: ultimaEmX, proxima };
    }

    const ultimoAntes = proxima && [...diasEmX].reverse().find(d => d < proxima.inicio);
    if (proxima && String(proxima.obraId) === X && !emOutra(d2, proxima.inicio)
        && diasEntre(ultimoAntes || d2, proxima.inicio) <= FOLGA_DIAS) {
        return { tipo: 'antecipar', historyId: proxima.id, obraId: X, entradaAtual: proxima.inicio, novaEntrada: d1, saida: proxima.fim };
    }

    return null;
};

module.exports = { acaoDoTrecho };
