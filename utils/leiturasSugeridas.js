// utils/leiturasSugeridas.js
//
// Sugestão de leitura (horímetro/odômetro) para uma estadia retroativa: a
// máquina trabalhou de `de` a `ate` numa obra sem estar alocada, e ninguém
// anotou a leitura de entrada nem a de saída. O sistema tem leituras datadas
// espalhadas — abastecimento no posto, saída de comboio, foto do horímetro
// (evidência) e entrada/saída de outras estadias — e as mais próximas das
// pontas do trecho são a melhor aproximação:
//
//   partida = foto de horímetro de início no dia `de`; senão a última leitura
//             ANTES de `de`; senão a menor leitura no próprio dia `de`.
//   volta   = foto de horímetro de fim no dia `ate`; senão a primeira leitura
//             DEPOIS de `ate`; senão a maior leitura no próprio dia `ate`.
//
// Conferência com as horas lançadas no trecho (quando informadas): se a
// leitura seguinte não andou (Δ <= 0) ou andou absurdamente mais que o
// lançado, a volta sugerida vira partida + horas lançadas e a leitura real
// segue na resposta (`proxima`) para o usuário decidir. Caso comum: entrada/
// saída de estadia gravada copiando a leitura anterior, sem ninguém ler o
// horímetro de verdade (Δ = 0 com 18h trabalhadas). Andou menos que o lançado
// fica com a leitura real: estimar acima dela faria o horímetro voltar para
// trás na leitura seguinte.
//
// Leitura <= 1 é o "1" que se digita em terceiro sem controle de horímetro.
// Sem nenhuma leitura que sirva (e com horas informadas): partida 0, volta =
// horas lançadas.
//
// Cada sugestão volta com a origem e o dia, para o usuário julgar — leitura de
// abastecimento 20 dias depois já inclui trabalho em outra obra.

const { diaCivil } = require('./periodosObra');

const JANELA_DIAS = 60;

const shiftYmd = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

// Timestamp real (abastecimento, comboio) → dia em Brasília.
const diaBrasilia = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
};

/**
 * @param {object} conn       conexão ou pool (mysql2/promise)
 * @param {string} veiculoId
 * @param {string} de, ate    'AAAA-MM-DD'
 * @param {'horimetro'|'odometro'} tipo
 * @param {number|null} horas  horas lançadas no trecho (só faz sentido p/ horímetro)
 * @returns {Promise<{partida: Sugestao|null, volta: Sugestao|null, proxima: Sugestao|null}>}
 *          Sugestao = { valor, dia, origem, estimada? }
 */
const sugerirLeituras = async (conn, veiculoId, de, ate, tipo, horas = null) => {
    const col = tipo === 'odometro' ? 'odometro' : 'horimetro';
    const desde = shiftYmd(de, -JANELA_DIAS);
    const atePlus = shiftYmd(ate, JANELA_DIAS + 1);
    const vid = String(veiculoId);
    const leituras = []; // { valor, dia, origem, momento: 'inicio'|'fim'|null }

    const [abast] = await conn.query(
        `SELECT data, ${col} AS valor, partnerName FROM refuelings
          WHERE vehicleId = ? AND status = 'Concluída' AND ${col} > 0 AND data >= ? AND data < ?`,
        [vid, desde, atePlus]
    );
    abast.forEach(r => leituras.push({
        valor: Number(r.valor), dia: diaBrasilia(r.data),
        origem: `Abastecimento${r.partnerName ? ` (${r.partnerName})` : ''}`,
    }));

    const [comboio] = await conn.query(
        `SELECT date, ${col} AS valor, comboioVehicleName FROM comboio_transactions
          WHERE receivingVehicleId = ? AND type = 'saida' AND status = 'Concluída' AND ${col} > 0 AND date >= ? AND date < ?`,
        [vid, desde, atePlus]
    );
    comboio.forEach(r => leituras.push({
        valor: Number(r.valor), dia: diaBrasilia(r.date),
        origem: `Comboio${r.comboioVehicleName ? ` ${r.comboioVehicleName}` : ''}`,
    }));

    const [fotos] = await conn.query(
        `SELECT DATE_FORMAT(data_ref, '%Y-%m-%d') AS dia, tipo, ${col} AS valor FROM evidencia_registro
          WHERE veiculo_id = ? AND estado = 'ativo' AND ${col} > 0 AND data_ref BETWEEN ? AND ?`,
        [vid, desde, shiftYmd(ate, JANELA_DIAS)]
    );
    fotos.forEach(r => leituras.push({
        valor: Number(r.valor), dia: r.dia,
        origem: r.tipo === 'horimetro_inicio' ? 'Foto do horímetro (início do dia)'
            : r.tipo === 'horimetro_fim' ? 'Foto do horímetro (fim do dia)' : 'Foto do horímetro',
        momento: r.tipo === 'horimetro_inicio' ? 'inicio' : r.tipo === 'horimetro_fim' ? 'fim' : null,
    }));

    // Pontas de outras estadias: a entrada na obra seguinte é a leitura mais
    // fiel da volta (é exatamente onde a máquina foi depois).
    const [estadias] = await conn.query(
        `SELECT h.dataEntrada, h.dataSaida, h.${col}Entrada AS entrada, h.${col}Saida AS saida, o.nome, o.orgao_contratante
           FROM obras_historico_veiculos h LEFT JOIN obras o ON o.id = h.obraId
          WHERE h.veiculoId = ?`,
        [vid]
    );
    const nomeObra = (r) => (r.orgao_contratante ? `${r.nome} (${r.orgao_contratante})` : (r.nome || 'obra'));
    estadias.forEach(r => {
        if (Number(r.entrada) > 0) leituras.push({ valor: Number(r.entrada), dia: diaCivil(r.dataEntrada), origem: `Entrada em ${nomeObra(r)}` });
        if (Number(r.saida) > 0) leituras.push({ valor: Number(r.saida), dia: diaCivil(r.dataSaida), origem: `Saída de ${nomeObra(r)}` });
    });

    const validas = leituras.filter(l => l.valor > 1 && l.dia && l.dia >= desde && l.dia <= shiftYmd(ate, JANELA_DIAS));
    const pick = (lista, ordem) => lista.sort(ordem)[0] || null;
    const semMomento = ({ valor, dia, origem, estimada }) => ({ valor, dia, origem, ...(estimada ? { estimada } : {}) });

    let partida =
        pick(validas.filter(l => l.dia === de && l.momento === 'inicio'), (a, b) => a.valor - b.valor)
        || pick(validas.filter(l => l.dia < de), (a, b) => b.dia.localeCompare(a.dia) || b.valor - a.valor)
        || pick(validas.filter(l => l.dia === de), (a, b) => a.valor - b.valor);

    const proxima =
        pick(validas.filter(l => l.dia === ate && l.momento === 'fim'), (a, b) => b.valor - a.valor)
        || pick(validas.filter(l => l.dia > ate), (a, b) => a.dia.localeCompare(b.dia) || a.valor - b.valor)
        || pick(validas.filter(l => l.dia === ate), (a, b) => b.valor - a.valor);

    let volta = proxima;
    const h = tipo === 'horimetro' && Number(horas) > 0 ? Number(horas) : null;
    const horasTxt = h ? `${String(h).replace('.', ',')}h lançadas` : '';
    if (!partida && proxima && h && proxima.valor - h > 1) {
        // Sem leitura antes do trecho (terceiro que chegou sem registro):
        // volta é a leitura real, partida desconta as horas lançadas.
        partida = { valor: Math.round((proxima.valor - h) * 10) / 10, dia: de, origem: `Volta − ${horasTxt}`, estimada: true };
    } else if (!partida && h) {
        // Nenhuma leitura que sirva (terceiro sem controle de horímetro): a
        // estadia nasce em 0 e anda só as horas lançadas — o que importa para
        // a média é o dia alocado, não o horímetro absoluto.
        partida = { valor: 0, dia: de, origem: 'Sem leitura registrada — início em 0', estimada: true };
        volta = { valor: h, dia: ate, origem: `0 + ${horasTxt}`, estimada: true };
    } else if (partida && h) {
        const delta = proxima ? proxima.valor - partida.valor : null;
        // Não andou (leitura copiada) ou mais que o triplo (fontes em escalas
        // diferentes, digitação) → estima pelas horas.
        if (delta == null || delta <= 0 || delta > h * 3 + 50) {
            volta = {
                valor: Math.round((partida.valor + h) * 10) / 10,
                dia: ate,
                origem: `Partida + ${horasTxt}`,
                estimada: true,
            };
        }
    } else if (partida && volta && volta.valor < partida.valor) {
        // Leitura que anda para trás é erro em alguma das fontes: melhor não
        // sugerir do que sugerir algo que o backend vai recusar.
        volta = null;
    }

    return {
        partida: partida ? semMomento(partida) : null,
        volta: volta ? semMomento(volta) : null,
        proxima: proxima && volta !== proxima ? semMomento(proxima) : null,
    };
};

module.exports = { sugerirLeituras };
