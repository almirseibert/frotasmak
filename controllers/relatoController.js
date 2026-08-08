// controllers/relatoController.js
//
// Relato de Ocorrência e Manutenção de Frota — ficha FRM-MAN-001.
//
// O operador preenche a ficha em papel apontando os problemas do equipamento e
// a gravidade de cada um (A/B/C/D); o gestor de frota digita aqui. Depois da
// triagem (quem executa cada serviço), o relato é "fechado" informando o número
// da OS do sistema MC, e aí o sistema gera as ordens de serviço agrupadas por
// executor — isso é a fase seguinte, em relatoOrderService.
//
// Seções da ficha → colunas: 1/2/5/6 no cabeçalho (relatos_ocorrencia), 4 nos
// itens (relato_ocorrencia_itens). Os quatro status do item são exatamente os
// do quadro "USO EXCLUSIVO DA MANUTENÇÃO / OFICINA" impresso na ficha.

const db = require('../database');
const crypto = require('crypto');
const { toYmd } = require('../utils/businessDays');
const { montarPreview } = require('../services/relatoCronogramaService');
const { gerarOrdensDoRelato, listarOrdensDoRelato } = require('../services/relatoOrderService');
const {
    getActiveObraAllocation, deallocateFromObraTx, startMaintenanceTx,
} = require('../services/vehicleStateService');
const { liberarVeiculoSePossivel } = require('../services/relatoStatusService');
const { getAllowedReadingTypes } = require('../utils/vehicleRules');

// --- Domínio -----------------------------------------------------------------

const GRAVIDADES = ['A', 'B', 'C', 'D'];

// Rascunho → Digitado → Em Execução → Concluído; Cancelado a partir de qualquer
// estado não-terminal.
const RELATO_STATUS = ['Rascunho', 'Digitado', 'Em Execução', 'Concluído', 'Cancelado'];
const RELATO_EDITAVEL = ['Rascunho', 'Digitado'];

// Espelham o quadro da seção 6 da ficha. 'Cancelado' não existe no papel, mas é
// necessário para item que a oficina decide não executar.
const ITEM_STATUS = ['Em Análise', 'Aguardando Peça', 'Em Execução', 'Concluído', 'Cancelado'];
const ITEM_STATUS_TERMINAL = ['Concluído', 'Cancelado'];

const EXECUTOR_TIPOS = ['interno', 'externo'];

// --- Helpers -----------------------------------------------------------------

const parseJsonSafe = (field) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch {
        return null;
    }
};

const safeStringify = (val) => {
    if (val === null || val === undefined || val === '') return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
};

const toNumberOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
};

const trimOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
};

const actorOf = (req) => ({ userId: req.user?.id || null, userEmail: req.user?.email || null });

// Normaliza as datas que o MySQL devolve como Date para 'YYYY-MM-DD'.
const normalizeRelato = (row) => {
    if (!row) return null;
    return {
        ...row,
        dataRelato: toYmd(row.dataRelato),
        recebidoEm: toYmd(row.recebidoEm),
        concluidoEm: toYmd(row.concluidoEm),
        dataConclusaoPrevista: toYmd(row.dataConclusaoPrevista),
        osMcRegistradaPor: parseJsonSafe(row.osMcRegistradaPor),
        fechadoPor: parseJsonSafe(row.fechadoPor),
        createdBy: parseJsonSafe(row.createdBy),
        anexos: parseJsonSafe(row.anexos) || [],
    };
};

const normalizeItem = (row) => {
    if (!row) return null;
    return {
        ...row,
        quantidade: toNumberOrNull(row.quantidade),
        valorEstimado: toNumberOrNull(row.valorEstimado),
        dataInicioPrevista: toYmd(row.dataInicioPrevista),
        dataConclusaoPrevista: toYmd(row.dataConclusaoPrevista),
        dataConclusaoReal: toYmd(row.dataConclusaoReal),
    };
};

// Valida e normaliza um item vindo do cliente. Retorna { erro } ou { valor }.
const parseItemPayload = (raw, sequencia) => {
    const itemComponente = trimOrNull(raw?.itemComponente);
    const descricaoProblema = trimOrNull(raw?.descricaoProblema);
    const gravidade = String(raw?.gravidade || '').trim().toUpperCase();

    if (!itemComponente) return { erro: `Item ${sequencia}: informe o item/componente.` };
    if (!descricaoProblema) return { erro: `Item ${sequencia}: descreva o problema observado.` };
    if (!GRAVIDADES.includes(gravidade)) {
        return { erro: `Item ${sequencia}: gravidade deve ser A, B, C ou D.` };
    }

    const executorTipo = EXECUTOR_TIPOS.includes(raw?.executorTipo) ? raw.executorTipo : null;
    const statusItem = ITEM_STATUS.includes(raw?.status) ? raw.status : 'Em Análise';

    return {
        valor: {
            sequencia,
            itemComponente,
            descricaoProblema,
            gravidade,
            executorTipo,
            executorPartnerId: trimOrNull(raw?.executorPartnerId),
            executorNome: trimOrNull(raw?.executorNome),
            servicoDescricao: trimOrNull(raw?.servicoDescricao),
            quantidade: toNumberOrNull(raw?.quantidade) ?? 1,
            inventoryItemId: trimOrNull(raw?.inventoryItemId),
            valorEstimado: toNumberOrNull(raw?.valorEstimado),
            slaDiasUteis: toNumberOrNull(raw?.slaDiasUteis),
            observacoes: trimOrNull(raw?.observacoes),
            status: statusItem,
        },
    };
};

// Carrega o snapshot do veículo gravado no cabeçalho (a ficha é histórica: se o
// veículo for renomeado depois, o relato tem que continuar mostrando o que
// estava escrito no papel).
const loadVehicleSnapshot = async (dbClient, vehicleId) => {
    const [rows] = await dbClient.execute(
        'SELECT id, modelo, placa, registroInterno, tipo FROM vehicles WHERE id = ?',
        [vehicleId]
    );
    return rows[0] || null;
};

// ============================================================================
// LISTAGEM
// ============================================================================

// GET /api/relatos?status&vehicleId&osMc&from&to
const getRelatos = async (req, res) => {
    try {
        const { status, vehicleId, osMc, from, to } = req.query;
        const where = [];
        const params = [];

        if (status)    { where.push('r.status = ?');      params.push(status); }
        if (vehicleId) { where.push('r.vehicleId = ?');   params.push(vehicleId); }
        if (osMc)      { where.push('r.osMc = ?');        params.push(osMc); }
        if (from)      { where.push('r.dataRelato >= ?'); params.push(from); }
        if (to)        { where.push('r.dataRelato <= ?'); params.push(to); }

        const [rows] = await db.query(
            `SELECT r.*,
                    COALESCE(i.itensCount, 0)      AS itensCount,
                    COALESCE(i.itensConcluidos, 0) AS itensConcluidos,
                    i.gravidadeMax,
                    COALESCE(o.ordensCount, 0)     AS ordensCount
               FROM relatos_ocorrencia r
               LEFT JOIN (
                    SELECT relatoId,
                           COUNT(*) AS itensCount,
                           SUM(status IN ('Concluído','Cancelado')) AS itensConcluidos,
                           MIN(gravidade) AS gravidadeMax
                      FROM relato_ocorrencia_itens
                     GROUP BY relatoId
               ) i ON i.relatoId = r.id
               LEFT JOIN (
                    SELECT relatoId, COUNT(DISTINCT orderId) AS ordensCount
                      FROM relato_item_ordens
                     GROUP BY relatoId
               ) o ON o.relatoId = r.id
              ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY r.dataRelato DESC, r.numero DESC`,
            params
        );

        res.json(rows.map(normalizeRelato));
    } catch (error) {
        console.error('❌ Erro GET /relatos:', error);
        res.status(500).json({ error: 'Erro ao listar relatos de ocorrência.' });
    }
};

// GET /api/relatos/:id
const getRelatoById = async (req, res) => {
    try {
        const { id } = req.params;

        const [[relato]] = await db.execute('SELECT * FROM relatos_ocorrencia WHERE id = ?', [id]);
        if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });

        const [itens] = await db.execute(
            'SELECT * FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia ASC',
            [id]
        );

        // Ordens geradas a partir deste relato, com o vínculo por item.
        const [vinculos] = await db.execute(
            `SELECT rio.itemId, rio.papel, o.id, o.orderNumber, o.status, o.supplier,
                    o.supplierId, o.totalValue, o.tipo, o.osMc
               FROM relato_item_ordens rio
               JOIN orders o ON o.id = rio.orderId
              WHERE rio.relatoId = ?`,
            [id]
        );

        const ordensPorItem = new Map();
        for (const v of vinculos) {
            if (!ordensPorItem.has(v.itemId)) ordensPorItem.set(v.itemId, []);
            ordensPorItem.get(v.itemId).push({
                id: v.id, orderNumber: v.orderNumber, status: v.status,
                supplier: v.supplier, supplierId: v.supplierId,
                totalValue: toNumberOrNull(v.totalValue), tipo: v.tipo, papel: v.papel,
            });
        }

        // Lista de ordens únicas do relato (um item pode compartilhar ordem com outro).
        const ordens = [...new Map(
            vinculos.map(v => [v.id, {
                id: v.id, orderNumber: v.orderNumber, status: v.status,
                supplier: v.supplier, supplierId: v.supplierId,
                totalValue: toNumberOrNull(v.totalValue), tipo: v.tipo, osMc: v.osMc,
            }])
        ).values()].sort((a, b) => (a.orderNumber || 0) - (b.orderNumber || 0));

        res.json({
            ...normalizeRelato(relato),
            itens: itens.map(i => ({ ...normalizeItem(i), ordens: ordensPorItem.get(i.id) || [] })),
            ordens,
        });
    } catch (error) {
        console.error('❌ Erro GET /relatos/:id:', error);
        res.status(500).json({ error: 'Erro ao buscar o relato.' });
    }
};

// ============================================================================
// CRIAÇÃO
// ============================================================================

// POST /api/relatos
const createRelato = async (req, res) => {
    const b = req.body || {};

    const relatorNome = trimOrNull(b.relatorNome);
    const vehicleId = trimOrNull(b.vehicleId);
    const dataRelato = trimOrNull(b.dataRelato);

    if (!relatorNome) return res.status(400).json({ error: 'Informe o nome do colaborador que relatou.' });
    if (!vehicleId)   return res.status(400).json({ error: 'Selecione o veículo/equipamento.' });
    if (!dataRelato)  return res.status(400).json({ error: 'Informe a data do relato.' });

    const statusInicial = b.status === 'Digitado' ? 'Digitado' : 'Rascunho';

    // Valida todos os itens antes de abrir transação — erro de digitação não
    // deve consumir número do contador.
    const itensRaw = Array.isArray(b.itens) ? b.itens : [];
    const itens = [];
    for (let i = 0; i < itensRaw.length; i++) {
        const { erro, valor } = parseItemPayload(itensRaw[i], i + 1);
        if (erro) return res.status(400).json({ error: erro });
        itens.push(valor);
    }
    if (statusInicial === 'Digitado' && itens.length === 0) {
        return res.status(400).json({ error: 'Um relato digitado precisa de ao menos um item.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const vehicle = await loadVehicleSnapshot(connection, vehicleId);
        if (!vehicle) {
            await connection.rollback();
            return res.status(400).json({ error: 'Veículo não encontrado.' });
        }

        const [[counter]] = await connection.execute(
            "SELECT lastNumber FROM counters WHERE name = 'relatoOcorrenciaCounter' FOR UPDATE"
        );
        const numero = (counter?.lastNumber || 0) + 1;
        await connection.execute(
            "UPDATE counters SET lastNumber = ? WHERE name = 'relatoOcorrenciaCounter'",
            [numero]
        );

        const id = crypto.randomUUID();
        await connection.query('INSERT INTO relatos_ocorrencia SET ?', [{
            id,
            numero,
            relatorNome,
            relatorEmployeeId: trimOrNull(b.relatorEmployeeId),
            relatorFuncao: trimOrNull(b.relatorFuncao),
            filialCidade: trimOrNull(b.filialCidade),
            dataRelato,
            vehicleId,
            // Snapshot: o que estava escrito na ficha, com fallback no cadastro.
            veiculoModelo: trimOrNull(b.veiculoModelo) || vehicle.modelo || null,
            veiculoPlaca: trimOrNull(b.veiculoPlaca) || vehicle.placa || null,
            veiculoFrota: trimOrNull(b.veiculoFrota) || vehicle.registroInterno || null,
            hodometro: toNumberOrNull(b.hodometro),
            horimetro: toNumberOrNull(b.horimetro),
            observacoesGerais: trimOrNull(b.observacoesGerais),
            assinaturaColaborador: trimOrNull(b.assinaturaColaborador),
            assinaturaSupervisor: trimOrNull(b.assinaturaSupervisor),
            recebidoEm: trimOrNull(b.recebidoEm),
            responsavelManutencao: trimOrNull(b.responsavelManutencao),
            status: statusInicial,
            anexos: safeStringify(b.anexos) || '[]',
            createdBy: JSON.stringify(actorOf(req)),
        }]);

        for (const item of itens) {
            await connection.query('INSERT INTO relato_ocorrencia_itens SET ?', [{
                id: crypto.randomUUID(), relatoId: id, ...item,
            }]);
        }

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.status(201).json({ id, numero, message: `Relato #${numero} criado com sucesso.` });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos:', error);
        res.status(500).json({ error: 'Erro ao criar o relato.' });
    } finally {
        connection.release();
    }
};

// ============================================================================
// EDIÇÃO DO CABEÇALHO
// ============================================================================

// Campos livres enquanto o relato não foi fechado.
const CAMPOS_EDITAVEIS = [
    'relatorNome', 'relatorEmployeeId', 'relatorFuncao', 'filialCidade', 'dataRelato',
    'veiculoModelo', 'veiculoPlaca', 'veiculoFrota', 'observacoesGerais',
    'assinaturaColaborador', 'assinaturaSupervisor',
];
// Campos da seção 6, editáveis também depois do fechamento.
const CAMPOS_SECAO6 = ['recebidoEm', 'responsavelManutencao', 'providenciaAdotada'];

// PUT /api/relatos/:id
const updateRelato = async (req, res) => {
    try {
        const { id } = req.params;
        const b = req.body || {};

        const [[relato]] = await db.execute(
            'SELECT id, status, vehicleId FROM relatos_ocorrencia WHERE id = ?', [id]
        );
        if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });
        if (['Concluído', 'Cancelado'].includes(relato.status)) {
            return res.status(409).json({ error: `Relato ${relato.status.toLowerCase()} não pode ser editado.` });
        }

        const editavel = RELATO_EDITAVEL.includes(relato.status);
        const patch = {};

        if (editavel) {
            for (const campo of CAMPOS_EDITAVEIS) {
                if (campo in b) patch[campo] = trimOrNull(b[campo]);
            }
            if ('hodometro' in b) patch.hodometro = toNumberOrNull(b.hodometro);
            if ('horimetro' in b) patch.horimetro = toNumberOrNull(b.horimetro);
            if ('anexos' in b) patch.anexos = safeStringify(b.anexos) || '[]';
            if ('status' in b && RELATO_EDITAVEL.includes(b.status)) patch.status = b.status;

            // Trocar de veículo re-snapshota a identificação, senão o cabeçalho
            // ficaria com placa/RE do equipamento anterior.
            const novoVehicleId = trimOrNull(b.vehicleId);
            if (novoVehicleId && novoVehicleId !== relato.vehicleId) {
                const vehicle = await loadVehicleSnapshot(db, novoVehicleId);
                if (!vehicle) return res.status(400).json({ error: 'Veículo não encontrado.' });
                patch.vehicleId = novoVehicleId;
                patch.veiculoModelo = trimOrNull(b.veiculoModelo) || vehicle.modelo || null;
                patch.veiculoPlaca = trimOrNull(b.veiculoPlaca) || vehicle.placa || null;
                patch.veiculoFrota = trimOrNull(b.veiculoFrota) || vehicle.registroInterno || null;
            }
        }

        // A seção 6 ("uso exclusivo da oficina") continua editável em execução.
        for (const campo of CAMPOS_SECAO6) {
            if (campo in b) patch[campo] = trimOrNull(b[campo]);
        }

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'Nada a atualizar neste status do relato.' });
        }

        await db.query('UPDATE relatos_ocorrencia SET ? WHERE id = ?', [patch, id]);
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: 'Relato atualizado.' });
    } catch (error) {
        console.error('❌ Erro PUT /relatos/:id:', error);
        res.status(500).json({ error: 'Erro ao atualizar o relato.' });
    }
};

// DELETE /api/relatos/:id
const deleteRelato = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;

        const [[relato]] = await connection.execute(
            'SELECT id, numero, status FROM relatos_ocorrencia WHERE id = ?', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }

        // Ordem gerada é documento com número sequencial e possível despesa —
        // apagar o relato deixaria a ordem órfã. Nesse caso o caminho é cancelar.
        const [[{ n }]] = await connection.execute(
            'SELECT COUNT(*) n FROM relato_item_ordens WHERE relatoId = ?', [id]
        );
        if (n > 0) {
            await connection.rollback();
            return res.status(409).json({
                error: `Relato #${relato.numero} já gerou ${n} ordem(ns). Cancele o relato em vez de excluir.`,
            });
        }

        await connection.execute('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [id]);
        await connection.execute('DELETE FROM relatos_ocorrencia WHERE id = ?', [id]);

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: `Relato #${relato.numero} excluído.` });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro DELETE /relatos/:id:', error);
        res.status(500).json({ error: 'Erro ao excluir o relato.' });
    } finally {
        connection.release();
    }
};

// ============================================================================
// ITENS
// ============================================================================

// POST /api/relatos/:id/itens
const createRelatoItem = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;

        const [[relato]] = await connection.execute(
            'SELECT id, status FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (!RELATO_EDITAVEL.includes(relato.status)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Só é possível incluir itens antes de fechar o relato.' });
        }

        // FOR UPDATE acima serializa a numeração: dois itens criados ao mesmo
        // tempo não podem receber a mesma sequência.
        const [[{ maxSeq }]] = await connection.execute(
            'SELECT COALESCE(MAX(sequencia), 0) maxSeq FROM relato_ocorrencia_itens WHERE relatoId = ?', [id]
        );
        const { erro, valor } = parseItemPayload(req.body, maxSeq + 1);
        if (erro) {
            await connection.rollback();
            return res.status(400).json({ error: erro });
        }

        const itemId = crypto.randomUUID();
        await connection.query('INSERT INTO relato_ocorrencia_itens SET ?', [{
            id: itemId, relatoId: id, ...valor,
        }]);

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.status(201).json({ id: itemId, sequencia: valor.sequencia });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos/:id/itens:', error);
        res.status(500).json({ error: 'Erro ao adicionar item ao relato.' });
    } finally {
        connection.release();
    }
};

// PUT /api/relatos/:id/itens/:itemId
const updateRelatoItem = async (req, res) => {
    try {
        const { id, itemId } = req.params;
        const b = req.body || {};

        const [[relato]] = await db.execute('SELECT id, status FROM relatos_ocorrencia WHERE id = ?', [id]);
        if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });
        if (['Concluído', 'Cancelado'].includes(relato.status)) {
            return res.status(409).json({ error: `Relato ${relato.status.toLowerCase()} não pode ser editado.` });
        }

        const [[item]] = await db.execute(
            'SELECT * FROM relato_ocorrencia_itens WHERE id = ? AND relatoId = ?', [itemId, id]
        );
        if (!item) return res.status(404).json({ error: 'Item não encontrado neste relato.' });

        const patch = {};
        const editavel = RELATO_EDITAVEL.includes(relato.status);

        // O que o operador escreveu na ficha só muda antes do fechamento.
        if (editavel) {
            if ('itemComponente' in b) {
                const v = trimOrNull(b.itemComponente);
                if (!v) return res.status(400).json({ error: 'Informe o item/componente.' });
                patch.itemComponente = v;
            }
            if ('descricaoProblema' in b) {
                const v = trimOrNull(b.descricaoProblema);
                if (!v) return res.status(400).json({ error: 'Descreva o problema observado.' });
                patch.descricaoProblema = v;
            }
            if ('gravidade' in b) {
                const g = String(b.gravidade || '').trim().toUpperCase();
                if (!GRAVIDADES.includes(g)) return res.status(400).json({ error: 'Gravidade deve ser A, B, C ou D.' });
                patch.gravidade = g;
            }
        }

        // Campos de triagem seguem ajustáveis enquanto o relato não é terminal.
        if ('executorTipo' in b) {
            patch.executorTipo = EXECUTOR_TIPOS.includes(b.executorTipo) ? b.executorTipo : null;
        }
        for (const campo of ['executorPartnerId', 'executorNome', 'servicoDescricao', 'inventoryItemId', 'observacoes']) {
            if (campo in b) patch[campo] = trimOrNull(b[campo]);
        }
        if ('quantidade' in b) patch.quantidade = toNumberOrNull(b.quantidade) ?? 1;
        if ('valorEstimado' in b) patch.valorEstimado = toNumberOrNull(b.valorEstimado);
        if ('slaDiasUteis' in b) patch.slaDiasUteis = toNumberOrNull(b.slaDiasUteis);

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'Nada a atualizar neste item.' });
        }

        await db.query('UPDATE relato_ocorrencia_itens SET ? WHERE id = ?', [patch, itemId]);
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: 'Item atualizado.' });
    } catch (error) {
        console.error('❌ Erro PUT /relatos/:id/itens/:itemId:', error);
        res.status(500).json({ error: 'Erro ao atualizar o item.' });
    }
};

// PUT /api/relatos/:id/itens/:itemId/status
// Movimento do acompanhamento (kanban): Em Análise → Aguardando Peça ⇄
// Em Execução → Concluído, mais Cancelado.
const updateRelatoItemStatus = async (req, res) => {
    try {
        const { id, itemId } = req.params;
        const { status, observacoes, dataConclusaoReal, motivoCancelamento } = req.body || {};

        if (!ITEM_STATUS.includes(status)) {
            return res.status(400).json({ error: `Status inválido. Use: ${ITEM_STATUS.join(', ')}.` });
        }

        const [[item]] = await db.execute(
            'SELECT id FROM relato_ocorrencia_itens WHERE id = ? AND relatoId = ?', [itemId, id]
        );
        if (!item) return res.status(404).json({ error: 'Item não encontrado neste relato.' });

        const patch = { status };
        if (observacoes !== undefined) patch.observacoes = trimOrNull(observacoes);
        if (status === 'Cancelado') patch.motivoCancelamento = trimOrNull(motivoCancelamento);

        if (ITEM_STATUS_TERMINAL.includes(status)) {
            patch.dataConclusaoReal = trimOrNull(dataConclusaoReal) || toYmd(new Date());
        } else {
            // Voltar de um estado terminal limpa a data — senão ficaria um item
            // "em execução" com data de conclusão preenchida.
            patch.dataConclusaoReal = null;
        }

        await db.query('UPDATE relato_ocorrencia_itens SET ? WHERE id = ?', [patch, itemId]);
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: 'Status do item atualizado.' });
    } catch (error) {
        console.error('❌ Erro PUT status do item:', error);
        res.status(500).json({ error: 'Erro ao atualizar o status do item.' });
    }
};

// DELETE /api/relatos/:id/itens/:itemId
const deleteRelatoItem = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id, itemId } = req.params;

        const [[relato]] = await connection.execute(
            'SELECT id, status FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (!RELATO_EDITAVEL.includes(relato.status)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Só é possível excluir itens antes de fechar o relato.' });
        }

        const [[vinculo]] = await connection.execute(
            'SELECT COUNT(*) n FROM relato_item_ordens WHERE itemId = ?', [itemId]
        );
        if (vinculo.n > 0) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este item já está vinculado a uma ordem e não pode ser excluído.' });
        }

        const [result] = await connection.execute(
            'DELETE FROM relato_ocorrencia_itens WHERE id = ? AND relatoId = ?', [itemId, id]
        );
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Item não encontrado neste relato.' });
        }

        // Renumera para a sequência continuar 1..N como na ficha de papel.
        const [restantes] = await connection.execute(
            'SELECT id FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia ASC', [id]
        );
        // Desloca para uma faixa livre antes de reatribuir: o UNIQUE
        // (relatoId, sequencia) barraria a renumeração feita no lugar.
        for (let i = 0; i < restantes.length; i++) {
            await connection.execute(
                'UPDATE relato_ocorrencia_itens SET sequencia = ? WHERE id = ?', [1000 + i, restantes[i].id]
            );
        }
        for (let i = 0; i < restantes.length; i++) {
            await connection.execute(
                'UPDATE relato_ocorrencia_itens SET sequencia = ? WHERE id = ?', [i + 1, restantes[i].id]
            );
        }

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: 'Item excluído.' });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro DELETE item do relato:', error);
        res.status(500).json({ error: 'Erro ao excluir o item.' });
    } finally {
        connection.release();
    }
};

// ============================================================================
// PRÉVIA DO FECHAMENTO
// ============================================================================

/**
 * Situação atual do equipamento, para o passo 2 do wizard decidir se faz a
 * saída de obra e se manda para manutenção.
 */
const situacaoDoVeiculo = async (dbClient, vehicleId) => {
    const [[vehicle]] = await dbClient.execute(
        `SELECT id, tipo, status, obraAtualId, odometro, horimetro, registroInterno, placa, modelo
           FROM vehicles WHERE id = ?`,
        [vehicleId]
    );
    if (!vehicle) return null;

    // As duas fontes podem divergir (obraAtualId é um atalho; a verdade da
    // estadia está em obras_historico_veiculos). O OR é defensivo.
    const [[alocacao]] = await dbClient.execute(
        `SELECT h.obraId, h.dataEntrada, h.employeeId, h.employeeName, o.nome AS obraNome
           FROM obras_historico_veiculos h
           LEFT JOIN obras o ON o.id = h.obraId
          WHERE h.veiculoId = ? AND h.dataSaida IS NULL
          ORDER BY h.dataEntrada DESC LIMIT 1`,
        [vehicleId]
    );

    const readingType = getAllowedReadingTypes(vehicle.tipo)?.[0] || 'odometro';

    return {
        id: vehicle.id,
        registroInterno: vehicle.registroInterno,
        placa: vehicle.placa,
        modelo: vehicle.modelo,
        status: vehicle.status,
        readingType,
        leituraAtual: Number(vehicle[readingType]) || 0,
        estaAlocado: !!alocacao || !!vehicle.obraAtualId,
        obraAtual: alocacao
            ? {
                id: alocacao.obraId,
                nome: alocacao.obraNome,
                dataEntrada: toYmd(alocacao.dataEntrada),
                operador: alocacao.employeeName || null,
                employeeId: alocacao.employeeId || null,
            }
            : (vehicle.obraAtualId ? { id: vehicle.obraAtualId, nome: null } : null),
    };
};

// POST /api/relatos/:id/preview-fechamento
// Não persiste nada: devolve como as ordens ficariam agrupadas, o cronograma em
// dias úteis e os avisos. A triagem enviada no corpo tem precedência sobre o
// que está gravado, para o gestor ver o efeito antes de salvar.
const previewFechamento = async (req, res) => {
    try {
        const { id } = req.params;
        const { dataBase, itens: itensDoCorpo, regiao } = req.body || {};

        const [[relato]] = await db.execute('SELECT * FROM relatos_ocorrencia WHERE id = ?', [id]);
        if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });

        const [itensBanco] = await db.execute(
            'SELECT * FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia ASC', [id]
        );
        if (itensBanco.length === 0) {
            return res.status(400).json({ error: 'Este relato não tem itens para gerar ordens.' });
        }

        // Sobrepõe a triagem enviada pelo wizard, sem gravar.
        const patchPorId = new Map((itensDoCorpo || []).map(i => [i.id, i]));
        const itens = itensBanco.map(item => {
            const p = patchPorId.get(item.id);
            if (!p) return item;
            return {
                ...item,
                executorTipo: p.executorTipo ?? item.executorTipo,
                executorPartnerId: p.executorPartnerId ?? item.executorPartnerId,
                executorNome: p.executorNome ?? item.executorNome,
                servicoDescricao: p.servicoDescricao ?? item.servicoDescricao,
                inventoryItemId: p.inventoryItemId ?? item.inventoryItemId,
                quantidade: p.quantidade ?? item.quantidade,
                valorEstimado: p.valorEstimado ?? item.valorEstimado,
                slaDiasUteis: p.slaDiasUteis ?? item.slaDiasUteis,
            };
        });

        const preview = await montarPreview(db, {
            relato,
            itens,
            dataBase: dataBase || toYmd(new Date()),
            regiao: regiao || null,
        });

        const veiculo = await situacaoDoVeiculo(db, relato.vehicleId);
        const avisos = [...preview.avisos];

        // A ficha é preenchida à mão dias antes de ser digitada: a leitura
        // anotada costuma estar atrasada. Avisar aqui evita que a saída de obra
        // rebaixe o odômetro do equipamento.
        if (veiculo) {
            const leituraFicha = veiculo.readingType === 'odometro' ? relato.hodometro : relato.horimetro;
            if (leituraFicha != null && Number(leituraFicha) < veiculo.leituraAtual) {
                avisos.push(
                    `A leitura da ficha (${Number(leituraFicha).toLocaleString('pt-BR')}) é menor que a atual do equipamento ` +
                    `(${veiculo.leituraAtual.toLocaleString('pt-BR')}). Confira antes de fechar.`
                );
            }
            if (!veiculo.estaAlocado) {
                avisos.push('Equipamento não está alocado em obra — nenhuma saída de obra será feita.');
            }
        }

        res.json({
            relatoId: relato.id,
            numero: relato.numero,
            statusAtual: relato.status,
            jaFechado: !RELATO_EDITAVEL.includes(relato.status),
            dataBase: preview.dataBase,
            grupos: preview.grupos,
            cronograma: preview.cronograma,
            dataConclusaoPrevistaGeral: preview.dataConclusaoPrevistaGeral,
            // Gravidade A bloqueia a operação — é o que sugere marcar saída de
            // obra e "Em Manutenção" por padrão no wizard.
            temItemBloqueante: itens.some(i => preview.slaConfig[i.gravidade]?.bloqueiaOperacao && i.status !== 'Cancelado'),
            veiculo,
            avisos,
        });
    } catch (error) {
        console.error('❌ Erro POST /relatos/:id/preview-fechamento:', error);
        res.status(500).json({ error: 'Erro ao montar a prévia do fechamento.' });
    }
};

// ============================================================================
// FECHAMENTO
// ============================================================================

// POST /api/relatos/:id/fechar
//
// O passo que amarra tudo, numa transação só:
//   1. trava o relato e confere que ainda não foi fechado (idempotência)
//   2. grava a triagem (executor, serviço, valor, prazo) de cada item
//   3. calcula e PERSISTE o cronograma em dias úteis
//   4. saída de obra e/ou entrada em manutenção, conforme o wizard pediu
//   5. gera as ordens agrupadas por executor, todas com a OS do MC
//
// Se qualquer passo falhar, nada acontece — não existe estado intermediário em
// que o equipamento saiu da obra mas as ordens não foram criadas.
const fecharRelato = async (req, res) => {
    const { id } = req.params;
    const b = req.body || {};

    const osMc = trimOrNull(b.osMc);
    if (!osMc) {
        return res.status(400).json({ error: 'Informe o número da OS do sistema MC para fechar o relato.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Trava e valida o estado ----------------------------------------
        const [[relato]] = await connection.execute(
            'SELECT * FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (!RELATO_EDITAVEL.includes(relato.status)) {
            // Duplo-clique no wizard cai aqui: devolve as ordens que já existem
            // em vez de gerar tudo de novo.
            await connection.rollback();
            return res.status(409).json({
                error: `Relato #${relato.numero} já foi fechado (${relato.status}).`,
                relatoId: relato.id,
                osMc: relato.osMc,
                ordens: await listarOrdensDoRelato(db, relato.id),
            });
        }

        const [itensBanco] = await connection.execute(
            'SELECT * FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia ASC', [id]
        );
        if (itensBanco.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Este relato não tem itens para gerar ordens.' });
        }

        // 2. Persiste a triagem vinda do wizard ------------------------------
        const patchPorId = new Map((b.itens || []).map(i => [i.id, i]));
        const itens = [];
        for (const item of itensBanco) {
            const p = patchPorId.get(item.id);
            if (!p) { itens.push(item); continue; }

            const atualizado = {
                ...item,
                executorTipo: EXECUTOR_TIPOS.includes(p.executorTipo) ? p.executorTipo : item.executorTipo,
                executorPartnerId: p.executorPartnerId !== undefined ? trimOrNull(p.executorPartnerId) : item.executorPartnerId,
                executorNome: p.executorNome !== undefined ? trimOrNull(p.executorNome) : item.executorNome,
                servicoDescricao: p.servicoDescricao !== undefined ? trimOrNull(p.servicoDescricao) : item.servicoDescricao,
                inventoryItemId: p.inventoryItemId !== undefined ? trimOrNull(p.inventoryItemId) : item.inventoryItemId,
                quantidade: p.quantidade !== undefined ? (toNumberOrNull(p.quantidade) ?? 1) : item.quantidade,
                valorEstimado: p.valorEstimado !== undefined ? toNumberOrNull(p.valorEstimado) : item.valorEstimado,
                slaDiasUteis: p.slaDiasUteis !== undefined ? toNumberOrNull(p.slaDiasUteis) : item.slaDiasUteis,
            };
            itens.push(atualizado);

            await connection.query('UPDATE relato_ocorrencia_itens SET ? WHERE id = ?', [{
                executorTipo: atualizado.executorTipo,
                executorPartnerId: atualizado.executorPartnerId,
                executorNome: atualizado.executorNome,
                servicoDescricao: atualizado.servicoDescricao,
                inventoryItemId: atualizado.inventoryItemId,
                quantidade: atualizado.quantidade,
                valorEstimado: atualizado.valorEstimado,
                slaDiasUteis: atualizado.slaDiasUteis,
            }, item.id]);
        }

        // 3. Cronograma em dias úteis, agora persistido ----------------------
        const preview = await montarPreview(connection, {
            relato, itens,
            dataBase: trimOrNull(b.dataBase) || toYmd(new Date()),
            regiao: trimOrNull(b.regiao),
        });

        if (preview.grupos.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                error: 'Nenhum item tem executor definido — sem isso não há ordem de serviço a gerar.',
            });
        }

        for (const c of preview.cronograma) {
            await connection.query('UPDATE relato_ocorrencia_itens SET ? WHERE id = ?', [{
                ordemSequencia: c.ordemSequencia,
                dataInicioPrevista: c.dataInicioPrevista,
                dataConclusaoPrevista: c.dataConclusaoPrevista,
                slaDiasUteis: c.slaDiasUteis,
            }, c.itemId]);
        }

        // 4. Estado do veículo ----------------------------------------------
        const [[vehicle]] = await connection.execute(
            'SELECT id, tipo, status, obraAtualId, odometro, horimetro FROM vehicles WHERE id = ? FOR UPDATE',
            [relato.vehicleId]
        );
        if (!vehicle) {
            await connection.rollback();
            return res.status(400).json({ error: 'Veículo do relato não encontrado.' });
        }

        const readingType = getAllowedReadingTypes(vehicle.tipo)?.[0] || 'odometro';
        const leituraFicha = readingType === 'odometro' ? relato.hodometro : relato.horimetro;
        const leituraAtual = Number(vehicle[readingType]) || 0;

        // A ficha é preenchida à mão dias antes de ser digitada. Sem esta
        // guarda, a saída de obra gravaria a leitura antiga e REBAIXARIA o
        // odômetro/horímetro do equipamento.
        if (leituraFicha != null && Number(leituraFicha) < leituraAtual && !b.forcarLeitura) {
            await connection.rollback();
            return res.status(400).json({
                error: `A leitura da ficha (${Number(leituraFicha).toLocaleString('pt-BR')}) é menor que a atual do `
                    + `equipamento (${leituraAtual.toLocaleString('pt-BR')}). Corrija a ficha ou marque "forçar leitura".`,
                codigo: 'LEITURA_REGRESSIVA',
            });
        }

        const alocacao = await getActiveObraAllocation(connection, vehicle.id);
        const estaAlocado = !!alocacao || !!vehicle.obraAtualId;

        let obraOrigemId = null;
        let saidaObraFeita = 0;

        // ORDEM IMPORTA: a saída de obra vem antes da entrada em manutenção.
        // startMaintenance fecha todos os vehicle_history abertos e zera
        // obraAtualId — se rodasse primeiro, a estadia em obras_historico_veiculos
        // ficaria aberta para sempre.
        if (b.fazerSaidaObra && estaAlocado) {
            const s = b.saidaObra || {};
            const r = await deallocateFromObraTx(connection, vehicle.id, {
                dataSaida: s.dataSaida || new Date(),
                readingType,
                readingValue: leituraFicha != null ? Number(leituraFicha) : leituraAtual,
                location: trimOrNull(s.location) || trimOrNull(b.localManutencao) || 'Pátio',
                obraId: alocacao?.obraId || vehicle.obraAtualId,
                observacoes: `Saída para manutenção — Relato #${relato.numero}`
                    + (s.observacoes ? ` | ${s.observacoes}` : ''),
                shouldFinalizeObra: false,
                protegerLeitura: true,
            });
            obraOrigemId = r.obraId;
            saidaObraFeita = 1;
        }

        const statusVeiculo = ['Em Manutenção', 'Aguardando Manutenção'].includes(b.statusVeiculo)
            ? b.statusVeiculo
            : 'Aguardando Manutenção';
        const localManutencao = trimOrNull(b.localManutencao) || 'Pátio MAK Lajeado';

        if (b.colocarEmManutencao) {
            await startMaintenanceTx(connection, vehicle.id, {
                status: statusVeiculo,
                location: localManutencao,
            });
        }

        // 5. Ordens agrupadas por executor -----------------------------------
        const ordens = await gerarOrdensDoRelato(connection, {
            relato: { ...relato, obraOrigemId: obraOrigemId ?? relato.obraOrigemId },
            grupos: preview.grupos,
            osMc,
            dataBase: preview.dataBase,
            employeeIdAutorizado: trimOrNull(b.employeeIdAutorizado),
            obraCustoId: b.obraCustoId !== undefined ? trimOrNull(b.obraCustoId) : obraOrigemId,
            kmHrAtual: leituraFicha ?? leituraAtual,
            kmHrUnit: readingType === 'odometro' ? 'Km' : 'Hr',
            createdBy: actorOf(req),
        });

        // Item cuja ordem já nasceu com valor entra direto em execução; "a
        // cotar" fica em análise até o valor chegar.
        const ordemPorItem = new Map();
        for (const o of ordens) for (const itemId of o.itemIds) ordemPorItem.set(itemId, o);
        for (const [itemId, ordem] of ordemPorItem) {
            await connection.execute(
                'UPDATE relato_ocorrencia_itens SET status = ? WHERE id = ?',
                [ordem.status === 'Ativa' ? 'Em Execução' : 'Em Análise', itemId]
            );
        }

        await connection.query('UPDATE relatos_ocorrencia SET ? WHERE id = ?', [{
            status: 'Em Execução',
            osMc,
            osMcRegistradaEm: new Date(),
            osMcRegistradaPor: JSON.stringify(actorOf(req)),
            obraOrigemId: obraOrigemId ?? relato.obraOrigemId,
            saidaObraFeita,
            vehicleStatusAnterior: vehicle.status,
            localManutencao: b.colocarEmManutencao ? localManutencao : null,
            dataConclusaoPrevista: preview.dataConclusaoPrevistaGeral,
            recebidoEm: trimOrNull(b.recebidoEm) || relato.recebidoEm,
            responsavelManutencao: trimOrNull(b.responsavelManutencao) || relato.responsavelManutencao,
            fechadoEm: new Date(),
            fechadoPor: JSON.stringify(actorOf(req)),
        }, id]);

        await connection.commit();
        req.io?.emit('server:sync', {
            targets: ['relatos', 'orders', 'expenses', 'vehicles', 'obras'],
        });

        res.status(201).json({
            relatoId: id,
            numero: relato.numero,
            status: 'Em Execução',
            osMc,
            ordens,
            cronograma: preview.cronograma,
            dataConclusaoPrevistaGeral: preview.dataConclusaoPrevistaGeral,
            saidaObraFeita: !!saidaObraFeita,
            veiculoEmManutencao: !!b.colocarEmManutencao,
            avisos: preview.avisos,
            message: `Relato #${relato.numero} fechado. ${ordens.length} ordem(ns) gerada(s) na OS ${osMc}.`,
        });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos/:id/fechar:', error);
        res.status(500).json({ error: 'Erro ao fechar o relato.', details: error.message });
    } finally {
        connection.release();
    }
};

// POST /api/relatos/:id/recalcular-prazos
// O cronograma é persistido, então mudar a tabela de feriados depois não
// reescreve sozinho um prazo já combinado com o fornecedor. Este endpoint é o
// recálculo explícito.
const recalcularPrazos = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;
        const [[relato]] = await connection.execute('SELECT * FROM relatos_ocorrencia WHERE id = ?', [id]);
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (['Concluído', 'Cancelado'].includes(relato.status)) {
            await connection.rollback();
            return res.status(409).json({ error: `Relato ${relato.status.toLowerCase()} não tem prazo a recalcular.` });
        }

        const [itens] = await connection.execute(
            'SELECT * FROM relato_ocorrencia_itens WHERE relatoId = ? ORDER BY sequencia ASC', [id]
        );
        const preview = await montarPreview(connection, {
            relato, itens,
            dataBase: trimOrNull(req.body?.dataBase) || toYmd(new Date()),
            regiao: trimOrNull(req.body?.regiao),
        });

        for (const c of preview.cronograma) {
            await connection.query('UPDATE relato_ocorrencia_itens SET ? WHERE id = ?', [{
                ordemSequencia: c.ordemSequencia,
                dataInicioPrevista: c.dataInicioPrevista,
                dataConclusaoPrevista: c.dataConclusaoPrevista,
            }, c.itemId]);
        }
        await connection.execute(
            'UPDATE relatos_ocorrencia SET dataConclusaoPrevista = ? WHERE id = ?',
            [preview.dataConclusaoPrevistaGeral, id]
        );

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({
            cronograma: preview.cronograma,
            dataConclusaoPrevistaGeral: preview.dataConclusaoPrevistaGeral,
            avisos: preview.avisos,
        });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos/:id/recalcular-prazos:', error);
        res.status(500).json({ error: 'Erro ao recalcular os prazos.' });
    } finally {
        connection.release();
    }
};

// POST /api/relatos/:id/concluir
//
// Conclusão manual. Existe porque `orders.status = 'Concluída'` só acontece
// quando a NF é lançada na tela de Ordens, o que pode demorar — a oficina
// termina o serviço bem antes disso.
const concluirRelato = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;
        const b = req.body || {};

        const [[relato]] = await connection.execute(
            'SELECT * FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (['Concluído', 'Cancelado'].includes(relato.status)) {
            await connection.rollback();
            return res.status(409).json({ error: `Relato já está ${relato.status.toLowerCase()}.` });
        }

        const concluidoEm = trimOrNull(b.concluidoEm) || toYmd(new Date());

        // Itens que ainda não são terminais entram como concluídos junto.
        await connection.execute(
            `UPDATE relato_ocorrencia_itens
                SET status = 'Concluído', dataConclusaoReal = COALESCE(dataConclusaoReal, ?)
              WHERE relatoId = ? AND status NOT IN ('Concluído', 'Cancelado')`,
            [concluidoEm, id]
        );

        await connection.query('UPDATE relatos_ocorrencia SET ? WHERE id = ?', [{
            status: 'Concluído',
            concluidoEm,
            providenciaAdotada: trimOrNull(b.providenciaAdotada) || relato.providenciaAdotada,
            responsavelManutencao: trimOrNull(b.responsavelManutencao) || relato.responsavelManutencao,
        }, id]);

        // Liberar o equipamento é opcional: pode haver serviço pendente fora
        // deste relato. A guarda de "outro relato aberto" continua valendo.
        let veiculoLiberado = false;
        if (b.liberarVeiculo !== false) {
            veiculoLiberado = await liberarVeiculoSePossivel(connection, {
                ...relato,
                localManutencao: trimOrNull(b.localLiberacao) || relato.localManutencao,
            });
        }

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos', 'vehicles'] });
        res.json({
            message: `Relato #${relato.numero} concluído.`,
            veiculoLiberado,
            concluidoEm,
        });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos/:id/concluir:', error);
        res.status(500).json({ error: 'Erro ao concluir o relato.' });
    } finally {
        connection.release();
    }
};

// POST /api/relatos/:id/cancelar
const cancelarRelato = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;
        const motivo = trimOrNull(req.body?.motivo);

        const [[relato]] = await connection.execute(
            'SELECT * FROM relatos_ocorrencia WHERE id = ? FOR UPDATE', [id]
        );
        if (!relato) {
            await connection.rollback();
            return res.status(404).json({ error: 'Relato não encontrado.' });
        }
        if (['Concluído', 'Cancelado'].includes(relato.status)) {
            await connection.rollback();
            return res.status(409).json({ error: `Relato já está ${relato.status.toLowerCase()}.` });
        }

        // Ordem gerada é documento numerado e pode ter despesa: cancelar por
        // aqui em cascata esconderia isso do financeiro. O gestor cancela as
        // ordens na tela de Ordens e só então cancela o relato.
        const [[{ abertas }]] = await connection.execute(
            `SELECT COUNT(*) abertas
               FROM orders
              WHERE relatoId = ? AND status NOT IN ('Concluída', 'Cancelada')`,
            [id]
        );
        if (abertas > 0) {
            await connection.rollback();
            return res.status(409).json({
                error: `Existem ${abertas} ordem(ns) em aberto neste relato. Cancele-as em Ordens (C/S) antes.`,
            });
        }

        await connection.execute(
            `UPDATE relato_ocorrencia_itens
                SET status = 'Cancelado', motivoCancelamento = COALESCE(motivoCancelamento, ?)
              WHERE relatoId = ? AND status NOT IN ('Concluído', 'Cancelado')`,
            [motivo, id]
        );
        await connection.query('UPDATE relatos_ocorrencia SET ? WHERE id = ?', [{
            status: 'Cancelado',
            providenciaAdotada: motivo || relato.providenciaAdotada,
        }, id]);

        const veiculoLiberado = await liberarVeiculoSePossivel(connection, relato);

        await connection.commit();
        req.io?.emit('server:sync', { targets: ['relatos', 'vehicles'] });
        res.json({ message: `Relato #${relato.numero} cancelado.`, veiculoLiberado });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro POST /relatos/:id/cancelar:', error);
        res.status(500).json({ error: 'Erro ao cancelar o relato.' });
    } finally {
        connection.release();
    }
};

// GET /api/relatos/os-mc/:numero — tudo que está pendurado numa OS do MC.
const getPorOsMc = async (req, res) => {
    try {
        const { numero } = req.params;
        const [relatos] = await db.execute(
            'SELECT * FROM relatos_ocorrencia WHERE osMc = ? ORDER BY numero ASC', [numero]
        );
        const [ordens] = await db.execute(
            `SELECT id, orderNumber, supplier, supplierId, status, totalValue, tipo, relatoId, vehicleId
               FROM orders WHERE osMc = ? ORDER BY orderNumber ASC`, [numero]
        );
        res.json({
            osMc: numero,
            relatos: relatos.map(normalizeRelato),
            ordens: ordens.map(o => ({ ...o, totalValue: Number(o.totalValue) })),
            // Enquanto houver ordem não terminal, a OS do MC segue aberta.
            ordensAbertas: ordens.filter(o => !['Concluída', 'Cancelada'].includes(o.status)).length,
        });
    } catch (error) {
        console.error('❌ Erro GET /relatos/os-mc/:numero:', error);
        res.status(500).json({ error: 'Erro ao buscar a OS do MC.' });
    }
};

// ============================================================================
// CONFIGURAÇÃO DE GRAVIDADE / SLA
// ============================================================================

// GET /api/relatos/config/sla
const getSlaConfig = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT gravidade, label, descricao, slaDiasUteis, bloqueiaOperacao, ordemPrioridade ' +
            'FROM relato_sla_config ORDER BY ordemPrioridade ASC'
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro GET /relatos/config/sla:', error);
        res.status(500).json({ error: 'Erro ao buscar a configuração de gravidade.' });
    }
};

// PUT /api/relatos/config/sla — admin
const updateSlaConfig = async (req, res) => {
    try {
        const linhas = Array.isArray(req.body) ? req.body : [];
        if (linhas.length === 0) return res.status(400).json({ error: 'Envie ao menos uma gravidade.' });

        for (const l of linhas) {
            const g = String(l?.gravidade || '').trim().toUpperCase();
            if (!GRAVIDADES.includes(g)) {
                return res.status(400).json({ error: `Gravidade inválida: ${l?.gravidade}.` });
            }
            const sla = parseInt(l?.slaDiasUteis, 10);
            if (!Number.isInteger(sla) || sla < 1) {
                return res.status(400).json({ error: `Gravidade ${g}: o prazo deve ser de ao menos 1 dia útil.` });
            }
        }

        for (const l of linhas) {
            const patch = { slaDiasUteis: parseInt(l.slaDiasUteis, 10) };
            if ('label' in l) patch.label = trimOrNull(l.label);
            if ('descricao' in l) patch.descricao = trimOrNull(l.descricao);
            if ('bloqueiaOperacao' in l) patch.bloqueiaOperacao = l.bloqueiaOperacao ? 1 : 0;
            if ('ordemPrioridade' in l) patch.ordemPrioridade = parseInt(l.ordemPrioridade, 10) || 99;

            await db.query('UPDATE relato_sla_config SET ? WHERE gravidade = ?', [
                patch, String(l.gravidade).trim().toUpperCase(),
            ]);
        }

        req.io?.emit('server:sync', { targets: ['relatos'] });
        res.json({ message: 'Configuração de gravidade atualizada.' });
    } catch (error) {
        console.error('❌ Erro PUT /relatos/config/sla:', error);
        res.status(500).json({ error: 'Erro ao salvar a configuração de gravidade.' });
    }
};

module.exports = {
    // domínio (reaproveitado pelos serviços de fechamento)
    GRAVIDADES,
    RELATO_STATUS,
    RELATO_EDITAVEL,
    ITEM_STATUS,
    ITEM_STATUS_TERMINAL,
    EXECUTOR_TIPOS,
    normalizeRelato,
    normalizeItem,
    // handlers
    getRelatos,
    getRelatoById,
    createRelato,
    updateRelato,
    deleteRelato,
    createRelatoItem,
    updateRelatoItem,
    updateRelatoItemStatus,
    deleteRelatoItem,
    previewFechamento,
    fecharRelato,
    recalcularPrazos,
    concluirRelato,
    cancelarRelato,
    getPorOsMc,
    situacaoDoVeiculo,
    getSlaConfig,
    updateSlaConfig,
};
