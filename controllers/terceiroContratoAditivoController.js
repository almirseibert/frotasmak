// controllers/terceiroContratoAditivoController.js
// Termos aditivos de contrato de terceirizado.
//
// Aditivo NÃO é edição do contrato: a linha de terceiro_contratos permanece
// imutável (é o que o PDF assinado diz) e cada aditivo grava apenas o DELTA
// (horas/preço por subgrupo, prazo). O que o terceiro tem a receber hoje é o
// bloco `vigente` = base + soma dos aditivos ASSINADOS (utils/contratoAditivos.js).
//
// Só existe aditivo sobre contrato com documento assinado vigente. Enquanto o
// aditivo é minuta, ele não move número nenhum.
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { randomUUID } = require('crypto');
const {
    num, parseItens, TIPOS_ADITIVO, aditivoVigente, calcularVigente,
} = require('../utils/contratoAditivos');
const { generateAditivoPdf } = require('../services/aditivoPdfGenerator');
const { slugArquivo } = require('./terceiroContratoController');

const CONTRATOS_PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'contratos');

// Acréscimo acumulado acima deste percentual do valor ORIGINAL exige confirmação
// explícita do usuário (`confirmarLimite: true`). Não é impedimento legal em
// contrato privado — é sanidade contra digitação errada de valor.
const LIMITE_ACRESCIMO = 0.25;

const STATUS_CONTRATO_BLOQUEADO = ['cancelado', 'concluido'];

const trim = (v, max) => {
    const s = (v == null ? '' : String(v)).trim();
    return s ? s.slice(0, max) : null;
};

const normalizeItensDelta = (itens) => {
    let arr = itens;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((i) => i && i.type)
        .map((i) => ({
            type: String(i.type),
            hours: num(i.hours),
            price: i.price == null || i.price === '' ? null : num(i.price),
        }))
        .filter((i) => i.hours !== 0 || i.price != null);
};

// Carrega o contrato + seus aditivos e devolve o consolidado VIGENTE, que é a
// referência de validação (preço atual de cada subgrupo, horas disponíveis para
// supressão). Aditivos em minuta são ignorados de propósito: um aditivo é
// validado contra o que está assinado, nunca contra rascunho de outro.
const carregarContexto = async (contratoId) => {
    const [cRows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [contratoId]);
    if (cRows.length === 0) return null;
    const [aRows] = await db.query(
        'SELECT * FROM terceiro_contrato_aditivos WHERE contratoId = ? ORDER BY sequencia ASC',
        [contratoId]
    );
    return { contrato: cRows[0], aditivos: aRows, vigente: calcularVigente(cRows[0], aRows) };
};

// Valida o delta contra o consolidado vigente e devolve { erro } ou os agregados
// derivados { itens, horasDelta, valorDelta }.
//
// - acrescimo : subgrupos existentes, horas > 0, preço herdado da base
// - supressao : subgrupos existentes, horas < 0, limitado às horas vigentes
// - escopo    : inclui subgrupo novo (exige preço > 0); pode acrescer existentes
// - reajuste  : só muda preço (horas = 0)
// - prazo     : só muda vigenciaFim (sem itens)
const validarDelta = ({ tipo, itens, contrato, vigente, novaVigenciaFim, valorDeltaBody }) => {
    const fechado = contrato.contractType === 'fechado';
    const baseByType = new Map(vigente.itensContratados.map((i) => [i.type, i]));

    if (tipo === 'prazo') {
        if (!novaVigenciaFim) return { erro: 'Aditivo de prazo exige a nova data de vigência.' };
        if (itens.length > 0) return { erro: 'Aditivo de prazo não altera horas nem valores.' };
        return { itens: [], horasDelta: 0, valorDelta: 0 };
    }
    if (itens.length === 0) return { erro: 'Informe ao menos um subgrupo no aditivo.' };

    const novos = itens.filter((i) => !baseByType.has(i.type));
    if (novos.length > 0 && tipo !== 'escopo') {
        return { erro: `Subgrupo "${novos[0].type}" não existe no contrato — use um aditivo de escopo para incluí-lo.` };
    }
    if (tipo === 'escopo' && novos.length === 0) {
        return { erro: 'Aditivo de escopo exige ao menos um subgrupo novo. Para acrescer horas de subgrupo já contratado, use acréscimo.' };
    }

    const finais = [];
    for (const item of itens) {
        const base = baseByType.get(item.type);
        const novo = !base;

        if (tipo === 'reajuste') {
            if (item.hours !== 0) return { erro: 'Aditivo de reajuste não altera horas — use acréscimo ou supressão.' };
            if (fechado) return { erro: 'Contrato de valor fechado não tem preço por hora para reajustar.' };
            if (!(item.price > 0)) return { erro: `Informe o novo preço/hora de "${item.type}".` };
            if (item.price === base.price) return { erro: `O preço de "${item.type}" é igual ao vigente.` };
            finais.push({ type: item.type, hours: 0, price: item.price });
            continue;
        }
        if (tipo === 'supressao') {
            if (!(item.hours < 0)) return { erro: `Supressão exige horas negativas em "${item.type}".` };
            if (Math.abs(item.hours) > base.hours) {
                return { erro: `Não é possível suprimir ${Math.abs(item.hours)} h de "${item.type}": o contrato tem ${base.hours} h vigentes.` };
            }
            finais.push({ type: item.type, hours: item.hours, price: fechado ? 0 : base.price });
            continue;
        }
        // acrescimo | escopo
        if (!(item.hours > 0)) return { erro: `Informe horas maiores que zero em "${item.type}".` };
        if (fechado) {
            finais.push({ type: item.type, hours: item.hours, price: 0 });
            continue;
        }
        if (novo) {
            if (!(item.price > 0)) return { erro: `Subgrupo novo "${item.type}" exige preço/hora.` };
            finais.push({ type: item.type, hours: item.hours, price: item.price });
            continue;
        }
        // Preço divergente em subgrupo existente seria um reajuste disfarçado.
        if (item.price != null && item.price > 0 && item.price !== base.price) {
            return { erro: `O preço de "${item.type}" difere do contratado (R$ ${base.price}). Alteração de preço exige aditivo de reajuste.` };
        }
        finais.push({ type: item.type, hours: item.hours, price: base.price });
    }

    const horasDelta = finais.reduce((a, i) => a + i.hours, 0);
    let valorDelta;
    if (fechado) {
        // Sem preço/hora: o valor do aditivo é global e vem informado.
        valorDelta = num(valorDeltaBody);
        if (tipo !== 'supressao' && !(valorDelta > 0)) {
            return { erro: 'Contrato de valor fechado: informe o valor do aditivo.' };
        }
        if (tipo === 'supressao' && valorDelta > 0) valorDelta = -valorDelta;
    } else if (tipo === 'reajuste') {
        // Diferença de preço aplicada sobre as horas vigentes do subgrupo.
        valorDelta = finais.reduce((a, i) => {
            const base = baseByType.get(i.type);
            return a + (i.price - base.price) * base.hours;
        }, 0);
    } else {
        valorDelta = finais.reduce((a, i) => a + i.hours * i.price, 0);
    }
    return { itens: finais, horasDelta, valorDelta: Math.round(valorDelta * 100) / 100 };
};

// Teto de acréscimo acumulado sobre o valor ORIGINAL. Devolve a resposta 409 de
// confirmação, ou null quando está dentro do limite / já confirmado.
const bloqueioLimite = ({ contrato, vigente, valorDelta, confirmarLimite }) => {
    const valorOriginal = num(contrato.valorTotal);
    if (confirmarLimite || valorOriginal <= 0) return null;
    const acumulado = num(vigente.valorDelta) + Math.max(0, valorDelta);
    if (acumulado <= valorOriginal * LIMITE_ACRESCIMO) return null;
    const pct = Math.round((acumulado / valorOriginal) * 1000) / 10;
    return {
        error: `Os acréscimos somam ${pct}% do valor original do contrato (limite de alerta: ${LIMITE_ACRESCIMO * 100}%). Confirme para prosseguir.`,
        requerConfirmacao: true,
        percentualAcumulado: pct,
    };
};

const getAditivos = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT * FROM terceiro_contrato_aditivos WHERE contratoId = ? ORDER BY sequencia ASC',
            [id]
        );
        res.json(rows.map((a) => ({ ...a, itensDelta: parseItens(a.itensDelta) })));
    } catch (error) {
        console.error('❌ Erro ao listar aditivos:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar aditivos do contrato.' });
    }
};

const createAditivo = async (req, res) => {
    const { id } = req.params;
    const { tipo, itensDelta, novaVigenciaFim, justificativa, observacoes, valorDelta, confirmarLimite } = req.body;

    if (!TIPOS_ADITIVO.includes(tipo)) return res.status(400).json({ error: 'Tipo de aditivo inválido.' });
    const motivo = trim(justificativa, 1000);
    if (!motivo) return res.status(400).json({ error: 'Justificativa do aditivo é obrigatória.' });

    try {
        const ctx = await carregarContexto(id);
        if (!ctx) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const { contrato, aditivos, vigente } = ctx;

        // Regra de entrada: aditivo pressupõe contrato assinado e ativo.
        if (!contrato.contratoAssinadoUrl) {
            return res.status(409).json({ error: 'Aditivo exige contrato com documento assinado vigente.' });
        }
        if (STATUS_CONTRATO_BLOQUEADO.includes(contrato.status)) {
            return res.status(409).json({ error: `Contrato ${contrato.status} não aceita aditivo.` });
        }
        // Um aditivo por vez: minuta pendente precisa ser assinada ou descartada.
        const pendente = aditivos.find((a) => a.status === 'minuta');
        if (pendente) {
            return res.status(409).json({ error: `O aditivo ${pendente.numero} ainda está em minuta. Finalize ou exclua antes de criar outro.` });
        }

        const itens = normalizeItensDelta(itensDelta);
        const calc = validarDelta({
            tipo, itens, contrato, vigente,
            novaVigenciaFim: novaVigenciaFim || null,
            valorDeltaBody: valorDelta,
        });
        if (calc.erro) return res.status(400).json({ error: calc.erro });

        const limite = bloqueioLimite({ contrato, vigente, valorDelta: calc.valorDelta, confirmarLimite });
        if (limite) return res.status(409).json(limite);

        const sequencia = aditivos.reduce((a, x) => Math.max(a, x.sequencia), 0) + 1;
        const numero = `${contrato.numero}-A${sequencia}`;
        const aditivoId = randomUUID();

        await db.execute(
            `INSERT INTO terceiro_contrato_aditivos
                (id, contratoId, numero, sequencia, tipo, itensDelta, horasDelta, valorDelta,
                 novaVigenciaFim, justificativa, status, observacoes, created_by_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'minuta', ?, ?)`,
            [aditivoId, id, numero, sequencia, tipo, JSON.stringify(calc.itens),
             calc.horasDelta, calc.valorDelta, novaVigenciaFim || null, motivo,
             trim(observacoes, 1000), req.user?.email || null]
        );

        const [rows] = await db.query('SELECT * FROM terceiro_contrato_aditivos WHERE id = ?', [aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(201).json({ ...rows[0], itensDelta: parseItens(rows[0].itensDelta) });
    } catch (error) {
        console.error('❌ Erro ao criar aditivo:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao criar aditivo.' });
    }
};

// Edição só enquanto o aditivo é minuta — assinado é imutável, como o contrato.
const updateAditivo = async (req, res) => {
    const { id, aditivoId } = req.params;
    const { tipo, itensDelta, novaVigenciaFim, justificativa, observacoes, valorDelta, confirmarLimite } = req.body;

    if (!TIPOS_ADITIVO.includes(tipo)) return res.status(400).json({ error: 'Tipo de aditivo inválido.' });
    const motivo = trim(justificativa, 1000);
    if (!motivo) return res.status(400).json({ error: 'Justificativa do aditivo é obrigatória.' });

    try {
        const ctx = await carregarContexto(id);
        if (!ctx) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const { contrato, aditivos, vigente } = ctx;

        const atual = aditivos.find((a) => a.id === aditivoId);
        if (!atual) return res.status(404).json({ error: 'Aditivo não encontrado.' });
        if (aditivoVigente(atual)) {
            return res.status(409).json({ error: 'Aditivo assinado não pode ser editado. Remova o documento assinado para editar.' });
        }

        const itens = normalizeItensDelta(itensDelta);
        const calc = validarDelta({
            tipo, itens, contrato, vigente,
            novaVigenciaFim: novaVigenciaFim || null,
            valorDeltaBody: valorDelta,
        });
        if (calc.erro) return res.status(400).json({ error: calc.erro });

        const limite = bloqueioLimite({ contrato, vigente, valorDelta: calc.valorDelta, confirmarLimite });
        if (limite) return res.status(409).json(limite);

        await db.execute(
            `UPDATE terceiro_contrato_aditivos
                SET tipo = ?, itensDelta = ?, horasDelta = ?, valorDelta = ?,
                    novaVigenciaFim = ?, justificativa = ?, observacoes = ?
              WHERE id = ? AND contratoId = ?`,
            [tipo, JSON.stringify(calc.itens), calc.horasDelta, calc.valorDelta,
             novaVigenciaFim || null, motivo, trim(observacoes, 1000), aditivoId, id]
        );

        const [rows] = await db.query('SELECT * FROM terceiro_contrato_aditivos WHERE id = ?', [aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json({ ...rows[0], itensDelta: parseItens(rows[0].itensDelta) });
    } catch (error) {
        console.error('❌ Erro ao atualizar aditivo:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao atualizar aditivo.' });
    }
};

const deleteAditivo = async (req, res) => {
    const { id, aditivoId } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT * FROM terceiro_contrato_aditivos WHERE id = ? AND contratoId = ?',
            [aditivoId, id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Aditivo não encontrado.' });
        if (aditivoVigente(rows[0])) {
            return res.status(409).json({ error: 'Aditivo assinado não pode ser excluído.' });
        }
        // Só o último da fila pode sair, para a numeração não abrir buraco.
        const [ultimo] = await db.query(
            'SELECT MAX(sequencia) AS seq FROM terceiro_contrato_aditivos WHERE contratoId = ?',
            [id]
        );
        if (rows[0].sequencia !== ultimo[0].seq) {
            return res.status(409).json({ error: 'Apenas o último aditivo pode ser excluído.' });
        }
        await db.execute('DELETE FROM terceiro_contrato_aditivos WHERE id = ?', [aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(204).end();
    } catch (error) {
        console.error('❌ Erro ao excluir aditivo:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao excluir aditivo.' });
    }
};

// Gera (ou regenera) a MINUTA do termo aditivo. Bloqueada depois que o aditivo
// assinado sobe, pela mesma razão do contrato: minuta e documento oficial não
// podem divergir.
const gerarAditivoPdf = async (req, res) => {
    const { id, aditivoId } = req.params;
    try {
        const ctx = await carregarContexto(id);
        if (!ctx) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const { contrato, aditivos } = ctx;

        const aditivo = aditivos.find((a) => a.id === aditivoId);
        if (!aditivo) return res.status(404).json({ error: 'Aditivo não encontrado.' });
        if (aditivoVigente(aditivo)) {
            return res.status(409).json({ error: 'Aditivo já possui versão assinada — a geração de minuta está bloqueada.' });
        }

        // Quadro comparativo do documento: o que valia antes deste aditivo e o que
        // passa a valer com ele. Aditivos posteriores (se houver) ficam de fora.
        const anteriores = aditivos.filter((a) => a.sequencia < aditivo.sequencia);
        const anterior = calcularVigente(contrato, anteriores);
        const novo = calcularVigente(contrato, [...anteriores, { ...aditivo, status: 'assinado', assinadoUrl: 'simulado' }]);

        const [locRows] = await db.query('SELECT * FROM partners WHERE id = ?', [contrato.locadorId]);
        const [obraRows] = await db.query('SELECT * FROM obras WHERE id = ?', [contrato.obraId]);
        const locador = locRows[0] || {};
        const obra = obraRows[0] || {};

        const buffer = await generateAditivoPdf({
            contrato, locador, obra, anterior, novo,
            aditivo: { ...aditivo, itensDelta: parseItens(aditivo.itensDelta) },
        });

        fs.mkdirSync(CONTRATOS_PDF_DIR, { recursive: true });
        const partesNome = [
            'aditivo',
            slugArquivo(aditivo.numero || aditivoId, 40),
            slugArquivo(locador.razaoSocial || locador.nome, 40),
            slugArquivo(obra.nome || obra.nome_obra, 40),
        ].filter(Boolean);
        const filename = `${partesNome.join('_')}.pdf`;
        fs.writeFileSync(path.join(CONTRATOS_PDF_DIR, filename), buffer);
        const url = `/uploads/contratos/${filename}`;

        // Regeração com nome diferente deixaria o PDF antigo órfão e acessível.
        const anteriorArq = String(aditivo.pdfUrl || '').split('/').pop();
        if (anteriorArq && anteriorArq !== filename) {
            try { fs.unlinkSync(path.join(CONTRATOS_PDF_DIR, anteriorArq)); }
            catch (e) { if (e.code !== 'ENOENT') console.warn('⚠️ PDF antigo do aditivo nao removido:', e.message); }
        }

        await db.execute('UPDATE terceiro_contrato_aditivos SET pdfUrl = ? WHERE id = ?', [url, aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json({ url });
    } catch (error) {
        console.error('❌ Erro ao gerar PDF do aditivo:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao gerar PDF do aditivo.' });
    }
};

// Upload do termo aditivo ASSINADO. É este passo — e só ele — que faz o delta
// entrar nos números vigentes do contrato.
const enviarAditivoAssinado = async (req, res) => {
    const { id, aditivoId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
    const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch (_) {} };

    try {
        const [rows] = await db.query(
            'SELECT * FROM terceiro_contrato_aditivos WHERE id = ? AND contratoId = ?',
            [aditivoId, id]
        );
        if (rows.length === 0) { cleanup(); return res.status(404).json({ error: 'Aditivo não encontrado.' }); }

        const url = `/uploads/contratos_assinados/${req.file.filename}`;
        await db.execute(
            `UPDATE terceiro_contrato_aditivos
                SET assinadoUrl = ?, assinadoNome = ?, assinadoEm = CURRENT_TIMESTAMP,
                    assinadoPor = ?, status = 'assinado'
              WHERE id = ?`,
            [url, req.file.originalname, req.user?.email || null, aditivoId]
        );

        const [updated] = await db.query('SELECT * FROM terceiro_contrato_aditivos WHERE id = ?', [aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(201).json({ ...updated[0], itensDelta: parseItens(updated[0].itensDelta) });
    } catch (error) {
        cleanup();
        console.error('❌ Erro ao enviar aditivo assinado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao enviar aditivo assinado.' });
    }
};

// Desfaz o assinado (upload equivocado): volta o aditivo para minuta e o tira
// dos números vigentes. O arquivo permanece no disco.
const removerAditivoAssinado = async (req, res) => {
    const { id, aditivoId } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT * FROM terceiro_contrato_aditivos WHERE id = ? AND contratoId = ?',
            [aditivoId, id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Aditivo não encontrado.' });
        // Não pode reabrir um aditivo que já tem outro aditivo assinado depois dele.
        const [posteriores] = await db.query(
            `SELECT COUNT(*) AS n FROM terceiro_contrato_aditivos
              WHERE contratoId = ? AND sequencia > ? AND status = 'assinado'`,
            [id, rows[0].sequencia]
        );
        if (posteriores[0].n > 0) {
            return res.status(409).json({ error: 'Existe aditivo assinado posterior a este. Remova-o primeiro.' });
        }
        await db.execute(
            `UPDATE terceiro_contrato_aditivos
                SET assinadoUrl = NULL, assinadoNome = NULL, assinadoEm = NULL,
                    assinadoPor = NULL, status = 'minuta'
              WHERE id = ?`,
            [aditivoId]
        );
        const [updated] = await db.query('SELECT * FROM terceiro_contrato_aditivos WHERE id = ?', [aditivoId]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json({ ...updated[0], itensDelta: parseItens(updated[0].itensDelta) });
    } catch (error) {
        console.error('❌ Erro ao remover aditivo assinado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao remover aditivo assinado.' });
    }
};

module.exports = {
    getAditivos,
    createAditivo,
    updateAditivo,
    deleteAditivo,
    gerarAditivoPdf,
    enviarAditivoAssinado,
    removerAditivoAssinado,
    carregarContexto,
    validarDelta,
    normalizeItensDelta,
};
