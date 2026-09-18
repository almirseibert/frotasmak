// services/orderRetryService.js
// Fila de retentativa das ordens de abastecimento que não chegaram ao destino.
//
// O caso clássico: deploy derruba a sessão do WhatsApp, o microsserviço passa a
// responder 503 e toda ordem emitida na janela vira FALHA. Quando a sessão
// volta, ninguém reenvia nada — as ordens simplesmente nunca chegaram ao posto.
// Este serviço fecha esse buraco.

const db = require('../database');
const orderDelivery = require('./orderDelivery');
const whatsappService = require('./whatsappService');
const { sendToPartner, buildOrderPdfArtifact } = require('./orderNotifier');

// Quantas vezes reenviar automaticamente antes de exigir ação humana.
// Acima disso a linha continua FALHA e aparece no painel de pendências.
const MAX_TENTATIVAS_AUTO = 5;

// Só reenvia ordens recentes — reenviar uma ordem de duas semanas atrás para o
// posto causaria mais confusão que benefício.
const JANELA_HORAS = 48;

// Carrega o parceiro real. O reenvio precisa do cadastro atual (o número pode
// ter sido corrigido justamente por causa da falha).
const carregarPartner = async (partnerId) => {
    if (!partnerId) return null;
    const [rows] = await db.query(
        `SELECT id, razaoSocial, whatsapp, email, envia_por_whatsapp, envia_por_email
           FROM partners WHERE id = ?`, [partnerId]
    );
    return rows[0] || null;
};

// Reenvia UMA linha de order_notifications (um destinatário, um canal).
// Retorna { ok, motivo, resultado }.
const reenviarRegistro = async (id) => {
    await orderDelivery.ensureTable();
    const [rows] = await db.query(
        `SELECT * FROM order_notifications WHERE id = ?`, [id]
    );
    const reg = rows[0];
    if (!reg) return { ok: false, motivo: 'Registro de envio não encontrado.' };

    if (reg.status === orderDelivery.STATUS.ENVIADO) {
        return { ok: false, motivo: 'Este canal já foi entregue.' };
    }

    let order;
    try {
        order = reg.order_json ? JSON.parse(reg.order_json) : null;
    } catch (_) { order = null; }
    if (!order) {
        return { ok: false, motivo: 'Payload da ordem não foi preservado; reemita a ordem manualmente.' };
    }

    const partner = await carregarPartner(reg.partnerId);
    if (!partner) {
        return { ok: false, motivo: 'Destinatário não encontrado no cadastro. Verifique o posto/comboio.' };
    }
    const canal = reg.canal;
    if (canal === 'whatsapp' && !partner.whatsapp) {
        return { ok: false, motivo: 'Destinatário sem WhatsApp cadastrado.' };
    }
    if (canal === 'email' && !partner.email) {
        return { ok: false, motivo: 'Destinatário sem e-mail cadastrado.' };
    }

    // Regenera o PDF (os arquivos antigos são apagados pelo cron de 30 dias).
    let pdf = null;
    let pdfErro = null;
    try {
        pdf = await buildOrderPdfArtifact(order);
    } catch (e) {
        pdfErro = e.message || 'erro desconhecido';
        console.warn('[orderRetry] PDF não pôde ser regerado:', pdfErro);
    }

    const resultado = await sendToPartner(partner, order, {
        pdf,
        pdfErro,
        canais: [canal],
        destinatarioTipo: reg.destinatario_tipo,
        forceWhatsapp: canal === 'whatsapp',
        forceEmail:    canal === 'email',
    });

    const valor = canal === 'whatsapp' ? resultado.whatsapp : resultado.email;
    const ok = typeof valor === 'string' && valor.startsWith('enviado');
    return { ok, motivo: ok ? null : (valor || 'Falha desconhecida'), resultado };
};

// Varre as falhas e tenta de novo. Chamado pelo cron.
// Só roda quando o WhatsApp está de fato PRONTO — insistir com a sessão caída
// só queima tentativas e enche o log.
const processarFila = async () => {
    await orderDelivery.ensureTable();

    let waPronto = false;
    try {
        const { status } = await whatsappService.getStatus();
        waPronto = status === 'PRONTO';
    } catch (_) { waPronto = false; }

    // E-mail não depende da sessão do WhatsApp — sempre elegível.
    const canaisElegiveis = waPronto ? ['whatsapp', 'email'] : ['email'];
    const placeholders = canaisElegiveis.map(() => '?').join(',');

    const [pendentes] = await db.query(
        `SELECT id, authNumber, canal, destinatario_nome
           FROM order_notifications
          WHERE status = ?
            AND canal IN (${placeholders})
            AND tentativas < ?
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
            AND (ultima_tentativa IS NULL OR ultima_tentativa <= DATE_SUB(NOW(), INTERVAL 5 MINUTE))
          ORDER BY created_at ASC
          LIMIT 20`,
        [orderDelivery.STATUS.FALHA, ...canaisElegiveis, MAX_TENTATIVAS_AUTO, JANELA_HORAS]
    );

    if (pendentes.length === 0) return { tentadas: 0, recuperadas: 0 };

    console.log(`🔁 [orderRetry] ${pendentes.length} envio(s) pendente(s) para retentativa.`);
    let recuperadas = 0;

    for (const p of pendentes) {
        try {
            const r = await reenviarRegistro(p.id);
            if (r.ok) {
                recuperadas++;
                console.log(`✅ [orderRetry] Ordem #${p.authNumber} entregue a ${p.destinatario_nome} via ${p.canal} na retentativa.`);
                if (global.io) {
                    global.io.emit('ordem:envio_recuperado', {
                        authNumber: p.authNumber, canal: p.canal, destinatarioNome: p.destinatario_nome,
                    });
                }
            } else {
                console.warn(`⚠️ [orderRetry] Ordem #${p.authNumber} segue falhando (${p.canal}): ${r.motivo}`);
            }
        } catch (e) {
            console.error(`❌ [orderRetry] Erro ao reprocessar ${p.id}:`, e.message);
        }
    }

    if (recuperadas > 0 && global.io) {
        global.io.emit('server:sync', { resource: 'refuelings' });
    }
    return { tentadas: pendentes.length, recuperadas };
};

module.exports = { reenviarRegistro, processarFila, MAX_TENTATIVAS_AUTO, JANELA_HORAS };
