// backend/services/abastecimentoAutoService.js
//
// =============================================================================
// MOTOR DE ACEITE E BAIXA AUTOMÁTICOS
// =============================================================================
//
// Duas entradas:
//   analisarSolicitacao(id)  -> avalia os portões G0..G5 na abertura do pedido
//   analisarComprovante(id)  -> lê o cupom e prepara o pré-preenchimento da baixa
//
// REGRA CENTRAL: a IA nunca nega. O desfecho é sempre AUTO_LIBERADO ou MANUAL.
// "MANUAL" significa apenas que a solicitação segue o caminho de hoje, com o
// gestor decidindo. Nada é recusado por causa da análise automática.
//
// ORDEM DOS PORTÕES importa e é curto-circuitada: o primeiro que não passa
// encerra a avaliação. G0 e G1 vêm antes da chamada de visão de propósito —
// solicitação inelegível ou que já viola uma regra soberana não gasta IA.
//
//   G0 elegibilidade   escopo do piloto, veículo/usuário aptos, foto presente
//   G1 regras soberanas as MESMAS de utils/regrasAbastecimento (+ leitura > atual)
//   G2 média           consumo recente dentro da faixa esperada
//   G3 necessidade     o consumo estimado justifica a litragem pedida?
//   G4 visão           leitura da foto bate com a digitada, com confiança alta
//   G5 teto            valor estimado da ordem abaixo do limite configurado
//
// Em modo 'sombra' (padrão) o resultado é apenas gravado; nada é liberado.

const crypto = require('crypto');
const db = require('../database');
const consumo = require('../utils/consumo');
const visao = require('./aiVisionService');
const {
    checkLeituraBloqueada,
    checkOrcamentoBloqueado,
    checkOrdemAbertaDuplicada,
    checkOperadorPlaceholder,
} = require('../utils/regrasAbastecimento');
const { ymdBRT } = require('../utils/dateBRT');

const DECISAO = {
    AUTO_LIBERADO: 'AUTO_LIBERADO',
    AUTO_LIBERADO_SIMULADO: 'AUTO_LIBERADO_SIMULADO',
    MANUAL: 'MANUAL',
    ERRO: 'ERRO',
};

const ETAPA = { PAINEL: 'painel', CUPOM: 'cupom' };

// ─── Configuração ────────────────────────────────────────────────────────────

let cacheConfig = null;
const TTL_CONFIG_MS = 30 * 1000;

const carregarConfig = async (conn = db) => {
    if (cacheConfig && (Date.now() - cacheConfig.at) < TTL_CONFIG_MS) return cacheConfig.valor;
    try {
        const [[linha]] = await conn.query('SELECT * FROM abastecimento_auto_config WHERE id = 1');
        cacheConfig = { at: Date.now(), valor: linha || null };
        return cacheConfig.valor;
    } catch (e) {
        console.warn('[abastecimentoAuto] falha ao ler config:', e.message);
        return null;
    }
};

const invalidarConfig = () => { cacheConfig = null; };

const listaJson = (valor) => {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor;
    try {
        const v = JSON.parse(valor);
        return Array.isArray(v) ? v : [];
    } catch { return []; }
};

// ─── Portões ─────────────────────────────────────────────────────────────────

const portao = (nome, status, detalhe, extra) => ({ nome, status, detalhe, ...(extra || {}) });
const OK = (nome, detalhe, extra) => portao(nome, 'ok', detalhe, extra);
const FALHA = (nome, detalhe, extra) => portao(nome, 'falha', detalhe, extra);
const INDETERMINADO = (nome, detalhe, extra) => portao(nome, 'indeterminado', detalhe, extra);

/**
 * G0 — elegibilidade. Barra antes de qualquer consulta cara ou chamada de IA.
 */
const avaliarG0 = (sol, veiculo, config) => {
    if (!config || config.ativo != 1) {
        return FALHA('G0_elegibilidade', 'Aceite automático desligado na configuração.');
    }
    if (!sol.foto_painel_path) {
        return FALHA('G0_elegibilidade', 'Solicitação sem foto do painel.');
    }

    const obras = listaJson(config.obras_habilitadas);
    if (obras.length === 0) {
        return FALHA('G0_elegibilidade', 'Nenhuma obra habilitada para o piloto.');
    }
    if (!obras.map(String).includes(String(sol.obra_id))) {
        return FALHA('G0_elegibilidade', 'Obra fora do escopo do piloto.');
    }

    const tipos = listaJson(config.tipos_habilitados);
    if (tipos.length > 0 && !tipos.includes(veiculo.tipo)) {
        return FALHA('G0_elegibilidade', `Tipo "${veiculo.tipo}" fora do escopo do piloto.`);
    }

    // Terceirizado pula todas as validações de leitura e orçamento — sem elas
    // não há base para liberar sozinho.
    if (veiculo.isOutsourced == 1) {
        return FALHA('G0_elegibilidade', 'Veículo terceirizado: gestão de frota é do terceiro.');
    }
    // Veículo fictício (ajuda de custo, gerador, lava-jato) aceita qualquer
    // leitura, então média e conferência de painel não significam nada.
    if (veiculo.permiteMultiplosAbastecimentos == 1) {
        return FALHA('G0_elegibilidade', 'Veículo fictício (múltiplos abastecimentos): sem leitura confiável.');
    }
    if (veiculo.isComboioVehicle == 1) {
        return FALHA('G0_elegibilidade', 'Comboio segue fluxo próprio de entrada/distribuição.');
    }
    if (veiculo.canCirculate === 0 || veiculo.canCirculate === '0') {
        return FALHA('G0_elegibilidade', 'Veículo marcado como NÃO PODE CIRCULAR.');
    }
    if (sol.usuario_bloqueado == 1) {
        return FALHA('G0_elegibilidade', 'Solicitante está bloqueado para abastecimento.');
    }

    return OK('G0_elegibilidade', 'Dentro do escopo do piloto.');
};

/**
 * G1 — regras soberanas. Usa exatamente os mesmos predicados do caminho humano.
 */
const avaliarG1 = async (conn, sol, veiculo) => {
    const odo = sol.odometro_informado != null ? parseFloat(sol.odometro_informado) : null;
    const hori = sol.horimetro_informado != null ? parseFloat(sol.horimetro_informado) : null;

    const motivoLeitura = await checkLeituraBloqueada(conn, sol.veiculo_id, odo, hori);
    if (motivoLeitura) return FALHA('G1_regras_soberanas', motivoLeitura);

    const dataRef = sol.data_solicitacao ? new Date(sol.data_solicitacao) : new Date();
    const duplicada = await checkOrdemAbertaDuplicada(conn, sol.veiculo_id, ymdBRT(dataRef));
    if (duplicada) {
        return FALHA('G1_regras_soberanas',
            `Já existe ordem em aberto Nº ${duplicada.ordem.authNumber} (${duplicada.ordem.status}) para este veículo.`);
    }

    const placeholder = await checkOperadorPlaceholder(conn, sol.veiculo_id);
    if (placeholder) {
        return FALHA('G1_regras_soberanas',
            `Veículo há ${placeholder.diasNaObra} dias na obra com operador fictício "${placeholder.employeeName}".`);
    }

    if (await checkOrcamentoBloqueado(conn, sol.obra_id)) {
        return FALHA('G1_regras_soberanas', 'Obra já consumiu 20% ou mais do contrato em combustível.');
    }

    // Leitura ESTRITAMENTE maior que a atual. checkLeituraBloqueada aceita
    // igualdade (só `<` bloqueia), e essa regra hoje só existe no frontend do
    // app do operador (SolicitacaoAbastecimentoPage). Para liberar sozinho ela
    // precisa valer aqui: leitura repetida significa veículo que não rodou, ou
    // operador copiando o valor anterior.
    const campo = await consumo.getCampoLeitura(veiculo.tipo, conn);
    const informado = campo === 'odometro' ? odo : hori;
    const atual = parseFloat(veiculo[campo] || 0);
    if (informado != null && atual > 0 && informado <= atual) {
        return FALHA('G1_regras_soberanas',
            `Leitura informada (${informado}) não é maior que a atual do veículo (${atual}).`);
    }

    return OK('G1_regras_soberanas', 'Nenhuma regra existente violada.');
};

/**
 * G2 — a média recente do veículo está dentro da faixa esperada?
 *
 * Avalia o HISTÓRICO, não a solicitação: o abastecimento ainda nem aconteceu,
 * então não há litragem real para medir. Um veículo cuja média já está fora do
 * padrão nunca é liberado sozinho.
 */
const avaliarG2 = async (conn, veiculo, config) => {
    const esperada = await consumo.resolveMediaEsperada(veiculo, {
        conn,
        toleranciaPadrao: config.tolerancia_media_padrao,
    });

    if (esperada.media == null) {
        return INDETERMINADO('G2_media',
            `Sem média de referência (fonte: ${esperada.fonte}).`, { mediaEsperada: null });
    }

    const [[hist]] = await conn.query(
        `SELECT avg_last_1, avg_last_3, unidade, intervalos_validos, intervalos_tanque_cheio
           FROM vehicle_fuel_averages WHERE vehicle_id = ? LIMIT 1`,
        [veiculo.id]
    );

    const minIntervalos = parseInt(config.min_intervalos_historico, 10) || 3;
    const intervalos = hist && hist.intervalos_validos != null ? Number(hist.intervalos_validos) : 0;
    if (intervalos < minIntervalos) {
        return INDETERMINADO('G2_media',
            `Histórico insuficiente: ${intervalos} intervalo(s), mínimo ${minIntervalos}.`,
            { mediaEsperada: esperada.media, unidade: esperada.unidade });
    }

    if (config.exigir_tanque_cheio_historico == 1) {
        const cheios = hist && hist.intervalos_tanque_cheio != null ? Number(hist.intervalos_tanque_cheio) : 0;
        if (cheios < minIntervalos) {
            return INDETERMINADO('G2_media',
                `Apenas ${cheios} intervalo(s) tanque-a-tanque, mínimo ${minIntervalos}.`,
                { mediaEsperada: esperada.media, unidade: esperada.unidade });
        }
    }

    // O QUE COMPARAR COM O QUÊ.
    //
    // Quando a média esperada vem de CADASTRO (veículo, tipo ou sub-tipo), a
    // comparação natural é o histórico recente do veículo (avg_last_3) contra
    // esse parâmetro.
    //
    // Mas quando ela vem do PRÓPRIO histórico do veículo (fonte 'historico_3'),
    // comparar avg_last_3 com avg_last_3 é tautologia: o portão passaria sempre,
    // virando um no-op exatamente no caso mais comum — nenhum veículo desta
    // frota tem media_consumo cadastrada e vehicle_type_configs está vazia.
    //
    // Nesse caso a pergunta útil muda: o ÚLTIMO abastecimento destoou da linha
    // de base do próprio veículo? Comparamos avg_last_1 contra avg_last_3.
    const usaProprioHistorico = esperada.fonte === 'historico_3';
    const observadaBruta = usaProprioHistorico
        ? parseFloat(hist.avg_last_1)
        : parseFloat(hist.avg_last_3 != null ? hist.avg_last_3 : hist.avg_last_1);

    if (usaProprioHistorico && !(observadaBruta > 0)) {
        return INDETERMINADO('G2_media', 'Sem intervalo recente para comparar com a linha de base.',
            { mediaEsperada: esperada.media, unidade: esperada.unidade });
    }

    const observada = hist.unidade === esperada.unidade
        ? observadaBruta
        : consumo.converter(observadaBruta, hist.unidade, esperada.unidade);

    if (observada == null || !isFinite(observada)) {
        return INDETERMINADO('G2_media', 'Média histórica em unidade incompatível.',
            { mediaEsperada: esperada.media, unidade: esperada.unidade });
    }

    const faixa = consumo.dentroDaTolerancia(observada, esperada.media, esperada.tolerancia);
    const rotuloObservada = usaProprioHistorico ? 'último abastecimento' : 'média recente';
    const rotuloEsperada = usaProprioHistorico ? 'linha de base do veículo' : `cadastro (${esperada.fonte})`;
    const detalheNumeros = `${rotuloObservada} ${observada.toFixed(2)} ${esperada.unidade} vs `
        + `${rotuloEsperada} ${esperada.media.toFixed(2)} ±${esperada.tolerancia}%`;

    const extra = {
        mediaObservada: observada,
        mediaEsperada: esperada.media,
        unidade: esperada.unidade,
        tolerancia: esperada.tolerancia,
        desvioPercentual: faixa.desvioPercentual,
        fonte: esperada.fonte,
        comparacao: usaProprioHistorico ? 'ultimo_vs_base' : 'recente_vs_cadastro',
    };

    return faixa.dentro
        ? OK('G2_media', `Média dentro do padrão: ${detalheNumeros}.`, extra)
        : FALHA('G2_media', `Média fora do padrão: ${detalheNumeros}.`, extra);
};

/**
 * G3 — a litragem pedida faz sentido para o quanto o veículo rodou/trabalhou?
 *
 * Para tanque cheio não há litragem informada, então o critério é outro: o
 * consumo estimado desde o último abastecimento precisa justificar um
 * enchimento (percentual mínimo do tanque) e não pode passar da capacidade.
 */
const avaliarG3 = async (conn, sol, veiculo, config, mediaG2) => {
    const unidade = await consumo.getUnidadeDoTipo(veiculo.tipo, conn);
    const campo = consumo.getReadingSourceForUnit(unidade);
    const informado = parseFloat(campo === 'odometro' ? sol.odometro_informado : sol.horimetro_informado);

    if (!(informado > 0)) {
        return INDETERMINADO('G3_necessidade', 'Leitura não informada na solicitação.');
    }
    if (!mediaG2 || !(mediaG2 > 0)) {
        return INDETERMINADO('G3_necessidade', 'Sem média de referência para estimar consumo.');
    }

    // O nome da coluna entra interpolado (placeholder ? não vale para
    // identificador). Whitelist para manter não-injetável.
    if (campo !== 'odometro' && campo !== 'horimetro') {
        return INDETERMINADO('G3_necessidade', `Campo de leitura inesperado: ${campo}`);
    }

    // Leitura da última ordem concluída — base do intervalo.
    const [[ultima]] = await conn.query(
        `SELECT ${campo} AS leitura, data
           FROM refuelings
          WHERE vehicleId = ? AND status = 'Concluída' AND ${campo} > 0
          ORDER BY data DESC LIMIT 1`,
        [veiculo.id]
    );
    if (!ultima) {
        return INDETERMINADO('G3_necessidade', 'Sem abastecimento anterior concluído para comparar.');
    }

    const delta = informado - parseFloat(ultima.leitura);
    if (!(delta > 0)) {
        return FALHA('G3_necessidade',
            `Leitura informada (${informado}) não avançou desde o último abastecimento (${ultima.leitura}).`);
    }

    const estimados = consumo.litrosEsperados(unidade, delta, mediaG2);
    if (estimados == null) {
        return INDETERMINADO('G3_necessidade', 'Não foi possível estimar o consumo do período.');
    }

    const tolerancia = parseFloat(config.tolerancia_media_padrao) || 20;

    // CAPACIDADE DO TANQUE — cadastro primeiro, estimativa como último recurso.
    //
    // Só 2% da frota tem fuelCapacity cadastrada e 70% das solicitações pedem
    // tanque cheio, então sem estimativa este portão sozinho mandaria quase tudo
    // para conferência.
    //
    // A estimativa usa o PERCENTIL 95 dos abastecimentos do veículo, não o
    // máximo. O máximo é inutilizável: a frota tem lançamentos de 4216 L numa
    // Fiat Strada (tanque real ~55 L) e 3169 L numa Oroch — erro de digitação
    // que passaria a valer como capacidade de tanque. O p95 acerta bem nos
    // leves (Strada 52 L, Oroch 46 L, Saveiro 52 L, todos próximos do real).
    //
    // ATENÇÃO ao viés: em máquinas o p95 SUBESTIMA bastante (GR1803BR dá 230 L
    // contra ~400 L reais), porque máquina quase nunca enche o tanque. E
    // subestimar não é seguro nos dois sentidos: torna o portão mais permissivo
    // no mínimo de 30% (percentual = estimado/tanque fica maior) e mais rígido
    // no teto. Por isso a estimativa é explicitamente marcada como tal, e
    // preencher fuelCapacity de verdade continua sendo o certo — ver
    // scripts/exportarModelosVeiculos.js.
    const MIN_AMOSTRAS_TANQUE = 5;
    let tanque = parseFloat(veiculo.fuelCapacity || veiculo.capacidadeTanque || 0);
    let fonteTanque = tanque > 0 ? 'cadastro' : null;
    if (!(tanque > 0)) {
        const [abastecimentos] = await conn.query(
            `SELECT litrosAbastecidos AS litros
               FROM refuelings
              WHERE vehicleId = ? AND status = 'Concluída' AND litrosAbastecidos > 0
              ORDER BY litrosAbastecidos ASC`,
            [veiculo.id]
        );
        if (abastecimentos.length >= MIN_AMOSTRAS_TANQUE) {
            const valores = abastecimentos.map((a) => parseFloat(a.litros)).filter((n) => n > 0);
            const p95 = valores[Math.min(valores.length - 1, Math.floor(valores.length * 0.95))];
            if (p95 > 0) { tanque = p95; fonteTanque = 'estimado_p95'; }
        }
    }

    const extra = {
        delta,
        unidade,
        litrosEstimados: estimados,
        capacidadeTanque: tanque > 0 ? tanque : null,
        fonteTanque,
    };

    const tanqueCheio = sol.flag_tanque_cheio == 1;
    if (tanqueCheio) {
        if (!(tanque > 0)) {
            return INDETERMINADO('G3_necessidade',
                `Tanque cheio pedido, mas o veículo não tem capacidade cadastrada e tem menos de ${MIN_AMOSTRAS_TANQUE} abastecimentos para estimá-la.`, extra);
        }
        const percentual = (estimados / tanque) * 100;
        const minimo = parseFloat(config.percentual_minimo_tanque) || 30;
        extra.percentualTanque = percentual;

        if (percentual < minimo) {
            return FALHA('G3_necessidade',
                `Consumo estimado de ${estimados.toFixed(1)} L é só ${percentual.toFixed(0)}% do tanque `
                + `(${tanque} L); mínimo para completar é ${minimo}%.`, extra);
        }
        if (estimados > tanque) {
            return FALHA('G3_necessidade',
                `Consumo estimado (${estimados.toFixed(1)} L) excede a capacidade do tanque (${tanque} L).`, extra);
        }
        return OK('G3_necessidade',
            `Consumo estimado de ${estimados.toFixed(1)} L (${percentual.toFixed(0)}% do tanque `
            + `de ${tanque.toFixed(0)} L, ${fonteTanque === 'cadastro' ? 'cadastrado' : 'estimado pelo histórico'}) `
            + 'justifica completar.', extra);
    }

    const pedidos = parseFloat(sol.litragem_solicitada || 0);
    if (!(pedidos > 0)) {
        return INDETERMINADO('G3_necessidade', 'Litragem não informada e não é tanque cheio.', extra);
    }
    extra.litrosSolicitados = pedidos;

    const teto = estimados * (1 + tolerancia / 100);
    if (pedidos > teto) {
        return FALHA('G3_necessidade',
            `Pedido de ${pedidos} L acima do estimado para o período: `
            + `${estimados.toFixed(1)} L +${tolerancia}% = ${teto.toFixed(1)} L.`, extra);
    }
    if (tanque > 0 && pedidos > tanque) {
        return FALHA('G3_necessidade',
            `Pedido de ${pedidos} L excede a capacidade do tanque (${tanque} L).`, extra);
    }

    return OK('G3_necessidade',
        `Pedido de ${pedidos} L compatível com o estimado (${estimados.toFixed(1)} L).`, extra);
};

/**
 * G4 — a leitura da foto bate com a digitada?
 *
 * A leitura é CEGA: lerPainel não recebe o valor informado. A comparação
 * acontece só aqui.
 */
const avaliarG4 = async (conn, sol, veiculo, config) => {
    const unidade = await consumo.getUnidadeDoTipo(veiculo.tipo, conn);
    const campo = consumo.getReadingSourceForUnit(unidade);
    const informado = parseFloat(campo === 'odometro' ? sol.odometro_informado : sol.horimetro_informado);

    const leitura = await visao.lerPainel(sol.foto_painel_path, { tipoLeitura: campo, config });

    const extra = {
        valorIa: leitura.valor,
        valorInformado: isFinite(informado) ? informado : null,
        confianca: leitura.confianca,
        modelo: leitura.modelo,
        escalonou: leitura.escalonou,
        observacaoIa: leitura.observacao,
        leituraCompleta: leitura,
    };

    if (!leitura.ok) {
        return INDETERMINADO('G4_visao', `Não foi possível ler a foto: ${leitura.observacao}`, extra);
    }
    if (!leitura.legivel || leitura.valor == null) {
        return INDETERMINADO('G4_visao', `Foto ilegível: ${leitura.observacao}`, extra);
    }

    const limiar = parseFloat(config.confianca_minima_painel);
    if (leitura.confianca < limiar) {
        return INDETERMINADO('G4_visao',
            `Confiança da leitura (${(leitura.confianca * 100).toFixed(0)}%) abaixo do mínimo `
            + `(${(limiar * 100).toFixed(0)}%).`, extra);
    }

    // Odômetro lido onde se esperava horímetro (ou vice-versa) indica foto do
    // medidor errado — caso clássico de máquina com os dois no painel.
    if (leitura.tipoMedidor !== 'indefinido' && leitura.tipoMedidor !== campo) {
        return FALHA('G4_visao',
            `A foto mostra ${leitura.tipoMedidor}, mas este veículo é medido por ${campo}.`, extra);
    }

    if (!isFinite(informado)) {
        return INDETERMINADO('G4_visao', 'Solicitação sem leitura digitada para comparar.', extra);
    }

    const tolerancia = campo === 'odometro'
        ? parseFloat(config.tolerancia_leitura_km)
        : parseFloat(config.tolerancia_leitura_hr);
    const diferenca = Math.abs(leitura.valor - informado);
    extra.diferenca = diferenca;

    if (diferenca > tolerancia) {
        return FALHA('G4_visao',
            `Leitura da foto (${leitura.valor}) diverge da informada (${informado}) `
            + `em ${diferenca.toFixed(2)}, acima da tolerância de ${tolerancia}.`, extra);
    }

    return OK('G4_visao',
        `Foto confere: ${leitura.valor} vs ${informado} informado `
        + `(confiança ${(leitura.confianca * 100).toFixed(0)}%).`, extra);
};

/**
 * G5 — teto de valor da ordem liberável automaticamente.
 */
const avaliarG5 = async (conn, sol, config, litrosEstimados) => {
    const limite = parseFloat(config.limite_valor_auto);
    if (!(limite > 0)) return OK('G5_teto', 'Sem teto de valor configurado.');

    const litros = sol.flag_tanque_cheio == 1
        ? litrosEstimados
        : parseFloat(sol.litragem_solicitada || 0);

    if (!(litros > 0)) {
        return INDETERMINADO('G5_teto', 'Sem litragem para estimar o valor da ordem.');
    }

    const [[preco]] = await conn.query(
        'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ? LIMIT 1',
        [sol.posto_id || null, sol.tipo_combustivel || null]
    );
    if (!preco || !(parseFloat(preco.price) > 0)) {
        return INDETERMINADO('G5_teto', 'Posto sem preço cadastrado para este combustível.');
    }

    const valor = litros * parseFloat(preco.price);
    const extra = { litros, precoLitro: parseFloat(preco.price), valorEstimado: valor, limite };

    return valor > limite
        ? FALHA('G5_teto',
            `Valor estimado R$ ${valor.toFixed(2)} acima do teto automático de R$ ${limite.toFixed(2)}.`, extra)
        : OK('G5_teto', `Valor estimado R$ ${valor.toFixed(2)} dentro do teto.`, extra);
};

// ─── Persistência da análise ─────────────────────────────────────────────────

const registrarAnalise = async (conn, { solicitacaoId, etapa, leitura, portoes, decisao, erro }) => {
    try {
        await conn.query(
            `INSERT INTO solicitacao_ia_analises
               (id, solicitacao_id, etapa, modelo, escalonou, resposta_json, confianca,
                portoes_json, decisao, input_tokens, output_tokens, latencia_ms, erro)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                crypto.randomUUID(), solicitacaoId, etapa,
                leitura ? leitura.modelo : null,
                leitura && leitura.escalonou ? 1 : 0,
                leitura ? JSON.stringify(leitura.bruto || leitura) : null,
                leitura && leitura.confianca != null ? leitura.confianca : null,
                JSON.stringify(portoes || []),
                decisao,
                leitura ? leitura.inputTokens : null,
                leitura ? leitura.outputTokens : null,
                leitura ? leitura.latenciaMs : null,
                erro ? String(erro).slice(0, 2000) : null,
            ]
        );
    } catch (e) {
        console.warn('[abastecimentoAuto] falha ao registrar análise:', e.message);
    }
};

// Motivo resumido para o gestor: o primeiro portão que não passou.
const resumirMotivo = (portoes) => {
    const problema = portoes.find((p) => p.status !== 'ok');
    return problema ? problema.detalhe : 'Todos os critérios atendidos.';
};

// ─── Aviso ao solicitante ────────────────────────────────────────────────────

/**
 * Notifica o operador por WhatsApp que a ordem saiu automaticamente.
 * Reaproveita a sessão do chatbot, mesmo caminho da negativa manual em
 * solicitacaoAdminController. Nunca lança: aviso é acessório, não pode
 * derrubar a emissão que já aconteceu.
 */
const notificarLiberacaoAutomatica = async (sol, authNumber) => {
    const whatsappService = require('./whatsappService');
    const [userRows] = await db.query(
        `SELECT u.name, wcs.phone_number
           FROM users u
           JOIN whatsapp_chatbot_sessions wcs
             ON JSON_UNQUOTE(JSON_EXTRACT(wcs.session_data, '$.employee_uuid')) = u.employeeId
          WHERE u.id = ?
          ORDER BY wcs.last_activity DESC
          LIMIT 1`,
        [sol.usuario_id]
    );
    const solicitante = userRows[0];
    if (!solicitante || !solicitante.phone_number) return;

    const [[veiculo]] = await db.query(
        'SELECT placa, registroInterno FROM vehicles WHERE id = ?',
        [sol.veiculo_id]
    );
    const partes = [veiculo?.registroInterno && `RE ${veiculo.registroInterno}`, veiculo?.placa].filter(Boolean);
    const nomeVeiculo = partes.length ? partes.join(' – ') : `ID ${sol.veiculo_id}`;

    await whatsappService.enviarMensagem(
        solicitante.phone_number,
        solicitante.name,
        'liberacao_automatica',
        `✅ *Abastecimento Liberado*

Sua solicitação para o veículo *${nomeVeiculo}* foi liberada `
        + `automaticamente.

*Ordem Nº ${authNumber}* já foi enviada ao posto.

`
        + 'Após abastecer, envie a foto do cupom pelo app.'
    );
};

// ─── Análise da solicitação (painel) ─────────────────────────────────────────

/**
 * Avalia uma solicitação e grava o parecer. Nunca lança.
 * Em modo 'sombra' não altera o status da solicitação.
 *
 * @returns {Promise<{decisao, portoes, motivo}>}
 */
const analisarSolicitacao = async (solicitacaoId) => {
    const portoes = [];
    let leituraPainel = null;

    try {
        const config = await carregarConfig();
        if (!config) {
            return { decisao: DECISAO.MANUAL, portoes, motivo: 'Configuração do aceite automático indisponível.' };
        }

        const [[sol]] = await db.query(
            `SELECT s.*, u.bloqueado_abastecimento AS usuario_bloqueado
               FROM solicitacoes_abastecimento s
               LEFT JOIN users u ON u.id = s.usuario_id
              WHERE s.id = ?`,
            [solicitacaoId]
        );
        if (!sol) return { decisao: DECISAO.ERRO, portoes, motivo: 'Solicitação não encontrada.' };

        // Solicitação que já saiu de PENDENTE foi resolvida por um humano antes
        // de a fila chegar nela — não faz sentido opinar.
        if (sol.status !== 'PENDENTE') {
            return { decisao: DECISAO.MANUAL, portoes, motivo: `Solicitação já está em ${sol.status}.` };
        }

        const [[veiculo]] = await db.query('SELECT * FROM vehicles WHERE id = ?', [sol.veiculo_id]);
        if (!veiculo) return { decisao: DECISAO.ERRO, portoes, motivo: 'Veículo não encontrado.' };

        // G0 e G1 antes da IA: não gastar chamada em pedido que já está barrado.
        portoes.push(avaliarG0(sol, veiculo, config));
        if (portoes[0].status === 'ok') portoes.push(await avaliarG1(db, sol, veiculo));

        let litrosEstimados = null;
        if (portoes.every((p) => p.status === 'ok')) {
            const g2 = await avaliarG2(db, veiculo, config);
            portoes.push(g2);

            if (g2.status === 'ok') {
                const g3 = await avaliarG3(db, sol, veiculo, config, g2.mediaEsperada);
                portoes.push(g3);
                litrosEstimados = g3.litrosEstimados || null;

                if (g3.status === 'ok') {
                    const g4 = await avaliarG4(db, sol, veiculo, config);
                    portoes.push(g4);
                    leituraPainel = g4.leituraCompleta || null;

                    if (g4.status === 'ok') {
                        portoes.push(await avaliarG5(db, sol, config, litrosEstimados));
                    }
                }
            }
        }

        const todosOk = portoes.length > 0 && portoes.every((p) => p.status === 'ok');
        const modoSombra = config.modo !== 'ativo';
        let decisao = !todosOk
            ? DECISAO.MANUAL
            : (modoSombra ? DECISAO.AUTO_LIBERADO_SIMULADO : DECISAO.AUTO_LIBERADO);

        let motivo = resumirMotivo(portoes);
        let ordemEmitida = null;

        // ─── MODO ATIVO: emite a ordem de verdade ───
        // Usa criarOrdem, o MESMO núcleo do POST /api/refuelings que o gestor
        // aciona pela tela. Não é uma reimplementação: as travas, o empenho de
        // saldo pré-pago e o envio da ordem ao posto são exatamente os mesmos.
        //
        // criarOrdem roda as travas soberanas de novo, dentro da própria
        // transação e com FOR UPDATE. Isso é redundante com o portão G1 de
        // propósito: entre a análise e a emissão podem passar segundos, e nesse
        // intervalo outra ordem pode ter sido aberta para o mesmo veículo.
        // Se ela recusar, a solicitação simplesmente segue para o humano.
        if (todosOk && !modoSombra) {
            const resultado = await require('../controllers/refuelingController').criarOrdem({
                vehicleId: sol.veiculo_id,
                partnerId: sol.posto_id || null,
                employeeId: sol.funcionario_id || null,
                obraId: sol.obra_id,
                fuelType: sol.tipo_combustivel,
                isFillUp: !!sol.flag_tanque_cheio,
                litrosLiberados: sol.litragem_solicitada || 0,
                odometro: sol.odometro_informado || null,
                horimetro: sol.horimetro_informado || null,
                outros: sol.observacao || null,
                solicitacaoId: solicitacaoId,
                createdBy: { id: null, name: 'Liberação Automática (IA)', ia: true },
            }, { actor: { id: null }, io: global.io || null });

            if (resultado.ok) {
                ordemEmitida = resultado.body;
                await db.query(
                    'UPDATE refuelings SET liberacao_automatica = 1 WHERE id = ?',
                    [resultado.body.id]
                );
                await db.query(
                    'UPDATE solicitacoes_abastecimento SET liberacao_automatica = 1 WHERE id = ?',
                    [solicitacaoId]
                );
                motivo = `Ordem Nº ${resultado.body.authNumber} emitida automaticamente.`;
                console.log(`[abastecimentoAuto] ordem ${resultado.body.authNumber} emitida `
                    + `automaticamente para solicitação ${solicitacaoId}.`);

                // Avisa o solicitante, no mesmo padrão da negativa manual. A ordem
                // já seguiu para o posto pelo dispatchOrderToPartner de criarOrdem;
                // isto é só para o operador não ficar esperando resposta.
                notificarLiberacaoAutomatica(sol, resultado.body.authNumber)
                    .catch((e) => console.warn('[abastecimentoAuto] aviso ao solicitante falhou:', e.message));
            } else {
                // A emissão foi recusada por uma trava que passou na análise mas
                // não na hora de gravar. Volta para a fila humana — nunca insistir.
                decisao = DECISAO.MANUAL;
                motivo = `Emissão automática recusada: ${resultado.body?.error || 'motivo não informado'}`;
                portoes.push(FALHA('emissao', motivo));
                console.warn(`[abastecimentoAuto] emissão automática recusada na solicitação `
                    + `${solicitacaoId}: ${motivo}`);
            }
        }

        // O parecer é gravado nos dois modos. É ele que alimenta o painel de
        // concordância que decide se vale virar a chave para o modo ativo.
        await db.query(
            `UPDATE solicitacoes_abastecimento
                SET ia_status = ?, ia_decisao = ?, ia_leitura_extraida = ?,
                    ia_confianca = ?, ia_motivos = ?, ia_analisado_em = NOW(),
                    alerta_media_consumo = ?
              WHERE id = ?`,
            [
                todosOk ? 'APROVADO' : 'REVISAO',
                decisao,
                leituraPainel && leituraPainel.valor != null ? leituraPainel.valor : null,
                leituraPainel && leituraPainel.confianca != null ? leituraPainel.confianca : null,
                JSON.stringify(portoes.map((p) => ({ nome: p.nome, status: p.status, detalhe: p.detalhe }))),
                // alerta_media_consumo existia desde a migração do chatbot e era
                // sempre gravado como 0. Agora carrega significado.
                portoes.some((p) => p.nome === 'G2_media' && p.status === 'falha') ? 1 : 0,
                solicitacaoId,
            ]
        );

        await registrarAnalise(db, { solicitacaoId, etapa: ETAPA.PAINEL, leitura: leituraPainel, portoes, decisao });

        console.log(`[abastecimentoAuto] solicitação ${solicitacaoId}: ${decisao} — ${motivo}`);
        return { decisao, portoes, motivo, ordemEmitida };
    } catch (e) {
        console.error('[abastecimentoAuto] erro ao analisar solicitação', solicitacaoId, ':', e.message);
        await registrarAnalise(db, {
            solicitacaoId, etapa: ETAPA.PAINEL, leitura: leituraPainel,
            portoes, decisao: DECISAO.ERRO, erro: e.stack || e.message,
        });
        try {
            await db.query(
                'UPDATE solicitacoes_abastecimento SET ia_status = ?, ia_decisao = ?, ia_analisado_em = NOW() WHERE id = ?',
                ['ERRO', DECISAO.ERRO, solicitacaoId]
            );
        } catch { /* já registramos o erro principal */ }
        return { decisao: DECISAO.ERRO, portoes, motivo: e.message };
    }
};

// ─── Análise do comprovante (cupom) ──────────────────────────────────────────

const CAMPO_CONFERE = 'confere';
const CAMPO_DIVERGE = 'diverge';
const CAMPO_NAO_LIDO = 'nao_lido';

/**
 * Lê o cupom e monta a sugestão de baixa. NÃO grava nada em `refuelings` além do
 * campo `baixa_sugerida_ia`: a baixa continua sendo confirmada por uma pessoa.
 */
const analisarComprovante = async (solicitacaoId) => {
    let leitura = null;
    try {
        const config = await carregarConfig();
        if (!config || config.ativo != 1) {
            return { decisao: DECISAO.MANUAL, motivo: 'Aceite automático desligado.' };
        }

        const [[sol]] = await db.query('SELECT * FROM solicitacoes_abastecimento WHERE id = ?', [solicitacaoId]);
        if (!sol) return { decisao: DECISAO.ERRO, motivo: 'Solicitação não encontrada.' };
        if (!sol.foto_cupom_path) return { decisao: DECISAO.MANUAL, motivo: 'Solicitação sem foto do cupom.' };

        // Ordem vinculada: coluna própria primeiro, JSON legado como fallback.
        const [[ordem]] = await db.query(
            `SELECT * FROM refuelings
              WHERE createdFromSolicitacaoId = ?
                 OR JSON_UNQUOTE(JSON_EXTRACT(createdBy, '$.linkedSolicitacaoId')) = ?
              ORDER BY data DESC LIMIT 1`,
            [String(solicitacaoId), String(solicitacaoId)]
        );

        leitura = await visao.lerCupom(sol.foto_cupom_path, { config });

        const conferencias = [];
        const conferir = (campo, valorIa, valorEsperado, avaliar) => {
            if (valorIa == null) {
                conferencias.push({ campo, status: CAMPO_NAO_LIDO, valorIa: null, valorEsperado });
                return;
            }
            conferencias.push({
                campo,
                status: avaliar(valorIa, valorEsperado) ? CAMPO_CONFERE : CAMPO_DIVERGE,
                valorIa,
                valorEsperado,
            });
        };

        if (leitura.ok && leitura.legivel && ordem) {
            // Mesma faixa que o BaixaForm já aplica na conferência manual:
            // acima de 110% ou abaixo de 30% do liberado é divergência.
            const liberados = parseFloat(ordem.litrosLiberados || 0);
            if (liberados > 0) {
                conferir('litros', leitura.litros, liberados,
                    (ia, esp) => ia <= esp * 1.10 && ia >= esp * 0.30);
            } else if (leitura.litros != null) {
                // Tanque cheio: não há litragem liberada para comparar.
                conferencias.push({ campo: 'litros', status: CAMPO_CONFERE, valorIa: leitura.litros, valorEsperado: null });
            }

            const [[precoCad]] = await db.query(
                'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ? LIMIT 1',
                [ordem.partnerId, ordem.fuelType]
            );
            if (precoCad && parseFloat(precoCad.price) > 0) {
                conferir('preco_litro', leitura.precoLitro, parseFloat(precoCad.price),
                    (ia, esp) => Math.abs(ia - esp) / esp <= 0.25);
            }

            // Consistência aritmética: litros × preço ≈ total. É o sinal mais
            // forte de que a extração está certa — três números independentes
            // que fecham entre si dificilmente estão todos errados juntos.
            if (leitura.litros != null && leitura.precoLitro != null && leitura.valorTotal != null) {
                const calculado = leitura.litros * leitura.precoLitro;
                const desvio = Math.abs(calculado - leitura.valorTotal) / Math.max(leitura.valorTotal, 1);
                conferencias.push({
                    campo: 'aritmetica',
                    status: desvio <= 0.02 ? CAMPO_CONFERE : CAMPO_DIVERGE,
                    valorIa: calculado,
                    valorEsperado: leitura.valorTotal,
                });
            }

            if (leitura.numeroNf && ordem.partnerId) {
                const [dups] = await db.query(
                    'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? AND id <> ? LIMIT 1',
                    [ordem.partnerId, leitura.numeroNf, ordem.id]
                );
                conferencias.push({
                    campo: 'nota_fiscal',
                    status: dups.length > 0 ? CAMPO_DIVERGE : CAMPO_CONFERE,
                    valorIa: leitura.numeroNf,
                    valorEsperado: dups.length > 0 ? 'já lançada neste posto' : null,
                });
            }
        }

        const limiar = parseFloat(config.confianca_minima_cupom);
        const confiavel = leitura.ok && leitura.legivel && leitura.confianca >= limiar
            && conferencias.every((c) => c.status !== CAMPO_DIVERGE);

        const sugestao = {
            gerado_em: new Date().toISOString(),
            modelo: leitura.modelo,
            escalonou: !!leitura.escalonou,
            confianca: leitura.confianca,
            legivel: !!leitura.legivel,
            erro: leitura.erro || null,
            observacao: leitura.observacao,
            confiavel,
            valores: {
                litros: leitura.litros,
                preco_litro: leitura.precoLitro,
                valor_total: leitura.valorTotal,
                numero_nf: leitura.numeroNf,
                data_emissao: leitura.dataEmissao,
                cnpj_emitente: leitura.cnpjEmitente,
                razao_social: leitura.razaoSocial,
                tipo_combustivel: leitura.tipoCombustivel,
            },
            conferencias,
        };

        if (ordem) {
            await db.query('UPDATE refuelings SET baixa_sugerida_ia = ? WHERE id = ?',
                [JSON.stringify(sugestao), ordem.id]);
        }

        const statusIa = !leitura.ok ? 'ERRO' : (confiavel ? 'CUPOM_OK' : 'CUPOM_REVISAO');
        await db.query(
            'UPDATE solicitacoes_abastecimento SET ia_status = ?, ia_analisado_em = NOW() WHERE id = ?',
            [statusIa, solicitacaoId]
        );

        await registrarAnalise(db, {
            solicitacaoId, etapa: ETAPA.CUPOM, leitura,
            portoes: conferencias.map((c) => ({ nome: c.campo, status: c.status, detalhe: '' })),
            decisao: confiavel ? 'CUPOM_OK' : 'CUPOM_REVISAO',
        });

        console.log(`[abastecimentoAuto] cupom da solicitação ${solicitacaoId}: ${statusIa}`);
        return { decisao: statusIa, sugestao };
    } catch (e) {
        console.error('[abastecimentoAuto] erro ao analisar cupom', solicitacaoId, ':', e.message);
        await registrarAnalise(db, {
            solicitacaoId, etapa: ETAPA.CUPOM, leitura,
            portoes: [], decisao: DECISAO.ERRO, erro: e.stack || e.message,
        });
        return { decisao: DECISAO.ERRO, motivo: e.message };
    }
};

// ─── Fila ────────────────────────────────────────────────────────────────────

const MAX_TENTATIVAS = 3;

/**
 * Enfileira uma análise. Chamado DEPOIS do commit da transação principal —
 * enfileirar dentro dela faria o worker ler uma linha que ainda não existe.
 */
const enfileirar = async (solicitacaoId, etapa) => {
    if (!visao.isConfigured()) return; // sem credencial, nem enfileira
    try {
        await db.query(
            `INSERT INTO abastecimento_ia_fila (id, solicitacao_id, etapa, status)
             VALUES (?, ?, ?, 'pending')
             ON DUPLICATE KEY UPDATE status = 'pending', attempts = 0, last_error = NULL`,
            [crypto.randomUUID(), solicitacaoId, etapa]
        );
    } catch (e) {
        console.warn('[abastecimentoAuto] falha ao enfileirar', solicitacaoId, etapa, ':', e.message);
    }
};

const executarEtapa = (solicitacaoId, etapa) =>
    (etapa === ETAPA.CUPOM ? analisarComprovante(solicitacaoId) : analisarSolicitacao(solicitacaoId));

/**
 * Dispara a análise já, sem esperar o cron, e marca a fila como concluída.
 * Usado com setImmediate logo após o commit — a fila fica de rede de segurança
 * para o caso de o processo cair no meio.
 */
const dispararAgora = async (solicitacaoId, etapa) => {
    if (!visao.isConfigured()) return;
    try {
        await executarEtapa(solicitacaoId, etapa);
        await db.query(
            "UPDATE abastecimento_ia_fila SET status = 'done' WHERE solicitacao_id = ? AND etapa = ?",
            [solicitacaoId, etapa]
        );
    } catch (e) {
        console.warn('[abastecimentoAuto] disparo imediato falhou, fica para a fila:', e.message);
    }
};

let processando = false;

/**
 * Worker da fila. Mesma mecânica do erpSyncService: trava de reentrância e
 * claim otimista, para que duas execuções do cron não peguem a mesma linha.
 */
const processarFila = async () => {
    if (processando || !visao.isConfigured()) return;
    processando = true;
    try {
        const [pendentes] = await db.query(
            `SELECT id, solicitacao_id, etapa, attempts
               FROM abastecimento_ia_fila
              WHERE status = 'pending' AND attempts < ?
              ORDER BY created_at ASC
              LIMIT 10`,
            [MAX_TENTATIVAS]
        );

        for (const item of pendentes) {
            const [claim] = await db.query(
                "UPDATE abastecimento_ia_fila SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
                [item.id]
            );
            if (claim.affectedRows === 0) continue; // outra execução pegou

            try {
                await executarEtapa(item.solicitacao_id, item.etapa);
                await db.query("UPDATE abastecimento_ia_fila SET status = 'done', last_error = NULL WHERE id = ?", [item.id]);
            } catch (e) {
                const esgotou = item.attempts + 1 >= MAX_TENTATIVAS;
                await db.query(
                    'UPDATE abastecimento_ia_fila SET status = ?, last_error = ? WHERE id = ?',
                    [esgotou ? 'error' : 'pending', String(e.message).slice(0, 2000), item.id]
                );
            }
        }
    } catch (e) {
        console.warn('[abastecimentoAuto] falha no worker da fila:', e.message);
    } finally {
        processando = false;
    }
};

module.exports = {
    DECISAO,
    ETAPA,
    carregarConfig,
    invalidarConfig,
    analisarSolicitacao,
    analisarComprovante,
    enfileirar,
    dispararAgora,
    processarFila,
    // exportados para diagnóstico/teste
    avaliarG0,
    avaliarG1,
    avaliarG2,
    avaliarG3,
    avaliarG4,
    avaliarG5,
};
