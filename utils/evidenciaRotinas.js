// backend/utils/evidenciaRotinas.js
// -----------------------------------------------------------------------------
// Rotinas semanais de manutenção (limpeza de filtro / engraxamento) — Fase 10.
//
// PRINCÍPIO: a data de vencimento é uma FUNÇÃO PURA de
//     (veiculo_id, calendário de dias solicitados, config)
// Nada é sorteado em tempo de request — não há Math.random nem Date.now aqui.
// Logo é impossível "re-sortear": duas chamadas no mesmo dia para o mesmo
// equipamento devolvem sempre o mesmo resultado, e a tela não fica dançando.
//
// A tabela evidencia_rotina_agenda existe por duas razões que esta função NÃO
// cobre: carry-over (a exigência não pode evaporar se o operador não fizer no
// dia) e estabilidade histórica (mudar freq_dias não pode reescrever o passado).
// -----------------------------------------------------------------------------
const crypto = require('crypto');
const { contarDiasSolicitados, diaSolicitado } = require('./evidenciaRegras');

const TIPOS_ROTINA = ['rotina_filtro', 'rotina_graxa'];

// Âncora do calendário de ciclos. É uma SEGUNDA-FEIRA e é CONSTANTE: mudar este
// valor re-faseia a agenda de toda a frota de uma vez.
const EPOCA = '2026-01-05';

const ROTINA_PADRAO = {
    ativa: true,
    freq_dias: 5,        // em dias SOLICITADOS (≈ 1 semana), não corridos
    defasagem_dias: 2,   // idem — a 2ª rotina cai 2 dias de trabalho após a 1ª
    carry_dias: 3,       // quantos dias solicitados a exigência se arrasta
    // Trocar qual tipo ocupa o slot A a cada ciclo parece inofensivo, mas cria
    // colisão na emenda: a mesma rotina cai no slot B de um ciclo e no slot A do
    // seguinte, repetindo com 1 DIA ÚTIL de intervalo (medido: 88 ocorrências em
    // 60 equipamentos × 6 meses). Desligado, o intervalo do mesmo tipo fica em
    // 3–7 dias úteis, centrado em 5. A alternância que o negócio pediu — uma
    // rotina, a outra dois dias depois — já vem de slotA/slotB.
    alternar_ordem: false,
    tipos: TIPOS_ROTINA,
};

const ROTINA_LABEL = {
    rotina_filtro: 'Limpeza de filtro',
    rotina_graxa: 'Engraxamento',
};

// Inteiro estável de 32 bits a partir de uma string. Só precisa ser bem
// distribuído e determinístico — não é uso criptográfico.
const hash32 = (s) => crypto.createHash('sha1').update(String(s)).digest().readUInt32BE(0);

/**
 * Índice (0-based) do dia solicitado `ymd` desde a EPOCA.
 * Devolve null quando `ymd` não é dia solicitado (sáb/dom/feriado).
 */
function indiceDiaSolicitado(ymd, diasSemana, feriadoSet = null) {
    if (!diaSolicitado(ymd, { dias_semana: diasSemana }, feriadoSet)) return null;
    return contarDiasSolicitados(EPOCA, ymd, diasSemana, feriadoSet);
}

/**
 * Rotinas devidas em `ymd` para este equipamento.
 *
 * Com freq=5 e defasagem=2: vagas=3, slotA ∈ {0,1,2} e slotB = slotA+2 ∈ {2,3,4}.
 * Isso garante, por construção, que:
 *   - as duas caem no MESMO ciclo de 5 dias de trabalho (≈ 1 semana);
 *   - a segunda é exatamente 2 dias de trabalho depois da primeira;
 *   - a posição dentro do ciclo varia por ciclo E por equipamento ("aleatórios");
 *   - a ordem entre filtro e graxa alterna entre ciclos ("alternados").
 *
 * @returns {Array<{tipo: string, ciclo: number}>}
 */
function rotinasDevidas(veiculoId, ymd, { diasSemana, feriadoSet = null, cfg = ROTINA_PADRAO } = {}) {
    if (!cfg.ativa) return [];
    const n = indiceDiaSolicitado(ymd, diasSemana, feriadoSet);
    if (n == null) return [];   // fim de semana/feriado nunca SOLICITA rotina

    const freq = Math.max(2, Number(cfg.freq_dias) || ROTINA_PADRAO.freq_dias);
    const lag = Math.min(freq - 1, Math.max(1, Number(cfg.defasagem_dias) || ROTINA_PADRAO.defasagem_dias));
    const tipos = Array.isArray(cfg.tipos) && cfg.tipos.length ? cfg.tipos : TIPOS_ROTINA;

    // Fase estável por equipamento: espalha a frota em vez de sincronizar 200
    // máquinas na mesma segunda-feira.
    const off = hash32(`${veiculoId}|fase`) % freq;
    const ciclo = Math.floor((n - off) / freq);
    const diaNoCiclo = ((n - off) % freq + freq) % freq;

    const vagas = Math.max(1, freq - lag);
    const slotA = hash32(`${veiculoId}|${ciclo}`) % vagas;
    const slotB = slotA + lag;

    const inverte = cfg.alternar_ordem && (hash32(`${veiculoId}|${ciclo}|ord`) & 1) === 1;
    const [tA, tB] = inverte
        ? ['rotina_graxa', 'rotina_filtro']
        : ['rotina_filtro', 'rotina_graxa'];

    const out = [];
    if (diaNoCiclo === slotA && tipos.includes(tA)) out.push({ tipo: tA, ciclo });
    if (diaNoCiclo === slotB && tipos.includes(tB)) out.push({ tipo: tB, ciclo });
    return out;
}

/**
 * Projeta o calendário de rotinas de um equipamento num intervalo — usado pela
 * pré-visualização da aba Configurações, para o gestor conseguir CONFERIR um
 * agendador determinístico que de outro modo seria invisível.
 */
function projetarCalendario(veiculoId, de, ate, opts) {
    const { somarDias } = require('./evidenciaRegras');
    const itens = [];
    let ymd = de;
    for (let i = 0; i < 400 && ymd <= ate; i++) {
        for (const r of rotinasDevidas(veiculoId, ymd, opts)) {
            itens.push({ data: ymd, tipo: r.tipo, ciclo: r.ciclo, label: ROTINA_LABEL[r.tipo] });
        }
        ymd = somarDias(ymd, 1);
    }
    return itens;
}

module.exports = {
    TIPOS_ROTINA, ROTINA_PADRAO, ROTINA_LABEL, EPOCA,
    hash32, indiceDiaSolicitado, rotinasDevidas, projetarCalendario,
};
