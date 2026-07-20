// controllers/orderController.js
// ============================================================================
// CORREÇÕES APLICADAS:
//  1. Coluna `date` usada com fallback seguro (evita erro "Unknown column")
//  2. WhatsApp integrado no createOrder e updateOrder (background, não bloqueia)
//  3. Integração WhatsApp de cancelamento mantida
// ============================================================================

const db = require('../database');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const whatsappService = require('../services/whatsappService');
const { sendEmail } = require('../services/emailService');
const { dispatchAsync } = require('../services/notificationDispatcher');

// Resolve a URL de upload (ex.: https://host/uploads/arquivo.pdf) para o caminho
// local em public/uploads e devolve { buffer, filename } — ou null se falhar.
const resolvePdfArtifact = (pdfUrl) => {
    if (!pdfUrl) return null;
    try {
        const filename = String(pdfUrl).split('/uploads/').pop().split('?')[0];
        if (!filename) return null;
        const localPath = path.join(__dirname, '..', 'public', 'uploads', filename);
        if (!fs.existsSync(localPath)) return null;
        return { buffer: fs.readFileSync(localPath), filename };
    } catch (e) {
        console.warn('[orderController] Falha ao ler PDF do upload:', e.message);
        return null;
    }
};

// --- Funções Auxiliares ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'.`);
        return null;
    }
};

const safeStringify = (val) => {
    if (val === null || val === undefined || val === '') return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
};

const safeStringifyArray = (val) => {
    if (val === null || val === undefined || val === '') return '[]';
    return typeof val === 'string' ? val : JSON.stringify(val);
};

const parseOrderJsonFields = (order) => {
    if (!order) return null;
    const newOrder = { ...order };
    newOrder.items    = parseJsonSafe(newOrder.items,     'items');
    newOrder.payment  = parseJsonSafe(newOrder.payment,   'payment');
    newOrder.createdBy = parseJsonSafe(newOrder.createdBy, 'createdBy');
    newOrder.editedBy  = parseJsonSafe(newOrder.editedBy,  'editedBy');
    newOrder.anexos    = parseJsonSafe(newOrder.anexos,    'anexos') || [];
    return newOrder;
};

// Transforma textos fixos em NULL para evitar erros de FK
const getSafeObraId = (id) => {
    if (!id) return null;
    if (id === 'Administração' || id === 'Oficina') return null;
    return id;
};


// ============================================================================
// Helper: envia WhatsApp em background (não bloqueia a resposta HTTP)
// ============================================================================
const _notifyOrderCS = async ({ orderNumber, supplierId, status, totalValue, anexos, pdfUrl = null, notifyEmail, notifyWhatsapp, isUpdate = false, isCanceled = false }) => {
    if (!supplierId) return;

    try {
        const [partnerRows] = await db.execute(
            'SELECT razaoSocial, whatsapp, telefone, email, envia_por_whatsapp, envia_por_email FROM partners WHERE id = ?',
            [supplierId]
        );
        const partner = partnerRows[0];
        if (!partner) return;

        // Canal decidido pelos checkboxes do modal quando fornecidos;
        // caso contrário (mobile/outros callers), cai no flag do cadastro.
        const waNumber = partner.whatsapp || partner.telefone;
        const wantWa = (typeof notifyWhatsapp === 'boolean' ? notifyWhatsapp : partner.envia_por_whatsapp == 1) && !!waNumber;
        const wantEm = (typeof notifyEmail    === 'boolean' ? notifyEmail    : partner.envia_por_email    == 1) && !!partner.email;
        if (!wantWa && !wantEm) return;

        const numStr = String(orderNumber).padStart(6, '0');
        let msg = '';
        let motivo = '';

        if (isCanceled) {
            motivo = `Cancelamento Ordem #${numStr}`;
            msg  = `❌ *Frotas MAK - CANCELAMENTO DE ORDEM*\n\n`;
            msg += `Atenção *${partner.razaoSocial}*,\n`;
            msg += `A Ordem de Compra/Serviço Nº *${numStr}* foi *CANCELADA* em nosso sistema.\n\n`;
            msg += `Por favor, suspenda qualquer atividade ou faturamento referente a esta ordem.\n`;
            msg += `Qualquer dúvida, entre em contato com nossa equipe.`;
        } else if (isUpdate) {
            motivo = `Atualização Ordem #${numStr}`;
            msg  = `🔄 *Frotas MAK - Atualização de Ordem de Compra*\n\n`;
            msg += `Olá *${partner.razaoSocial}*,\n`;
            msg += `A Ordem Nº *${numStr}* sofreu alterações.\n\n`;
            msg += `*Novo Status:* ${status === 'Ativa' ? 'Aprovada / Liberada' : status}\n`;
            msg += `*Valor Atualizado:* R$ ${Number(totalValue || 0).toFixed(2)}\n\n`;
            msg += `Por favor, considere estas informações atualizadas para execução ou faturamento.`;
        } else {
            motivo = `Nova Ordem C/S #${numStr}`;
            msg  = `🛠️ *Frotas MAK - Nova Ordem de Compra/Serviço*\n\n`;
            msg += `Olá *${partner.razaoSocial}*,\n`;
            msg += `Uma nova ordem (Nº *${numStr}*) foi gerada e atribuída a você.\n\n`;
            msg += `*Status Atual:* ${status === 'Ativa' ? 'Aprovada / Liberada' : (status || 'Aberta')}\n`;
            if (status !== 'Pendente de Valor') {
                msg += `*Valor Total Autorizado:* R$ ${Number(totalValue || 0).toFixed(2)}\n`;
            } else {
                msg += `*Atenção:* Esta ordem está PENDENTE DE VALOR (A cotar).\n`;
            }
            msg += `\nCaso existam anexos ou orçamentos, eles seguem em anexo.\n`;
            msg += `Por favor, providencie o material/serviço conforme combinado.`;
        }

        // Resolve o PDF: prioriza o pdfUrl explícito (gerado no frontend com o
        // número real da ordem); senão, tenta o primeiro anexo da ordem.
        let anexoUrl = pdfUrl || null;
        if (!anexoUrl) {
            try {
                const arr = typeof anexos === 'string' ? JSON.parse(anexos) : (Array.isArray(anexos) ? anexos : []);
                if (arr.length > 0 && arr[0].url) anexoUrl = arr[0].url;
            } catch (_) {}
        }
        const pdf = resolvePdfArtifact(anexoUrl);
        const pdfFilename = `Ordem_${numStr}.pdf`;

        if (wantWa) {
            try {
                const pdfB64 = pdf?.buffer ? pdf.buffer.toString('base64') : null;
                await whatsappService.enviarMensagem(
                    waNumber, partner.razaoSocial, motivo, msg,
                    anexoUrl || null,
                    pdfB64 ? pdfFilename : null,
                    pdfB64,
                    pdfB64 ? 'application/pdf' : null
                );
                console.log(`✅ [orderController] WhatsApp enviado para ${partner.razaoSocial} (Ordem C/S #${numStr})${pdfB64 ? ' com PDF' : ''}`);
            } catch (e) {
                console.warn(`⚠️ [orderController] WhatsApp falhou para ${partner.razaoSocial}:`, e.message);
            }
        }

        if (wantEm) {
            try {
                const htmlMsg = msg.replace(/\*(.*?)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
                const attachments = pdf?.buffer ? [{
                    filename: pdfFilename,
                    content: pdf.buffer,
                    contentType: 'application/pdf',
                }] : undefined;
                await sendEmail({
                    to: partner.email,
                    subject: motivo,
                    text: msg,
                    html: `<div style="font-family:Arial,sans-serif;font-size:13px">${htmlMsg}</div>`,
                    attachments,
                });
                console.log(`✅ [orderController] E-mail enviado para ${partner.razaoSocial} (Ordem C/S #${numStr})${attachments ? ' com PDF' : ''}`);
            } catch (e) {
                console.warn(`⚠️ [orderController] E-mail falhou para ${partner.razaoSocial}:`, e.message);
            }
        }
    } catch (err) {
        console.error('[orderController] Falha na notificação da Ordem C/S:', err.message);
    }
};

// ============================================================================
// READ
// ============================================================================
const getAllOrders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders ORDER BY orderNumber DESC');
        res.json(rows.map(parseOrderJsonFields));
    } catch (error) {
        console.error('Erro ao buscar ordens:', error);
        res.status(500).json({ error: 'Erro ao buscar ordens' });
    }
};

const getOrderById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada' });
        res.json(parseOrderJsonFields(rows[0]));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar ordem' });
    }
};

// ============================================================================
// CREATE
// ============================================================================
const createOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let newOrderId;
    let newOrderNumber;

    try {
        const [counterRows] = await connection.execute(
            'SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE'
        );
        newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;
        newOrderId = crypto.randomUUID();

        const safeObraId = getSafeObraId(data.obraId);
        const orderDate  = data.date ? new Date(data.date) : new Date();

        const rawOrderData = {
            id:          newOrderId,
            orderNumber: newOrderNumber,
            date:        orderDate,          // será removido automaticamente se coluna não existir
            supplierId:  data.supplierId || null,
            supplier:    data.supplier   || null,
            employeeId:  data.employeeId || null,
            operatorId:  data.operatorId || null,
            obraId:      safeObraId,
            vehicleId:   data.vehicleId  || null,
            kmHrAtual:   data.kmHrAtual  != null ? parseFloat(data.kmHrAtual) : null,
            kmHrUnit:    data.kmHrUnit   || null,
            revisionId:  data.revisionId || null,
            totalValue:  data.totalValue || 0,
            status:      data.status     || 'Aberta',
            invoiceNumber: data.invoiceNumber || null,
            observacoes: data.observacoes || null,
            items:    safeStringify(data.items),
            payment:  safeStringify(data.payment),
            createdBy: safeStringify(data.createdBy),
            editedBy:  null,
            anexos:    safeStringifyArray(data.anexos),
        };

        await connection.query('INSERT INTO orders SET ?', [rawOrderData]);

        await connection.execute(
            'INSERT INTO counters (name, lastNumber) VALUES ("purchaseOrderCounter", ?) ON DUPLICATE KEY UPDATE lastNumber = ?',
            [newOrderNumber, newOrderNumber]
        );

        // Cria despesa se status final (Concluída ou Ativa)
        if (rawOrderData.status === 'Concluída' || rawOrderData.status === 'Ativa') {
            const expenseData = {
                id:          crypto.randomUUID(),
                orderId:     newOrderId,
                description: `Ordem C/S #${String(newOrderNumber).padStart(6, '0')} - ${data.supplier || 'Fornecedor'}`,
                amount:      rawOrderData.totalValue,
                obraId:      safeObraId,
                category:    'Manutenção / Compras',
                createdAt:   orderDate,
                createdBy:   safeStringify(data.createdBy),
            };
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });

        // Notificação configurável (Fase 3.2)
        dispatchAsync('ordem_gerada', {
            numero: String(newOrderNumber).padStart(6, '0'),
            veiculo: data.vehiclePlate || data.vehicleRegistro || '—',
            posto: data.supplier || '—',
            litros: data.litros || data.liters || '—',
            combustivel: data.fuelType || '—',
        });

        res.status(201).json({ id: newOrderId, orderNumber: newOrderNumber });

    } catch (error) {
        await connection.rollback();
        console.error('--- ERRO FATAL AO CRIAR ORDEM ---', error);
        return res.status(500).json({ error: 'Falha ao salvar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // Notificação: quando o frontend envia os checkboxes (notifyEmail/notifyWhatsapp),
    // ele dispara o envio via POST /orders/:id/notify após gerar o PDF com o número
    // real. Só notifica aqui (comportamento legado por cadastro) para callers que
    // NÃO trazem esses flags (ex.: app mobile).
    const drivesNotifyClient = typeof data.notifyEmail === 'boolean' || typeof data.notifyWhatsapp === 'boolean';
    if (newOrderNumber && !drivesNotifyClient) {
        _notifyOrderCS({
            orderNumber: newOrderNumber,
            supplierId:  data.supplierId,
            status:      data.status,
            totalValue:  data.totalValue,
            anexos:      data.anexos,
            isUpdate:    false,
        });
    }
};

// ============================================================================
// UPDATE
// ============================================================================
const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);

        if (!originalOrder) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }

        const newStatus  = data.status;
        const safeObraId = getSafeObraId(data.obraId);
        const orderDate  = data.date ? new Date(data.date) : new Date();

        const rawUpdateData = {
            supplierId:    data.supplierId    || null,
            supplier:      data.supplier      || null,
            employeeId:    data.employeeId    || null,
            operatorId:    data.operatorId    || null,
            obraId:        safeObraId,
            vehicleId:     data.vehicleId     || null,
            kmHrAtual:     data.kmHrAtual     != null ? parseFloat(data.kmHrAtual) : null,
            kmHrUnit:      data.kmHrUnit      || null,
            revisionId:    data.revisionId    || null,
            invoiceNumber: data.invoiceNumber || null,
            status:        newStatus,
            totalValue:    data.totalValue    || 0,
            observacoes:   data.observacoes    || null,
            date:          orderDate,          // removido automaticamente se não existir
            items:    safeStringify(data.items),
            payment:  safeStringify(data.payment),
            editedBy: safeStringify(data.editedBy),
            anexos:   safeStringifyArray(data.anexos),
        };

        await connection.query('UPDATE orders SET ? WHERE id = ?', [rawUpdateData, id]);

        const originalIsClosed = ['Concluída', 'Ativa'].includes(originalOrder.status);
        const newIsClosed      = ['Concluída', 'Ativa'].includes(newStatus);

        if (!originalIsClosed && newIsClosed) {
            // Cria despesa
            await connection.query('INSERT INTO expenses SET ?', [{
                id:          crypto.randomUUID(),
                orderId:     id,
                description: `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                amount:      rawUpdateData.totalValue,
                obraId:      safeObraId,
                category:    'Manutenção / Compras',
                createdAt:   orderDate,
                createdBy:   rawUpdateData.editedBy || null,
            }]);
        } else if (originalIsClosed && !newIsClosed) {
            // Remove despesa
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        } else if (originalIsClosed && newIsClosed) {
            // Atualiza despesa
            await connection.execute(
                'UPDATE expenses SET amount = ?, description = ?, obraId = ?, createdAt = ? WHERE orderId = ?',
                [
                    rawUpdateData.totalValue,
                    `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                    safeObraId,
                    orderDate,
                    id,
                ]
            );
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(200).json({ message: 'Ordem atualizada com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('--- ERRO FATAL AO ATUALIZAR ORDEM ---', error);
        return res.status(500).json({ error: 'Falha ao atualizar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // Notificação: quando o frontend envia os checkboxes, ele dispara via
    // POST /orders/:id/notify. Aqui só notifica callers legados (sem os flags).
    const drivesNotifyClient = typeof data.notifyEmail === 'boolean' || typeof data.notifyWhatsapp === 'boolean';
    if (originalOrder && !drivesNotifyClient) {
        _notifyOrderCS({
            orderNumber: originalOrder.orderNumber,
            supplierId:  data.supplierId,
            status:      data.status,
            totalValue:  data.totalValue,
            anexos:      data.anexos,
            isUpdate:    true,
        });
    }
};

// ============================================================================
// CANCEL
// ============================================================================
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);

        await connection.execute('UPDATE orders SET status = "Cancelada" WHERE id = ?', [id]);

        if (['Concluída', 'Ativa'].includes(originalOrder?.status)) {
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(200).json({ message: 'Ordem cancelada com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao cancelar ordem:', error);
        return res.status(500).json({ error: 'Falha ao cancelar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // Notifica parceiro por WhatsApp/e-mail conforme flags do cadastro (background)
    if (originalOrder?.supplierId) {
        _notifyOrderCS({
            orderNumber: originalOrder.orderNumber,
            supplierId:  originalOrder.supplierId,
            status:      'Cancelada',
            totalValue:  originalOrder.totalValue,
            isCanceled:  true,
        });
    }
};

// ============================================================================
// DELETE
// ============================================================================
const deleteOrder = async (req, res) => {
    try {
        await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar ordem:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem' });
    }
};

// ============================================================================
// NOTIFY — dispara e-mail/WhatsApp ao fornecedor com o PDF já gerado.
// Chamado pelo frontend após salvar (quando o número real da ordem já existe).
// ============================================================================
const notifyOrder = async (req, res) => {
    const { id } = req.params;
    const { pdfUrl = null, notifyEmail, notifyWhatsapp, isUpdate = false } = req.body || {};

    try {
        const [rows] = await db.execute(
            'SELECT orderNumber, supplierId, status, totalValue, anexos FROM orders WHERE id = ?',
            [id]
        );
        const order = rows[0];
        if (!order) return res.status(404).json({ error: 'Ordem não encontrada.' });

        if (!order.supplierId) {
            return res.status(200).json({ ok: false, reason: 'Ordem sem fornecedor.' });
        }
        if (notifyEmail !== true && notifyWhatsapp !== true) {
            return res.status(200).json({ ok: false, reason: 'Nenhum canal selecionado.' });
        }

        // Fire-and-forget: não bloqueia a resposta HTTP.
        _notifyOrderCS({
            orderNumber:    order.orderNumber,
            supplierId:     order.supplierId,
            status:         order.status,
            totalValue:     order.totalValue,
            anexos:         order.anexos,
            pdfUrl,
            notifyEmail:    notifyEmail === true,
            notifyWhatsapp: notifyWhatsapp === true,
            isUpdate:       !!isUpdate,
        });

        res.status(202).json({ ok: true });
    } catch (error) {
        console.error('[orderController] Falha em notifyOrder:', error.message);
        res.status(500).json({ error: 'Falha ao disparar notificação.', details: error.message });
    }
};

module.exports = {
    getAllOrders,
    getOrderById,
    createOrder,
    updateOrder,
    deleteOrder,
    cancelOrder,
    notifyOrder,
};
