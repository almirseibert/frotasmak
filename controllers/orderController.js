// controllers/orderController.js
const db = require('../database');
const crypto = require('crypto'); // Importado para gerar UUIDs compatíveis com sua migração do Firebase
const whatsappService = require('../services/whatsappService'); // Importação do serviço de WhatsApp

// --- Funções Auxiliares Seguras de Conversão ---
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
    newOrder.items = parseJsonSafe(newOrder.items, 'items');
    newOrder.payment = parseJsonSafe(newOrder.payment, 'payment');
    newOrder.createdBy = parseJsonSafe(newOrder.createdBy, 'createdBy');
    newOrder.editedBy = parseJsonSafe(newOrder.editedBy, 'editedBy');
    newOrder.anexos = parseJsonSafe(newOrder.anexos, 'anexos') || []; 
    return newOrder;
};

// --- PREVENÇÃO DE ERRO DE CHAVE ESTRANGEIRA (FOREIGN KEY) ---
// Transforma os textos fixos vindos do frontend ("Administração", "Oficina") em NULL 
// para evitar que o MySQL bloqueie o salvamento (Constraint orders_ibfk_2)
const getSafeObraId = (id) => {
    if (!id) return null;
    if (id === 'Administração' || id === 'Oficina') return null;
    return id;
};

// --- READ ---
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

// --- CREATE ---
const createOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    let newOrderId;
    let newOrderNumber;

    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE');
        newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;
        newOrderId = crypto.randomUUID();

        const safeObraId = getSafeObraId(data.obraId);

        // DATA RESTAURADA AQUI PARA A TABELA DE ORDENS:
        const orderData = {
            id: newOrderId,
            orderNumber: newOrderNumber,
            date: data.date ? new Date(data.date) : new Date(), 
            supplierId: data.supplierId || null, 
            supplier: data.supplier || null,     
            employeeId: data.employeeId || null,
            operatorId: data.operatorId || null, 
            obraId: safeObraId,
            vehicleId: data.vehicleId || null,
            revisionId: data.revisionId || null,
            totalValue: data.totalValue || 0,
            status: data.status || 'Aberta',
            invoiceNumber: data.invoiceNumber || null,
            items: safeStringify(data.items),
            payment: safeStringify(data.payment),
            createdBy: safeStringify(data.createdBy),
            editedBy: null,
            anexos: safeStringifyArray(data.anexos)
        };
        
        await connection.query('INSERT INTO orders SET ?', [orderData]);

        await connection.execute(
            'INSERT INTO counters (name, lastNumber) VALUES ("purchaseOrderCounter", ?) ON DUPLICATE KEY UPDATE lastNumber = ?',
            [newOrderNumber, newOrderNumber]
        );

        if (orderData.status === 'Concluída' || (orderData.status === 'Ativa' && orderData.totalValue > 0)) {
            const expenseData = {
                id: crypto.randomUUID(),
                orderId: newOrderId,
                // O ERRO ERA AQUI: 'date' não existe na tabela 'expenses'. Redirecionado para 'createdAt' abaixo.
                description: `Ordem C/S #${String(newOrderNumber).padStart(6, '0')} - ${data.supplier || 'Fornecedor'}`,
                amount: orderData.totalValue,
                obraId: safeObraId,
                category: 'Manutenção / Compras',
                createdAt: orderData.date, // Data da ordem amarrada corretamente como data da despesa
                createdBy: safeStringify(data.createdBy),
            };
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
        }
        
        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        
        res.status(201).json({ id: newOrderId, orderNumber: newOrderNumber });

    } catch (error) {
        await connection.rollback();
        console.error('--- ERRO FATAL AO CRIAR ORDEM ---', error);
        return res.status(500).json({ error: 'Falha ao salvar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // -----------------------------------------------------------------------------------
    // INTEGRAÇÃO WHATSAPP EM BACKGROUND
    // -----------------------------------------------------------------------------------
    if (data.notifyWhatsapp && data.supplierId && newOrderNumber) {
        try {
            const [partnerRows] = await db.execute('SELECT razaoSocial, whatsappNumber, telefone FROM partners WHERE id = ?', [data.supplierId]);
            const partner = partnerRows[0];

            if (partner && (partner.whatsappNumber || partner.telefone)) {
                const phone = partner.whatsappNumber || partner.telefone;
                
                let msg = `🛠️ *Frotas MAK - Nova Ordem de Compra/Serviço*\n\n`;
                msg += `Olá *${partner.razaoSocial}*,\n`;
                msg += `Uma nova ordem (Nº *${String(newOrderNumber).padStart(6, '0')}*) foi gerada e atribuída a você.\n\n`;
                
                msg += `*Status Atual:* ${data.status === 'Ativa' ? 'Aprovada / Liberada' : (data.status || 'Aberta')}\n`;
                if (data.status !== 'Pendente de Valor') {
                    msg += `*Valor Total Autorizado:* R$ ${Number(data.totalValue || 0).toFixed(2)}\n`;
                } else {
                    msg += `*Atenção:* Esta ordem encontra-se PENDENTE DE VALOR (A cotar).\n`;
                }
                
                msg += `\nCaso existam anexos ou orçamentos base, eles foram enviados juntamente com esta mensagem.\nPor favor, providencie o material/serviço conforme combinado.`;

                let anexoUrl = null;
                try {
                    const anexosArray = JSON.parse(safeStringifyArray(data.anexos));
                    if (anexosArray.length > 0 && anexosArray[0].url) {
                        anexoUrl = anexosArray[0].url;
                    }
                } catch (err) { }

                whatsappService.enviarMensagem(
                    phone,
                    partner.razaoSocial,
                    `Nova Ordem C/S #${String(newOrderNumber).padStart(6, '0')}`,
                    msg,
                    anexoUrl
                ).catch(e => console.error('[WhatsApp] Falha ao enviar:', e.message));
            }
        } catch (waError) {
            console.error('[WhatsApp] Erro background envio:', waError);
        }
    }
};

// --- UPDATE ---
const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);
        const newStatus = data.status;

        const safeObraId = getSafeObraId(data.obraId);

        // DATA RESTAURADA AQUI
        const orderUpdateData = {
            supplierId: data.supplierId || null,
            supplier: data.supplier || null,
            employeeId: data.employeeId || null,
            operatorId: data.operatorId || null,
            obraId: safeObraId,
            vehicleId: data.vehicleId || null,
            revisionId: data.revisionId || null,
            invoiceNumber: data.invoiceNumber || null,
            status: newStatus,
            totalValue: data.totalValue || 0,
            date: data.date ? new Date(data.date) : new Date(),
            items: safeStringify(data.items),
            payment: safeStringify(data.payment),
            editedBy: safeStringify(data.editedBy),
            anexos: safeStringifyArray(data.anexos)
        };
        
        await connection.query('UPDATE orders SET ? WHERE id = ?', [orderUpdateData, id]);

        const originalIsClosed = originalOrder.status === 'Concluída' || originalOrder.status === 'Ativa';
        const newIsClosed = newStatus === 'Concluída' || newStatus === 'Ativa';

        if (!originalIsClosed && newIsClosed) {
            const expenseData = {
                id: crypto.randomUUID(), 
                orderId: id,
                description: `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                amount: orderUpdateData.totalValue,
                obraId: safeObraId, 
                category: 'Manutenção / Compras',
                createdAt: orderUpdateData.date, // Data transferida corretamente
                createdBy: orderUpdateData.editedBy || orderUpdateData.createdBy || null,
            };
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
            
        } else if (originalIsClosed && !newIsClosed) {
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        } else if (originalIsClosed && newIsClosed) {
            await connection.execute('UPDATE expenses SET amount = ?, description = ?, obraId = ?, createdAt = ? WHERE orderId = ?', [
                orderUpdateData.totalValue,
                `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                safeObraId, 
                orderUpdateData.date,
                id,
            ]);
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

    // -----------------------------------------------------------------------------------
    // INTEGRAÇÃO WHATSAPP EM BACKGROUND (Atualização)
    // -----------------------------------------------------------------------------------
    if (data.notifyWhatsapp && data.supplierId && originalOrder) {
        try {
            const [partnerRows] = await db.execute('SELECT razaoSocial, whatsappNumber, telefone FROM partners WHERE id = ?', [data.supplierId]);
            const partner = partnerRows[0];

            if (partner && (partner.whatsappNumber || partner.telefone)) {
                const phone = partner.whatsappNumber || partner.telefone;
                
                let msg = `🔄 *Frotas MAK - Atualização de Ordem de Compra*\n\n`;
                msg += `Olá *${partner.razaoSocial}*,\n`;
                msg += `A Ordem de Compra/Serviço Nº *${String(originalOrder.orderNumber).padStart(6, '0')}* sofreu alterações.\n\n`;
                msg += `*Novo Status:* ${data.status === 'Ativa' ? 'Aprovada / Liberada' : data.status}\n`;
                msg += `*Valor Atualizado:* R$ ${Number(data.totalValue || 0).toFixed(2)}\n\n`;
                msg += `Por favor, considere estas informações atualizadas para a execução ou faturamento.`;

                let anexoUrl = null;
                try {
                    const anexosArray = JSON.parse(safeStringifyArray(data.anexos));
                    if (anexosArray.length > 0 && anexosArray[0].url) {
                        anexoUrl = anexosArray[0].url;
                    }
                } catch (err) { }

                whatsappService.enviarMensagem(
                    phone,
                    partner.razaoSocial,
                    `Atualização Ordem #${String(originalOrder.orderNumber).padStart(6, '0')}`,
                    msg,
                    anexoUrl
                ).catch(e => console.error('[WhatsApp] Falha ao notificar atualização:', e.message));
            }
        } catch (waError) {
            console.error('[WhatsApp] Erro background:', waError);
        }
    }
};

// --- CANCEL ---
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);
        
        await connection.execute('UPDATE orders SET status = "Cancelada" WHERE id = ?', [id]);

        if (originalOrder.status === 'Concluída' || originalOrder.status === 'Ativa') {
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

    // -----------------------------------------------------------------------------------
    // INTEGRAÇÃO WHATSAPP EM BACKGROUND (Cancelamento)
    // -----------------------------------------------------------------------------------
    if (originalOrder && originalOrder.supplierId) {
        try {
            const [partnerRows] = await db.execute('SELECT razaoSocial, whatsappNumber, telefone FROM partners WHERE id = ?', [originalOrder.supplierId]);
            const partner = partnerRows[0];
            if (partner && (partner.whatsappNumber || partner.telefone)) {
                const phone = partner.whatsappNumber || partner.telefone;
                let msg = `❌ *Frotas MAK - CANCELAMENTO DE ORDEM*\n\n`;
                msg += `Atenção *${partner.razaoSocial}*,\n`;
                msg += `A Ordem de Compra/Serviço Nº *${String(originalOrder.orderNumber).padStart(6, '0')}* foi **CANCELADA** em nosso sistema.\n\n`;
                msg += `Por favor, suspenda qualquer atividade ou faturamento referente a esta ordem.\nQualquer dúvida, entre em contato com nossa equipe.`;

                whatsappService.enviarMensagem(phone, partner.razaoSocial, `Cancelamento Ordem #${originalOrder.orderNumber}`, msg).catch(() => {});
            }
        } catch (err) {}
    }
};

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

module.exports = {
    getAllOrders,
    getOrderById,
    createOrder,
    updateOrder,
    deleteOrder,
    cancelOrder,
};