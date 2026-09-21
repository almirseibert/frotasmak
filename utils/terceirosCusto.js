// utils/terceirosCusto.js
// ============================================================================
// Custo de contratos de terceiros, no SERVIDOR.
//
// Porte da regra que vive em frontend/src/utils/terceirizados.js (computeContrato).
// Aquele arquivo continua sendo a fonte de verdade da página Terceirizados, que
// calcula no cliente a partir do DataContext. O Panorama não tem esse contexto
// carregado — é uma tela de leitura rápida, não pode puxar refuelings, comboio,
// parceiros e pagamentos inteiros só para somar um saldo — então a mesma conta é
// feita aqui, em SQL restrito aos veículos dos terceiros com contrato.
//
// As máquinas de um contrato são DERIVADAS (terceiro × obra do lançamento ×
// subgrupo × data), não digitadas. Ver o cabeçalho de terceirizados.js no frontend.
//
//   saldo a pagar = valorTotal (vigente) − diesel abatido − adiantamentos
//
// Se as duas implementações divergirem, o mesmo contrato mostra saldos diferentes
// em duas telas e a direção para de confiar nas duas. Ao mexer em uma, conferir a
// outra.
// ============================================================================

// Estados TERMINAIS de um contrato de terceiro. Um contrato conta para dinheiro
// enquanto não chega a um deles — `assinado` NÃO é terminal, é uma promoção de
// `ativo` (o upload do contrato assinado congela a minuta).
// Espelhado no frontend em `src/utils/terceirizados.js` (STATUS_ENCERRADOS).
// As duas listas precisam ser iguais: foi a divergência entre elas que fez o
// Panorama e a página Terceirizados mostrarem saldos diferentes.
const STATUS_ENCERRADOS = ['concluido', 'cancelado'];

// O sistema grava as DUAS grafias de concluída (com e sem acento) — por isso existe
// o helper canônico. Comparar com a string acentuada crua descartava em silêncio todo
// abastecimento gravado sem acento: não abatia do contrato e nem aparecia como
// pendência, simplesmente sumia. Mesmo helper usado pelo comboio.
const { isConcluida, STATUS_BLOQUEADOS } = require('../services/comboioEstoqueService');

const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
// O driver MySQL devolve DATE/TIMESTAMP como objeto Date; String(date).slice(0,10)
// daria "Wed Mar 11" e toda comparação de vigência falharia em silêncio.
const ymd = (d) => {
    if (!d) return null;
    if (d instanceof Date) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return String(d).slice(0, 10);
};

// Comboio grava o combustível com a chave do sistema ('dieselS10'); a tabela de
// preço do posto usa o rótulo comercial. Mesmo de-para do frontend.
const COMBOIO_FUEL_KEY = {
    dieselS10: 'Diesel S10',
    dieselComum: 'Diesel S500',
};

// Lista digitada de máquinas. LEGADO: só vale para contrato já encerrado, para que
// saldo histórico não mude de valor porque o modelo mudou. Contrato vigente deriva.
// Espelha `contratoMaquinaIds`/`usaListaLegada` do frontend.
const maquinasDoContrato = (c) => {
    let m = c.maquinas;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = []; } }
    return Array.isArray(m) ? m.filter(Boolean) : [];
};

const isEncerrado = (c) => STATUS_ENCERRADOS.includes(String(c?.status || 'ativo').toLowerCase());
const usaListaLegada = (c) => isEncerrado(c) && maquinasDoContrato(c).length > 0;

// ─── Derivação máquina ↔ contrato ───────────────────────────────────────────
// Espelho EXATO de `veiculoElegivelAoContrato` em frontend/src/utils/terceirizados.js.
// O que liga um lançamento a um contrato: terceiro × obra do lançamento × subgrupo
// × data na vigência. Nunca `vehicles.obraAtualId` — a máquina transita entre obras
// e o contrato apura um período; usar o estado atual reescreveria o passado.
const subgruposDoContrato = (c) => {
    let itens = c?.vigente?.itensContratados ?? c?.itensContratados;
    if (typeof itens === 'string') { try { itens = JSON.parse(itens); } catch { itens = []; } }
    if (!Array.isArray(itens)) return [];
    return [...new Set(itens.map(i => String(i?.type || '').trim()).filter(Boolean))];
};

// `type` é o SUBGRUPO quando o tipo tem subgrupos cadastrados e o próprio TIPO
// quando não tem — por isso olha os dois campos do veículo.
const casaSubgrupo = (v, type) => {
    const t = String(type || '').trim();
    if (!t) return false;
    const sub = String(v?.sub_tipo || '').trim();
    if (sub) return sub === t;
    return String(v?.tipo || '').trim() === t;
};

const veiculoElegivel = (v, c) => {
    if (!v || !c) return false;
    if (!v.isOutsourced) return false;
    if (!v.locadorId || String(v.locadorId) !== String(c.locadorId)) return false;
    const subs = subgruposDoContrato(c);
    if (subs.length === 0) return true;      // contrato sem plano por subgrupo
    return subs.some(t => casaSubgrupo(v, t));
};

/**
 * Calcula valor, diesel abatido, adiantamentos e saldo de cada contrato.
 *
 * @param {object} db            pool mysql2
 * @param {Array}  contratos     contratos ativos JÁ com o bloco `vigente`
 *                               (utils/contratoAditivos.anexarVigente)
 * @returns {Map<string, {valorTotal,diesel,adiantamentos,saldo,horasContratadas}>}
 *          indexado por contratoId
 */
async function calcularCustoContratos(db, contratos) {
    const out = new Map();
    if (!contratos?.length) return out;

    const idsContratos = contratos.map(c => String(c.id));
    const obraIds = [...new Set(contratos.map(c => c.obraId).filter(Boolean).map(String))];
    const locadorIds = [...new Set(contratos.map(c => c.locadorId).filter(Boolean).map(String))];

    // ── Veículos dos terceiros envolvidos ────────────────────────────────────
    // Carrega o cadastro que decide a elegibilidade (locador + subgrupo). Sem ele
    // não há como derivar: a máquina não está mais escrita no contrato.
    const veiculos = new Map(); // vehicleId → { locadorId, isOutsourced, tipo, sub_tipo }
    if (locadorIds.length) {
        try {
            const [rows] = await db.query(`
                SELECT id, locadorId, isOutsourced, tipo, sub_tipo
                FROM vehicles
                WHERE isOutsourced = 1 AND locadorId IN (${locadorIds.map(() => '?').join(',')})
            `, locadorIds);
            rows.forEach(v => veiculos.set(String(v.id), v));
        } catch (e) {
            console.warn('⚠️ Custo de terceiros: veículos indisponíveis —', e.code || e.message);
        }
    }
    // Contratos encerrados que ainda leem a lista digitada precisam do cadastro
    // daquelas máquinas mesmo que hoje não casem com o terceiro (troca de locador).
    const idsLegado = [...new Set(contratos.filter(usaListaLegada).flatMap(maquinasDoContrato).map(String))];
    const faltantes = idsLegado.filter(id => !veiculos.has(id));
    if (faltantes.length) {
        try {
            const [rows] = await db.query(
                `SELECT id, locadorId, isOutsourced, tipo, sub_tipo FROM vehicles WHERE id IN (${faltantes.map(() => '?').join(',')})`,
                faltantes);
            rows.forEach(v => veiculos.set(String(v.id), v));
        } catch { /* fica sem: o contrato encerrado apenas não lista a máquina */ }
    }

    const idsMaquinas = [...new Set([...veiculos.keys(), ...idsLegado])];

    // ── Preço de combustível do posto (fallback quando o lançamento não tem) ──
    const precoPosto = new Map(); // `${partnerId}|${fuelType}` → preço
    try {
        const [rows] = await db.query('SELECT partnerId, fuelType, price FROM partner_fuel_prices');
        rows.forEach(r => precoPosto.set(`${r.partnerId}|${r.fuelType}`, num(r.price)));
    } catch { /* tabela ausente: fica sem fallback, o diesel usa só o preço do lançamento */ }

    // ── Abastecimentos comuns das máquinas dos contratos ─────────────────────
    // ATENÇÃO: em `refuelings` a coluna de data chama-se `data`, não `date`. O
    // frontend não tropeça nisso porque lê `rec.date ?? rec.data`; em SQL o nome
    // errado é ER_BAD_FIELD_ERROR e derruba a consulta inteira.
    let refuelings = [];
    if (idsMaquinas.length) {
        try {
            const [rows] = await db.query(`
                SELECT vehicleId, obraId, data AS data, status, fuelType, partnerId,
                       litrosAbastecidos, pricePerLiter
                FROM refuelings
                WHERE vehicleId IN (${idsMaquinas.map(() => '?').join(',')})
            `, idsMaquinas);
            refuelings = rows;
        } catch (e) {
            console.warn('⚠️ Custo de terceiros: refuelings indisponível —', e.code || e.message);
        }
    }

    // ── Saídas de comboio para essas máquinas ────────────────────────────────
    // comboio_transactions NÃO tem pricePerLiter: tem `valorTotal`, que é o valor
    // fechado do movimento — melhor que preço × litros, porque já é o número que o
    // lançamento registrou.
    let saidas = [];
    if (idsMaquinas.length) {
        try {
            const [rows] = await db.query(`
                SELECT receivingVehicleId, comboioVehicleId, obraId, status, date, fuelType, liters, valorTotal, partnerId
                FROM comboio_transactions
                WHERE type = 'saida'
                  AND receivingVehicleId IN (${idsMaquinas.map(() => '?').join(',')})
            `, idsMaquinas);
            saidas = rows;
        } catch (e) {
            console.warn('⚠️ Custo de terceiros: saídas de comboio indisponíveis —', e.code || e.message);
        }
    }

    // Saída sem valor lançado: deriva o preço da última ENTRADA do mesmo comboio e
    // combustível anterior à saída (regra do frontend), como valorTotal ÷ litros.
    const comboiosEnvolvidos = [...new Set(saidas.map(s => s.comboioVehicleId).filter(Boolean))];
    let entradas = [];
    if (comboiosEnvolvidos.length) {
        try {
            const [rows] = await db.query(`
                SELECT comboioVehicleId, date, fuelType, liters, valorTotal, partnerId
                FROM comboio_transactions
                WHERE type = 'entrada'
                  AND comboioVehicleId IN (${comboiosEnvolvidos.map(() => '?').join(',')})
                ORDER BY date ASC
            `, comboiosEnvolvidos);
            entradas = rows;
        } catch (e) {
            console.warn('⚠️ Custo de terceiros: entradas de comboio indisponíveis —', e.code || e.message);
        }
    }
    const entradasPorChave = new Map();
    entradas.forEach(e => {
        const k = `${e.comboioVehicleId}|${e.fuelType}`;
        if (!entradasPorChave.has(k)) entradasPorChave.set(k, []);
        entradasPorChave.get(k).push(e);
    });

    // Valor (R$) de uma saída de comboio.
    const valorDaSaida = (s) => {
        const lancado = num(s.valorTotal);
        if (lancado > 0) return lancado;               // o próprio movimento já traz o valor

        const litros = num(s.liters);
        if (litros <= 0) return 0;

        const lista = entradasPorChave.get(`${s.comboioVehicleId}|${s.fuelType}`) || [];
        const dataSaida = ymd(s.date);
        let ultima = null;
        for (const e of lista) {                       // já vem ordenada por data
            if (dataSaida && ymd(e.date) > dataSaida) break;
            ultima = e;
        }
        if (!ultima) return 0;

        const litrosEntrada = num(ultima.liters);
        const valorEntrada = num(ultima.valorTotal);
        if (litrosEntrada > 0 && valorEntrada > 0) return litros * (valorEntrada / litrosEntrada);

        const rotulo = COMBOIO_FUEL_KEY[s.fuelType] || s.fuelType;
        return litros * (precoPosto.get(`${ultima.partnerId}|${rotulo}`) || 0);
    };

    const precoDoAbastecimento = (r) => {
        const direto = num(r.pricePerLiter);
        if (direto > 0) return direto;
        return precoPosto.get(`${r.partnerId}|${r.fuelType}`) || 0;
    };

    // ── Adiantamentos por contrato ───────────────────────────────────────────
    const adiantPorContrato = new Map();
    try {
        const [rows] = await db.query(`
            SELECT contratoId, SUM(valor) AS total
            FROM terceirizado_pagamentos
            WHERE contratoId IN (${idsContratos.map(() => '?').join(',')})
            GROUP BY contratoId
        `, idsContratos);
        rows.forEach(r => adiantPorContrato.set(String(r.contratoId), num(r.total)));
    } catch { /* sem pagamentos lançados */ }

    // ── Fechamento por contrato ──────────────────────────────────────────────
    contratos.forEach(c => {
        const vig = c.vigente || {};
        // Legado (contrato encerrado): lista digitada. Vigente: derivação.
        const legado = usaListaLegada(c) ? new Set(maquinasDoContrato(c).map(String)) : null;
        const pertence = (vehicleId, recObraId) => {
            if (!vehicleId) return false;
            // Lançamento sem obra não tem contrato a que pertencer — vira pendência
            // na tela de Terceirizados, não entra em rateio nenhum.
            if (!recObraId || String(recObraId) !== String(c.obraId)) return false;
            if (legado) return legado.has(String(vehicleId));
            return veiculoElegivel(veiculos.get(String(vehicleId)), c);
        };
        // Aditivo de prazo estende a janela de apuração — por isso a vigência vem
        // do bloco vigente, não da coluna original.
        const ini = ymd(c.vigenciaInicio);
        const fim = ymd(vig.vigenciaFim || c.vigenciaFim);
        const naJanela = (d) => {
            const x = ymd(d);
            if (!x) return false;
            if (ini && x < ini) return false;
            if (fim && x > fim) return false;
            return true;
        };

        let diesel = 0;
        refuelings.forEach(r => {
            if (r.status && !isConcluida(r.status)) return;
            if (!pertence(r.vehicleId, r.obraId)) return;
            if (!naJanela(r.data)) return;
            diesel += num(r.litrosAbastecidos) * precoDoAbastecimento(r);
        });
        saidas.forEach(s => {
            // Saída BLOQUEADA (leitura/orçamento) é pendente, não consumada: abatê-la
            // do contrato cobraria do terceiro um diesel que ainda não saiu do tanque.
            if (STATUS_BLOQUEADOS.includes(s.status)) return;
            if (!pertence(s.receivingVehicleId, s.obraId)) return;
            if (!naJanela(s.date)) return;
            diesel += valorDaSaida(s);
        });

        const valorTotal = num(vig.valorTotal ?? c.valorTotal);
        const adiantamentos = adiantPorContrato.get(String(c.id)) || 0;

        out.set(String(c.id), {
            valorTotal,
            diesel,
            adiantamentos,
            saldo: valorTotal - diesel - adiantamentos,
            horasContratadas: num(vig.horasContratadas ?? c.horasContratadas),
        });
    });

    return out;
}

module.exports = {
    calcularCustoContratos, maquinasDoContrato, STATUS_ENCERRADOS,
    // Derivação máquina ↔ contrato, reusada pelo Panorama (planejamentoController).
    veiculoElegivel, usaListaLegada, subgruposDoContrato,
};
