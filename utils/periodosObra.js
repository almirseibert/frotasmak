// utils/periodosObra.js
//
// Um veículo não pode estar em duas obras no mesmo dia. Esta é a regra única
// usada por alocação, desalocação e edição de histórico (e pela auditoria em
// scripts/auditar-sobreposicoes-obra.js) — antes nenhuma delas conferia, e o
// sistema aceitava saída da obra A em 09/08 com entrada na obra B em 04/08.
//
// Fonte: obras_historico_veiculos (o que cada obra mostra e o que o usuário
// edita). vehicle_history é espelho e segue o que for gravado aqui.
//
// COMPARAÇÃO POR DIA, NÃO POR INSTANTE. As datas vêm de três jeitos no banco:
// 00:00 BRT (data digitada e gravada como string), 21:00 BRT do dia ANTERIOR
// (data digitada e convertida por `new Date('AAAA-MM-DD')`, que é meia-noite
// UTC) e horários quebrados (default `new Date()`). O dia UTC do instante
// acerta os três casos: 00:00 BRT = 03:00Z (mesmo dia), 21:00 BRT da véspera
// = 00:00Z (dia digitado). Só um lançamento genuíno entre 21h e 24h cairia no
// dia seguinte — irrelevante para esta regra.
//
// TROCA NO MESMO DIA É PERMITIDA: sair da A em 04/08 e entrar na B em 04/08 não
// é conflito. Conflito é haver pelo menos um dia inteiro em comum.

const FIM_ABERTO = '9999-12-31';

/** Dia civil ('AAAA-MM-DD') de um Date/string do banco ou do request; null se vazio/inválido. */
const diaCivil = (valor) => {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
    const d = valor instanceof Date ? valor : new Date(valor);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
};

/** 'AAAA-MM-DD' → 'DD/MM/AAAA'. */
const diaBR = (dia) => (dia ? dia.split('-').reverse().join('/') : '');

/**
 * Dois períodos [inicio, fim] (dias civis; fim null = ainda aberto) têm pelo
 * menos um dia em comum além do dia da troca?
 */
const sobrepoe = (a, b) => {
    const aFim = a.fim || FIM_ABERTO;
    const bFim = b.fim || FIM_ABERTO;
    return a.inicio < bFim && b.inicio < aFim;
};

const rotuloObra = (nome, orgao) => {
    const o = orgao && String(orgao).trim();
    return o ? `${nome || 'Obra'} (${o})` : (nome || 'Obra não identificada');
};

/**
 * Estadias do veículo em obra que colidem com [inicio, fim].
 *
 * @param {object} conn          conexão ou pool (mysql2/promise)
 * @param {string} veiculoId
 * @param {{inicio: any, fim?: any}} periodo  datas em qualquer formato aceito por diaCivil
 * @param {{ignorarIds?: string[]}} opts      estadias a desconsiderar (a própria, ao editar)
 * @returns {Promise<Array<{historyId, obraId, obraNome, dataEntrada, dataSaida}>>}
 */
const buscarConflitosObra = async (conn, veiculoId, periodo, { ignorarIds = [] } = {}) => {
    const alvo = { inicio: diaCivil(periodo.inicio), fim: diaCivil(periodo.fim) };
    if (!alvo.inicio) return [];

    const [rows] = await conn.execute(
        `SELECT h.id, h.obraId, h.dataEntrada, h.dataSaida, o.nome, o.orgao_contratante
           FROM obras_historico_veiculos h
           LEFT JOIN obras o ON o.id = h.obraId
          WHERE h.veiculoId = ?
          ORDER BY h.dataEntrada ASC`,
        [String(veiculoId)]
    );

    const ignorar = new Set(ignorarIds.filter(Boolean).map(String));
    return rows
        .filter(r => !ignorar.has(String(r.id)))
        .map(r => ({
            historyId: r.id,
            obraId: r.obraId,
            obraNome: rotuloObra(r.nome, r.orgao_contratante),
            dataEntrada: diaCivil(r.dataEntrada),
            dataSaida: diaCivil(r.dataSaida),
        }))
        .filter(c => c.dataEntrada && sobrepoe(alvo, { inicio: c.dataEntrada, fim: c.dataSaida }));
};

/** Frase para o usuário: "está em Mata (SEDUR) de 17/07/2026 a 10/08/2026". */
const descreverConflito = (c) => c.dataSaida
    ? `está em ${c.obraNome} de ${diaBR(c.dataEntrada)} a ${diaBR(c.dataSaida)}`
    : `está em ${c.obraNome} desde ${diaBR(c.dataEntrada)} (alocação em aberto)`;

/**
 * Erro 409 padronizado. Mesmo `code` da estadia retroativa, para o frontend
 * tratar os dois do mesmo jeito.
 */
const erroSobreposicao = (conflitos, { placa, acao }) => {
    const quem = placa || 'O veículo';
    const lista = conflitos.map(descreverConflito).join('; ');
    const err = new Error(
        `${quem} ${lista}. Um veículo não pode estar em duas obras no mesmo dia — ` +
        `${acao || 'ajuste as datas do outro período antes de continuar'}.`
    );
    err.statusCode = 409;
    err.code = 'PERIODO_SOBREPOSTO';
    err.conflicts = conflitos;
    return err;
};

/** Corpo HTTP do erro gerado por erroSobreposicao. */
const respostaSobreposicao = (err) => ({
    error: err.message,
    code: 'PERIODO_SOBREPOSTO',
    conflicts: err.conflicts || [],
});

/**
 * Todas as sobreposições da frota (auditoria). Um par por colisão.
 * @returns {Promise<Array<{veiculoId, registroInterno, placa, a, b, diasEmComum}>>}
 */
const listarSobreposicoes = async (conn) => {
    const [rows] = await conn.query(
        `SELECT h.id, h.veiculoId, h.obraId, h.dataEntrada, h.dataSaida,
                o.nome, o.orgao_contratante, v.registroInterno, v.placa
           FROM obras_historico_veiculos h
           LEFT JOIN obras o ON o.id = h.obraId
           LEFT JOIN vehicles v ON v.id = h.veiculoId
          ORDER BY h.veiculoId, h.dataEntrada`
    );

    const porVeiculo = new Map();
    for (const r of rows) {
        const inicio = diaCivil(r.dataEntrada);
        if (!inicio) continue;
        if (!porVeiculo.has(r.veiculoId)) porVeiculo.set(r.veiculoId, []);
        porVeiculo.get(r.veiculoId).push({
            historyId: r.id,
            obraId: r.obraId,
            obraNome: rotuloObra(r.nome, r.orgao_contratante),
            dataEntrada: inicio,
            dataSaida: diaCivil(r.dataSaida),
            registroInterno: r.registroInterno,
            placa: r.placa,
        });
    }

    const hoje = diaCivil(new Date());
    const diasEntre = (ini, fim) => Math.round((Date.parse(fim) - Date.parse(ini)) / 86400000);

    const resultado = [];
    for (const [veiculoId, estadias] of porVeiculo) {
        for (let i = 0; i < estadias.length; i++) {
            for (let j = i + 1; j < estadias.length; j++) {
                const a = estadias[i];
                const b = estadias[j];
                if (!sobrepoe({ inicio: a.dataEntrada, fim: a.dataSaida }, { inicio: b.dataEntrada, fim: b.dataSaida })) continue;
                const ini = a.dataEntrada > b.dataEntrada ? a.dataEntrada : b.dataEntrada;
                const fimA = a.dataSaida || hoje;
                const fimB = b.dataSaida || hoje;
                const fim = fimA < fimB ? fimA : fimB;
                const strip = ({ registroInterno, placa, ...e }) => e;
                resultado.push({
                    veiculoId,
                    registroInterno: a.registroInterno,
                    placa: a.placa,
                    a: strip(a),
                    b: strip(b),
                    diasEmComum: Math.max(diasEntre(ini, fim), 0),
                });
            }
        }
    }
    return resultado.sort((x, y) => (y.b.dataEntrada || '').localeCompare(x.b.dataEntrada || ''));
};

module.exports = {
    diaCivil,
    sobrepoe,
    buscarConflitosObra,
    erroSobreposicao,
    respostaSobreposicao,
    listarSobreposicoes,
};
