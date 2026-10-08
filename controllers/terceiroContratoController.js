// controllers/terceiroContratoController.js
// Contratos de terceirizados: 1 contrato = 1 terceiro (locador) + 1 obra, valor
// FECHADO. Horas executadas são acompanhamento físico; o saldo a pagar é
// calculado no frontend (utils/terceirizados.js) = valorTotal − diesel − adiantamentos.
const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateContratoPdf } = require('../services/contratoPdfGenerator');
const { anexarVigente } = require('../utils/contratoAditivos');
const { STATUS_ENCERRADOS } = require('../utils/terceirosCusto');

const CONTRATOS_PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'contratos');

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

// Normaliza um pedaco do nome do arquivo do contrato: tira acentos, troca o que
// nao for alfanumerico por _ e limita o tamanho (nome final precisa caber no FS).
const slugArquivo = (v, max = 40) => String(v == null ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');

const FOROS_VALIDOS = ['Santa Maria', 'Lajeado'];

// Cláusulas jurídicas parametrizáveis: aplica default do contrato-modelo quando
// o campo não vier preenchido (contratos antigos, ou criação rápida).
const clausulasJuridicas = (body) => ({
    prazoPagamentoDias: body.prazoPagamentoDias != null && body.prazoPagamentoDias !== '' ? parseInt(body.prazoPagamentoDias, 10) || 30 : 30,
    percentualJurosMora: body.percentualJurosMora != null && body.percentualJurosMora !== '' ? num(body.percentualJurosMora) : 1,
    percentualMultaMora: body.percentualMultaMora != null && body.percentualMultaMora !== '' ? num(body.percentualMultaMora) : 1,
    prazoSubstituicaoHoras: body.prazoSubstituicaoHoras != null && body.prazoSubstituicaoHoras !== '' ? parseInt(body.prazoSubstituicaoHoras, 10) || 48 : 48,
    prazoInicioServicoHoras: body.prazoInicioServicoHoras != null && body.prazoInicioServicoHoras !== '' ? parseInt(body.prazoInicioServicoHoras, 10) || 48 : 48,
    percentualMultaInadimplemento: body.percentualMultaInadimplemento != null && body.percentualMultaInadimplemento !== '' ? num(body.percentualMultaInadimplemento) : 0.5,
    avisoPrevioRescisaoDias: body.avisoPrevioRescisaoDias != null && body.avisoPrevioRescisaoDias !== '' ? parseInt(body.avisoPrevioRescisaoDias, 10) || 2 : 2,
    foroComarca: FOROS_VALIDOS.includes(body.foroComarca) ? body.foroComarca : 'Santa Maria',
    prazoVigenciaMeses: body.prazoVigenciaMeses != null && body.prazoVigenciaMeses !== '' ? parseInt(body.prazoVigenciaMeses, 10) || 6 : 6,
});

// Qualificação do representante legal (assinante) da CONTRATADA. Campos livres,
// opcionais; ausência mantém o texto genérico "por seu representante legal" no PDF.
const trim160 = (v, max) => {
    const s = (v == null ? '' : String(v)).trim();
    return s ? s.slice(0, max) : null;
};
const representanteContratada = (body) => ({
    contratadaRepresentanteNome: trim160(body.contratadaRepresentanteNome, 160),
    contratadaRepresentanteQualificacao: trim160(body.contratadaRepresentanteQualificacao, 200),
    contratadaRepresentanteCpf: trim160(body.contratadaRepresentanteCpf, 20),
});

// Data impressa na minuta. Modo desconhecido cai em 'atual' (comportamento antigo).
const MODOS_DATA_CONTRATO = ['atual', 'inicio_obra', 'personalizada'];
const dataDoContrato = (body) => {
    const modo = MODOS_DATA_CONTRATO.includes(body.dataContratoModo) ? body.dataContratoModo : 'atual';
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dataContratoPersonalizada || '').slice(0, 10))
        ? String(body.dataContratoPersonalizada).slice(0, 10) : null;
    return { dataContratoModo: modo, dataContratoPersonalizada: modo === 'personalizada' ? data : null };
};

// Valida o par modo/data contra a vigência informada. Retorna mensagem ou null.
const erroDataContrato = ({ dataContratoModo, dataContratoPersonalizada }, vigenciaInicio) => {
    if (dataContratoModo === 'inicio_obra' && !vigenciaInicio) {
        return 'Para usar a data de início do terceiro na obra, preencha "Vigência início".';
    }
    if (dataContratoModo === 'personalizada' && !dataContratoPersonalizada) {
        return 'Informe a data personalizada do contrato.';
    }
    return null;
};

const normalizeMaquinas = (m) => {
    if (Array.isArray(m)) return m.filter(Boolean);
    if (typeof m === 'string') {
        try { const p = JSON.parse(m); return Array.isArray(p) ? p.filter(Boolean) : []; } catch { return []; }
    }
    return [];
};

// Normaliza os itens do plano de trabalho ([{ type, hours, price, consomeDe? }]).
// `consomeDe` só existe em máquina FORA do plano da obra: é o item do plano que
// cede as horas (acordo informal — ver erroForaDoPlano).
const normalizeItens = (itens) => {
    let arr = itens;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((i) => i && i.type)
        .map((i) => {
            const item = { type: String(i.type), hours: num(i.hours), price: num(i.price) };
            const origem = String(i.consomeDe || '').trim();
            if (origem && origem !== item.type) item.consomeDe = origem;
            return item;
        });
};

// Subgrupo do plano da obra de onde o item tira horas.
const tipoNoPlano = (i) => i.consomeDe || i.type;

// A partir do plano, calcula horas totais e valor total (por horas) ou usa o valor fechado.
const derivarAgregados = ({ contractType, itens, horasContratadas, valorHora, valorTotal }) => {
    if (contractType === 'fechado') {
        // Fechado agora aceita máquinas (subgrupos) com horas, mas SEM valor/hora (price = 0):
        // o valor é o global informado; as horas são demonstrativas e alimentam o progresso físico.
        const itensSemPreco = itens.map((i) => ({ ...i, price: 0 }));
        const horasItens = itensSemPreco.reduce((a, i) => a + i.hours, 0);
        return {
            horas: horasItens > 0 ? horasItens : num(horasContratadas),
            vHora: 0,
            vTotal: valorTotal != null && valorTotal !== '' ? num(valorTotal) : 0,
            itens: itensSemPreco,
        };
    }
    // 'horas': se vier plano de itens, ele é a fonte de verdade; senão cai no par simples.
    if (itens.length > 0) {
        const horas = itens.reduce((a, i) => a + i.hours, 0);
        const vTotal = itens.reduce((a, i) => a + i.hours * i.price, 0);
        const vHora = horas > 0 ? Math.round((vTotal / horas) * 100) / 100 : 0;
        return { horas, vHora, vTotal, itens };
    }
    const horas = num(horasContratadas);
    const vHora = num(valorHora);
    const vTotal = valorTotal != null && valorTotal !== '' ? num(valorTotal) : horas * vHora;
    return { horas, vHora, vTotal, itens: [] };
};

// ---------------------------------------------------------------------------
// Unicidade terceiro × obra × subgrupo
// ---------------------------------------------------------------------------
// Substitui a antiga regra "1 máquina : 1 contrato" (`maquinasEmConflito`), que
// era digitada e proibia o caso real: a mesma máquina transita entre obras e pode
// estar sob dois contratos vigentes ao mesmo tempo, um por obra.
//
// Como a máquina agora é DERIVADA de (terceiro × obra × subgrupo × data), o que
// precisa ser único é a própria chave. Dois contratos vigentes do mesmo terceiro,
// na mesma obra, para o mesmo subgrupo, com vigências que se cruzam, deixariam o
// lançamento sem destino definido. Subgrupos diferentes (escavadeira e caminhão)
// convivem sem ambiguidade — é o subgrupo que desempata.
const seCruzam = (ini1, fim1, ini2, fim2) => {
    const a = ymdStr(ini1), b = ymdStr(fim1), c = ymdStr(ini2), d = ymdStr(fim2);
    if (b && c && b < c) return false;      // o primeiro termina antes do segundo começar
    if (d && a && d < a) return false;
    return true;                            // sem data = janela aberta, assume sobreposição
};

const ymdStr = (v) => {
    if (!v) return null;
    if (v instanceof Date) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
};

// Retorna [] ou a lista de subgrupos já comprometidos [{ type, contratoId, numero }].
const subgruposEmConflito = async ({ locadorId, obraId, itens, vigenciaInicio, vigenciaFim, exceptId = null }) => {
    const meus = [...new Set(itens.map((i) => String(i.type || '').trim()).filter(Boolean))];
    if (!locadorId || !obraId) return [];
    const [rows] = await db.query(
        `SELECT id, numero, itensContratados, vigenciaInicio, vigenciaFim
           FROM terceiro_contratos
          WHERE locadorId = ? AND obraId = ?
            AND status NOT IN (${STATUS_ENCERRADOS.map(() => '?').join(',')})` +
        (exceptId ? ' AND id <> ?' : ''),
        exceptId ? [locadorId, obraId, ...STATUS_ENCERRADOS, exceptId] : [locadorId, obraId, ...STATUS_ENCERRADOS]
    );

    const out = [];
    rows.forEach((r) => {
        if (!seCruzam(vigenciaInicio, vigenciaFim, r.vigenciaInicio, r.vigenciaFim)) return;
        const outros = normalizeItens(r.itensContratados).map((i) => String(i.type || '').trim());
        // Contrato sem subgrupo declarado (valor fechado sem plano) captura tudo do
        // terceiro naquela obra: não pode conviver com nenhum outro na mesma janela.
        const colide = (meus.length === 0 || outros.length === 0)
            ? [meus.length === 0 ? (outros[0] || '(todos)') : '(todos)']
            : meus.filter((t) => outros.includes(t));
        colide.forEach((type) => out.push({ type, contratoId: r.id, numero: r.numero }));
    });
    return out;
};

const erroDeSubgrupo = (conflitos) => ({
    error: 'Já existe contrato vigente deste terceiro nesta obra para o mesmo equipamento.',
    detalhe: 'Horas e diesel são atribuídos por terceiro + obra + subgrupo + data. Dois contratos '
        + 'vigentes com a mesma chave deixariam o lançamento sem destino. Encerre o contrato anterior '
        + 'ou registre a alteração como termo aditivo.',
    conflitos,
});

// ---------------------------------------------------------------------------
// Saldo do plano de trabalho da obra
// ---------------------------------------------------------------------------
// O plano da obra (horasContratadasPorSubTipo) é o teto do que pode ser repassado
// a terceiros. Cada contrato consome horas por SUBGRUPO; o saldo para um contrato
// é: horas do plano − horas dos OUTROS contratos de terceiro da mesma obra.
// A execução física (dailyWorkLogs) NÃO entra: ela é progresso, não compromisso.
const parseJsonObj = (v) => {
    if (!v) return {};
    if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch { return {}; } }
    return typeof v === 'object' ? v : {};
};

const carregarPlanoDaObra = async (obraId) => {
    const [obraRows] = await db.query(
        'SELECT horasContratadasPorSubTipo FROM obras WHERE id = ?', [obraId]
    );
    return parseJsonObj(obraRows[0]?.horasContratadasPorSubTipo);
};

// Máquina fora do plano (acordo informal): o contrato pode ter um subgrupo que a
// obra não prevê, DESDE QUE indique em `consomeDe` um item do plano que cede as
// horas — o teto continua sendo o plano. O valor/hora do terceiro é livre.
// Retorna a mensagem de erro ou null (e limpa `consomeDe` onde não se aplica).
// `typesAnteriores` = subgrupos já gravados no contrato: item fora do plano sem
// origem só passa se já existia (contrato legado, anterior a esta regra).
const erroForaDoPlano = (plano, itens, typesAnteriores = []) => {
    if (Object.keys(plano).length === 0) {
        // Obra sem plano por subgrupo: não há de onde consumir.
        itens.forEach((i) => { delete i.consomeDe; });
        return null;
    }
    for (const i of itens) {
        if (i.type in plano) { delete i.consomeDe; continue; }
        if (i.consomeDe) {
            if (!(i.consomeDe in plano)) {
                return `"${i.type}": o item indicado para consumir as horas ("${i.consomeDe}") não está no plano de trabalho da obra.`;
            }
            continue;
        }
        if (!typesAnteriores.includes(i.type)) {
            return `"${i.type}" não está no plano de trabalho da obra. Indique de qual máquina do plano as horas serão consumidas.`;
        }
    }
    return null;
};

const ERRO_JUSTIFICATIVA = 'Contrato com máquina fora do plano de trabalho: informe a justificativa do acordo.';

// Justificativa do acordo fora do plano: obrigatória quando há substituição e
// zerada quando não há mais. Quem/quando registrou é preservado entre edições.
const registroForaDoPlano = (itens, body, atual, email) => {
    if (!itens.some((i) => i.consomeDe)) return { ok: true, justificativa: null, por: null, em: null };
    const justificativa = trim160(body.foraDoPlanoJustificativa, 2000);
    if (!justificativa) return { ok: false };
    return {
        ok: true,
        justificativa,
        por: atual?.foraDoPlanoRegistradoPor || email || null,
        em: atual?.foraDoPlanoRegistradoEm || new Date(),
    };
};

// Valida os itens do contrato contra o saldo do plano. Retorna [] ou a lista de
// estouros [{ type, saldo, pedido }]. Obra sem plano por subgrupo não restringe nada.
// Item fora do plano com `consomeDe` desconta do item de origem.
const validarContraPlanoDaObra = async (obraId, itens, exceptId = null, plano = null) => {
    const pedido = {};
    itens.forEach((i) => { pedido[tipoNoPlano(i)] = (pedido[tipoNoPlano(i)] || 0) + num(i.hours); });
    if (Object.keys(pedido).length === 0) return [];

    if (!plano) plano = await carregarPlanoDaObra(obraId);
    if (Object.keys(plano).length === 0) return [];

    const [outrosRows] = await db.query(
        'SELECT * FROM terceiro_contratos WHERE obraId = ? AND status <> ?' +
        (exceptId ? ' AND id <> ?' : ''),
        exceptId ? [obraId, 'cancelado', exceptId] : [obraId, 'cancelado']
    );
    // Conta o VIGENTE (base + aditivos assinados) — é o compromisso real, e é o
    // mesmo número que o frontend mostra como saldo.
    const outros = await anexarVigente(db, outrosRows);
    const comprometido = {};
    outros.forEach((c) => {
        normalizeItens(c.vigente?.itensContratados ?? c.itensContratados).forEach((i) => {
            comprometido[tipoNoPlano(i)] = (comprometido[tipoNoPlano(i)] || 0) + i.hours;
        });
    });

    const estouros = [];
    Object.entries(pedido).forEach(([type, horas]) => {
        // Subgrupo fora do plano da obra: não há saldo a controlar (contratos legados).
        if (!(type in plano)) return;
        const saldo = num(plano[type]) - (comprometido[type] || 0);
        if (horas > saldo + 1e-6) estouros.push({ type, saldo, pedido: horas });
    });
    return estouros;
};

const erroDePlano = (estouros) => ({
    error: 'Horas acima do saldo do plano de trabalho da obra: ' +
        estouros.map((e) => `${e.type} (pedido ${e.pedido} h, saldo ${e.saldo} h)`).join(', ') + '.',
    estouros,
});

// Gera número sequencial por ano: CT-AAAA-NNN (idempotente por UNIQUE no banco).
const gerarNumero = async () => {
    const ano = new Date().getFullYear();
    const prefixo = `CT-${ano}-`;
    const [rows] = await db.query(
        'SELECT numero FROM terceiro_contratos WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1',
        [`${prefixo}%`]
    );
    let seq = 1;
    if (rows.length > 0) {
        const ultimo = parseInt(String(rows[0].numero).split('-').pop(), 10);
        if (Number.isFinite(ultimo)) seq = ultimo + 1;
    }
    return `${prefixo}${String(seq).padStart(3, '0')}`;
};

const getTerceiroContratos = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM terceiro_contratos ORDER BY created_at DESC');
        // Cada contrato leva junto `aditivos` e `vigente` (base + aditivos assinados).
        // As colunas da linha seguem intactas: são o contrato ORIGINAL, usado na
        // minuta e na exibição do "original R$ X".
        res.json(await anexarVigente(db, rows));
    } catch (error) {
        console.error('❌ Erro ao listar contratos de terceirizados:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar contratos.' });
    }
};

const createTerceiroContrato = async (req, res) => {
    const {
        locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
        valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas, createdBy,
        contractType, itensContratados,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const tipoContrato = contractType === 'fechado' ? 'fechado' : 'horas';
    const itens = normalizeItens(itensContratados);
    const { horas, vHora, vTotal, itens: itensFinal } = derivarAgregados({
        contractType: tipoContrato, itens, horasContratadas, valorHora, valorTotal,
    });
    const maqs = normalizeMaquinas(maquinas);
    const clausulas = clausulasJuridicas(req.body);
    const rep = representanteContratada(req.body);
    const dataCt = dataDoContrato(req.body);
    const erroData = erroDataContrato(dataCt, vigenciaInicio);
    if (erroData) return res.status(400).json({ error: erroData });

    const id = randomUUID();
    const criadoPor = createdBy?.userEmail || req.user?.email || null;

    try {
        const conflitoSub = await subgruposEmConflito({
            locadorId, obraId, itens: itensFinal, vigenciaInicio, vigenciaFim,
        });
        if (conflitoSub.length > 0) return res.status(400).json(erroDeSubgrupo(conflitoSub));
        const plano = await carregarPlanoDaObra(obraId);
        const erroFora = erroForaDoPlano(plano, itensFinal);
        if (erroFora) return res.status(400).json({ error: erroFora });
        const foraPlano = registroForaDoPlano(itensFinal, req.body, null, criadoPor);
        if (!foraPlano.ok) return res.status(400).json({ error: ERRO_JUSTIFICATIVA });
        const estouros = await validarContraPlanoDaObra(obraId, itensFinal, null, plano);
        if (estouros.length > 0) return res.status(400).json(erroDePlano(estouros));
        const numero = await gerarNumero();
        await db.execute(
            `INSERT INTO terceiro_contratos
                (id, numero, locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
                 valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas,
                 contractType, itensContratados, created_by_email,
                 prazoPagamentoDias, percentualJurosMora, percentualMultaMora,
                 prazoSubstituicaoHoras, prazoInicioServicoHoras, percentualMultaInadimplemento,
                 avisoPrevioRescisaoDias, foroComarca, prazoVigenciaMeses,
                 contratadaRepresentanteNome, contratadaRepresentanteQualificacao, contratadaRepresentanteCpf,
                 dataContratoModo, dataContratoPersonalizada,
                 foraDoPlanoJustificativa, foraDoPlanoRegistradoPor, foraDoPlanoRegistradoEm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, numero, locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             maqs === null ? null : JSON.stringify(maqs), tipoContrato, JSON.stringify(itensFinal), criadoPor,
             clausulas.prazoPagamentoDias, clausulas.percentualJurosMora, clausulas.percentualMultaMora,
             clausulas.prazoSubstituicaoHoras, clausulas.prazoInicioServicoHoras, clausulas.percentualMultaInadimplemento,
             clausulas.avisoPrevioRescisaoDias, clausulas.foroComarca, clausulas.prazoVigenciaMeses,
             rep.contratadaRepresentanteNome, rep.contratadaRepresentanteQualificacao, rep.contratadaRepresentanteCpf,
             dataCt.dataContratoModo, dataCt.dataContratoPersonalizada,
             foraPlano.justificativa, foraPlano.por, foraPlano.em]
        );
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(201).json(await anexarVigente(db, rows[0]));
    } catch (error) {
        console.error('❌ Erro ao criar contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao criar contrato.' });
    }
};

const updateTerceiroContrato = async (req, res) => {
    const { id } = req.params;
    const {
        locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
        valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas,
        contractType, itensContratados,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const tipoContrato = contractType === 'fechado' ? 'fechado' : 'horas';
    const itens = normalizeItens(itensContratados);
    const { horas, vHora, vTotal, itens: itensFinal } = derivarAgregados({
        contractType: tipoContrato, itens, horasContratadas, valorHora, valorTotal,
    });
    // `maquinas` é LEGADO: a UI não envia mais (a máquina é derivada de terceiro ×
    // obra × subgrupo × data). Body sem o campo PRESERVA o que está gravado, para
    // não apagar o vínculo histórico de um contrato antigo numa edição qualquer.
    const maqs = maquinas === undefined ? null : normalizeMaquinas(maquinas);
    const clausulas = clausulasJuridicas(req.body);
    const rep = representanteContratada(req.body);
    const dataCt = dataDoContrato(req.body);
    const erroData = erroDataContrato(dataCt, vigenciaInicio);
    if (erroData) return res.status(400).json({ error: erroData });

    try {
        // Contrato assinado é imutável: bloqueia edição enquanto houver documento
        // assinado vigente (mesma regra da geração de minuta).
        const [cur] = await db.query(
            `SELECT contratoAssinadoUrl, obraId, itensContratados, foraDoPlanoRegistradoPor, foraDoPlanoRegistradoEm
               FROM terceiro_contratos WHERE id = ?`, [id]
        );
        if (cur.length === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        if (cur[0].contratoAssinadoUrl) {
            return res.status(409).json({ error: 'Contrato com versão assinada não pode ser editado. Remova o contrato assinado para editar.' });
        }
        const conflitoSub = await subgruposEmConflito({
            locadorId, obraId, itens: itensFinal, vigenciaInicio, vigenciaFim, exceptId: id,
        });
        if (conflitoSub.length > 0) return res.status(400).json(erroDeSubgrupo(conflitoSub));
        const plano = await carregarPlanoDaObra(obraId);
        // Legado: subgrupo fora do plano já gravado neste contrato (mesma obra) segue
        // aceito sem origem, para a edição de um contrato antigo não travar.
        const typesAnteriores = String(cur[0].obraId) === String(obraId)
            ? normalizeItens(cur[0].itensContratados).map((i) => i.type) : [];
        const erroFora = erroForaDoPlano(plano, itensFinal, typesAnteriores);
        if (erroFora) return res.status(400).json({ error: erroFora });
        const foraPlano = registroForaDoPlano(itensFinal, req.body, cur[0], req.user?.email);
        if (!foraPlano.ok) return res.status(400).json({ error: ERRO_JUSTIFICATIVA });
        const estouros = await validarContraPlanoDaObra(obraId, itensFinal, id, plano);
        if (estouros.length > 0) return res.status(400).json(erroDePlano(estouros));
        const [result] = await db.execute(
            `UPDATE terceiro_contratos
                SET locadorId = ?, obraId = ?, tipoMaquina = ?, horasContratadas = ?, valorHora = ?,
                    valorTotal = ?, vigenciaInicio = ?, vigenciaFim = ?, status = ?, observacoes = ?, maquinas = COALESCE(?, maquinas),
                    contractType = ?, itensContratados = ?,
                    prazoPagamentoDias = ?, percentualJurosMora = ?, percentualMultaMora = ?,
                    prazoSubstituicaoHoras = ?, prazoInicioServicoHoras = ?, percentualMultaInadimplemento = ?,
                    avisoPrevioRescisaoDias = ?, foroComarca = ?, prazoVigenciaMeses = ?,
                    contratadaRepresentanteNome = ?, contratadaRepresentanteQualificacao = ?, contratadaRepresentanteCpf = ?,
                    dataContratoModo = ?, dataContratoPersonalizada = ?,
                    foraDoPlanoJustificativa = ?, foraDoPlanoRegistradoPor = ?, foraDoPlanoRegistradoEm = ?
              WHERE id = ?`,
            [locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             maqs === null ? null : JSON.stringify(maqs), tipoContrato, JSON.stringify(itensFinal),
             clausulas.prazoPagamentoDias, clausulas.percentualJurosMora, clausulas.percentualMultaMora,
             clausulas.prazoSubstituicaoHoras, clausulas.prazoInicioServicoHoras, clausulas.percentualMultaInadimplemento,
             clausulas.avisoPrevioRescisaoDias, clausulas.foroComarca, clausulas.prazoVigenciaMeses,
             rep.contratadaRepresentanteNome, rep.contratadaRepresentanteQualificacao, rep.contratadaRepresentanteCpf,
             dataCt.dataContratoModo, dataCt.dataContratoPersonalizada,
             foraPlano.justificativa, foraPlano.por, foraPlano.em, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json(await anexarVigente(db, rows[0]));
    } catch (error) {
        console.error('❌ Erro ao atualizar contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao atualizar contrato.' });
    }
};

const deleteTerceiroContrato = async (req, res) => {
    const { id } = req.params;
    try {
        const [cur] = await db.query('SELECT contratoAssinadoUrl FROM terceiro_contratos WHERE id = ?', [id]);
        if (cur.length === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        if (cur[0].contratoAssinadoUrl) {
            return res.status(409).json({ error: 'Contrato com versão assinada não pode ser excluído. Remova o contrato assinado antes.' });
        }
        const [result] = await db.execute('DELETE FROM terceiro_contratos WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        await db.execute('DELETE FROM terceiro_contrato_docs WHERE contratoId = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(204).end();
    } catch (error) {
        console.error('❌ Erro ao excluir contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao excluir contrato.' });
    }
};

// Gera (ou regenera) o PDF do contrato, salva em public/uploads/contratos e
// grava a pdfUrl. Retorna { url }.
const gerarContratoPdf = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const contrato = rows[0];

        // Contrato com versão assinada está "congelado": a minuta não pode ser
        // regenerada (evita que o oficial e o rascunho divirjam). Remova o assinado
        // para reabrir.
        if (contrato.contratoAssinadoUrl) {
            return res.status(409).json({ error: 'Contrato já possui versão assinada — a geração de minuta está bloqueada. Remova o contrato assinado para gerar novamente.' });
        }

        const [locRows] = await db.query('SELECT * FROM partners WHERE id = ?', [contrato.locadorId]);
        const [obraRows] = await db.query('SELECT * FROM obras WHERE id = ?', [contrato.obraId]);
        const locador = locRows[0] || {};
        const obra = obraRows[0] || {};

        const buffer = await generateContratoPdf({ contrato, locador, obra });

        fs.mkdirSync(CONTRATOS_PDF_DIR, { recursive: true });
        // Nome do arquivo: terceiro + obra + numero do contrato, nessa ordem, para
        // que a listagem da pasta agrupe naturalmente por terceiro.
        const partes = [
            slugArquivo(locador.razaoSocial || locador.nome, 40),
            slugArquivo(obra.nome || obra.nome_obra, 40),
            slugArquivo(contrato.numero || id, 40),
        ].filter(Boolean);
        const filename = `${partes.join('_')}.pdf`;
        fs.writeFileSync(path.join(CONTRATOS_PDF_DIR, filename), buffer);
        const url = `/uploads/contratos/${filename}`;

        // Regeracao com nome diferente (empresa/obra/numero alterados) deixaria o
        // PDF antigo orfao e ainda acessivel pela URL antiga — remove o anterior.
        const anterior = String(contrato.pdfUrl || '').split('/').pop();
        if (anterior && anterior !== filename) {
            try { fs.unlinkSync(path.join(CONTRATOS_PDF_DIR, anterior)); }
            catch (e) { if (e.code !== 'ENOENT') console.warn('⚠️ PDF antigo do contrato nao removido:', e.message); }
        }

        await db.execute('UPDATE terceiro_contratos SET pdfUrl = ? WHERE id = ?', [url, id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json({ url });
    } catch (error) {
        console.error('❌ Erro ao gerar PDF do contrato:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao gerar PDF do contrato.' });
    }
};

// Anexa um PDF de contrato ASSINADO (enviado via multipart pela rota). Arquiva o
// vigente anterior no histórico, marca o novo como vigente, espelha nas colunas do
// contrato e promove o status para 'assinado' (congela minuta/edição/exclusão).
const enviarContratoAssinado = async (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });

    const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch (_) {} };
    try {
        const [rows] = await db.query('SELECT id FROM terceiro_contratos WHERE id = ?', [id]);
        if (rows.length === 0) { cleanup(); return res.status(404).json({ error: 'Contrato não encontrado.' }); }

        const url = `/uploads/contratos_assinados/${req.file.filename}`;
        const nome = req.file.originalname;
        const por = req.user?.email || null;

        // Arquiva o vigente anterior e registra o novo como vigente (histórico).
        await db.execute('UPDATE terceiro_contrato_docs SET vigente = 0 WHERE contratoId = ? AND vigente = 1', [id]);
        await db.execute(
            `INSERT INTO terceiro_contrato_docs (id, contratoId, url, nomeOriginal, vigente, enviadoPor)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [randomUUID(), id, url, nome, por]
        );
        // Espelha o vigente nas colunas do contrato + status 'assinado'.
        await db.execute(
            `UPDATE terceiro_contratos
                SET contratoAssinadoUrl = ?, contratoAssinadoNome = ?, contratoAssinadoEm = CURRENT_TIMESTAMP,
                    contratoAssinadoPor = ?, status = 'assinado'
              WHERE id = ?`,
            [url, nome, por, id]
        );

        const [updated] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(201).json(await anexarVigente(db, updated[0]));
    } catch (error) {
        cleanup();
        console.error('❌ Erro ao enviar contrato assinado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao enviar contrato assinado.' });
    }
};

// Remove o contrato assinado VIGENTE (mantém o arquivo e o registro no histórico,
// apenas desmarca) e reverte o status, reabrindo minuta/edição. Válvula de escape
// para upload equivocado.
const removerContratoAssinado = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT id FROM terceiro_contratos WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });

        // Aditivo só existe sobre contrato assinado: reabrir a base deixaria os
        // aditivos assinados pendurados em um contrato que voltou a ser minuta.
        const [comAditivo] = await db.query(
            `SELECT COUNT(*) AS n FROM terceiro_contrato_aditivos
              WHERE contratoId = ? AND status = 'assinado'`,
            [id]
        );
        if (comAditivo[0].n > 0) {
            return res.status(409).json({ error: 'Contrato possui aditivo assinado. Remova os aditivos antes de reabrir o contrato.' });
        }

        const novo = ['ativo', 'concluido', 'cancelado'].includes(req.body?.status) ? req.body.status : 'ativo';
        await db.execute('UPDATE terceiro_contrato_docs SET vigente = 0 WHERE contratoId = ? AND vigente = 1', [id]);
        await db.execute(
            `UPDATE terceiro_contratos
                SET contratoAssinadoUrl = NULL, contratoAssinadoNome = NULL, contratoAssinadoEm = NULL,
                    contratoAssinadoPor = NULL, status = ?
              WHERE id = ?`,
            [novo, id]
        );

        const [updated] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json(await anexarVigente(db, updated[0]));
    } catch (error) {
        console.error('❌ Erro ao remover contrato assinado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao remover contrato assinado.' });
    }
};


// Histórico de documentos assinados de um contrato (vigente + arquivados).
const getContratoDocs = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT id, url, nomeOriginal, vigente, enviadoPor, enviadoEm FROM terceiro_contrato_docs WHERE contratoId = ? ORDER BY enviadoEm DESC',
            [id]
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro ao listar documentos do contrato:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar documentos do contrato.' });
    }
};

module.exports = {
    getTerceiroContratos,
    createTerceiroContrato,
    updateTerceiroContrato,
    deleteTerceiroContrato,
    gerarContratoPdf,
    enviarContratoAssinado,
    removerContratoAssinado,
    getContratoDocs,
    slugArquivo,
};
