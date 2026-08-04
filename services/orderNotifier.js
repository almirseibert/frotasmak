// services/orderNotifier.js
// Orquestra o envio automático de ordens de abastecimento (entrada do
// comboio, ordem de abastecimento padrão) pelos canais configurados:
//   - Posto fornecedor: respeita partners.envia_por_whatsapp / envia_por_email
//   - Comboio (origem):  sempre envia se houver contato preenchido na
//                        aba Admin → Veículos → Comboios

const db = require('../database');
const fs = require('fs');
const path = require('path');
const whatsappService = require('./whatsappService');
const { sendEmail } = require('./emailService');
const { generateOrderPdf } = require('./pdfGenerator');
const { buildComboioPartnerId } = require('../utils/ensureComboioPartner');
const orderDelivery = require('./orderDelivery');

// Diretório onde os PDFs ficam hospedados — servido via /uploads/ordens
const ORDERS_PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'ordens');
try { if (!fs.existsSync(ORDERS_PDF_DIR)) fs.mkdirSync(ORDERS_PDF_DIR, { recursive: true }); } catch (_) {}

// Base URL pública usada para o WhatsApp anexar o PDF.
// Em produção: definir PUBLIC_API_URL=https://seu-backend.com no .env.
const publicBase = () => {
    const fromEnv = process.env.PUBLIC_API_URL || process.env.REACT_APP_API_URL;
    if (fromEnv) return fromEnv.replace(/\/api\/?$/, '').replace(/\/$/, '');
    return `http://localhost:${process.env.PORT || 3001}`;
};

// Formata a data em YYYY-MM-DD no fuso BRT (GMT-3).
const fmtDateISO = (d) => {
    try {
        const date = d ? new Date(d) : new Date();
        const brt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const y = brt.getFullYear();
        const m = String(brt.getMonth() + 1).padStart(2, '0');
        const day = String(brt.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    } catch { return 'data'; }
};

// Gera o PDF da ordem, salva em disco e devolve { buffer, url, filename, filepath }.
// Nome: Autorizacao_<authNumber>_<registroInterno>_<YYYY-MM-DD>.pdf
const buildOrderPdfArtifact = async (order) => {
    const buffer = await generateOrderPdf(order);
    const authNum = String(order.authNumber || 'TEMP').replace(/\W+/g, '');
    const ri = String(order.registroInterno || '').replace(/[^\w-]/g, '') || 'V';
    const dateStr = fmtDateISO(order.date);
    const filename = `Autorizacao_${authNum}_${ri}_${dateStr}.pdf`;
    const filepath = path.join(ORDERS_PDF_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    const url = `${publicBase()}/uploads/ordens/${filename}`;
    return { buffer, url, filename, filepath };
};

// ─── Formatação ─────────────────────────────────────────────────────────────
const fmtMoney = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return 'R$ 0,00';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const fmtFuel = (f) => {
    if (!f) return '—';
    const map = { dieselS10: 'Diesel S10', dieselS500: 'Diesel S500', dieselComum: 'Diesel Comum',
                  gasolinaComum: 'Gasolina Comum', gasolinaAditivada: 'Gasolina Aditivada',
                  etanol: 'Etanol', arla32: 'Arla 32' };
    return map[f] || f;
};

const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch { return String(d); }
};

// ─── Templates ──────────────────────────────────────────────────────────────
const buildOrderText = (order) => {
    const veiculoLinha = [order.vehicleLabel, order.vehicleModelo].filter(Boolean).join(' | ');
    const litrosLinha = order.isFillUp ? 'Tanque Cheio' : `${parseFloat(order.liters || 0).toFixed(2)} L`;
    const lines = [];
    if (order.isAlteracao) {
        lines.push(
            `⚠️ *ORDEM ALTERADA* ⚠️`,
            `_Esta ordem foi modificada. Considere APENAS as informações abaixo e DESCONSIDERE a versão anterior (original) desta mesma ordem._`,
            ``
        );
    }
    lines.push(
        `*Ordem de Abastecimento Nº ${String(order.authNumber || '').padStart(6, '0')}*`,
        ``,
        `Data: ${fmtDate(order.date)}`,
        `Veículo: ${veiculoLinha || '—'}`,
        `Combustível: ${fmtFuel(order.fuelType)}`,
        `Quantidade: ${litrosLinha}`,
    );
    if (order.readingLabel && order.readingValue && order.readingValue !== 'N/A') lines.push(`${order.readingLabel}: ${order.readingValue}`);
    if (order.pricePerLiter) lines.push(`Valor/L: ${fmtMoney(order.pricePerLiter)}`);
    if (order.valorTotal)    lines.push(`Total: ${fmtMoney(order.valorTotal)}`);
    if (order.invoiceNumber) lines.push(`NF: ${order.invoiceNumber}`);
    if (order.obraName)      lines.push(`Obra: ${order.obraName}`);
    if (order.employeeName)  lines.push(`Funcionário: ${order.employeeName}`);
    if (order.partnerName)   lines.push(`Posto: ${order.partnerName}`);
    if (order.needsArla) {
        const arlaQt = order.isFillUpArla ? 'Completar Tanque' : `${parseFloat(order.litrosLiberadosArla || 0).toFixed(2)} L`;
        lines.push(`Arla 32 Autorizado: ${arlaQt}`);
    }
    if (order.outros) {
        const valor = order.outrosValor ? ` (${fmtMoney(order.outrosValor)})` : '';
        lines.push(`Outros: ${order.outros}${valor}`);
    }
    if (order.observacao)    lines.push(``, `${order.observacao}`);
    lines.push(``, `_Mensagem automática — Sistema MAK Frotas_`);
    return lines.join('\n');
};

const buildOrderHtml = (order) => {
    const row = (k, v) => v ? `<tr><td style="padding:4px 8px;border:1px solid #e5e7eb;font-weight:600;background:#f9fafb">${k}</td><td style="padding:4px 8px;border:1px solid #e5e7eb">${v}</td></tr>` : '';
    const alteracaoBanner = order.isAlteracao ? `
        <div style="background:#fef2f2;border:2px solid #dc2626;color:#991b1b;padding:10px 12px;border-radius:6px;margin-bottom:10px;font-size:13px;font-weight:600">
            ⚠️ ORDEM ALTERADA — Esta ordem foi modificada. Considere APENAS as informações abaixo e desconsidere a versão anterior (original) desta mesma ordem.
        </div>` : '';
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px">
        ${alteracaoBanner}
        <h2 style="background:#fbbf24;color:#1f2937;padding:12px;margin:0;border-radius:6px 6px 0 0">
            Ordem de Abastecimento Nº ${String(order.authNumber || '').padStart(6, '0')}
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:0;border:1px solid #e5e7eb">
            ${row('Data',         fmtDate(order.date))}
            ${row('Veículo',      [order.vehicleLabel, order.vehicleModelo].filter(Boolean).join(' | '))}
            ${row('Combustível',  fmtFuel(order.fuelType))}
            ${row('Quantidade',   order.isFillUp ? 'Tanque Cheio' : `${parseFloat(order.liters || 0).toFixed(2)} L`)}
            ${order.readingLabel && order.readingValue && order.readingValue !== 'N/A' ? row(order.readingLabel, order.readingValue) : ''}
            ${row('Valor/L',      order.pricePerLiter ? fmtMoney(order.pricePerLiter) : '')}
            ${row('Total',        order.valorTotal    ? fmtMoney(order.valorTotal)    : '')}
            ${row('Nota Fiscal',  order.invoiceNumber)}
            ${row('Obra',         order.obraName)}
            ${row('Funcionário',  order.employeeName)}
            ${row('Posto',        order.partnerName)}
            ${order.needsArla ? row('Arla 32 Autorizado', order.isFillUpArla ? 'Completar Tanque' : `${parseFloat(order.litrosLiberadosArla || 0).toFixed(2)} L`) : ''}
            ${order.outros ? row('Outros Itens/Observação', `${order.outros}${order.outrosValor ? ` (${fmtMoney(order.outrosValor)})` : ''}`) : ''}
            ${row('Observação',   order.observacao)}
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:12px">Mensagem automática — Sistema MAK Frotas</p>
    </div>`;
};

// ─── Envio para um partner específico, conforme suas flags ──────────────────
// opts.forceWhatsapp / opts.forceEmail ignoram as flags do partner (usado para o comboio)
// opts.pdf = { buffer, url, filename } — pré-gerado uma vez e reusado entre canais
// opts.canais = ['whatsapp'] restringe quais canais são tentados E rastreados.
//   Usado no reenvio manual/automático: reenviar só o WhatsApp não pode
//   sobrescrever o registro de um e-mail que já havia sido entregue.
const sendToPartner = async (partner, order, opts = {}) => {
    const out = { whatsapp: null, email: null };
    if (!partner) return out;

    const canais = opts.canais || ['whatsapp', 'email'];
    const usaWa  = canais.includes('whatsapp');
    const usaEm  = canais.includes('email');

    const wantWa = usaWa && (opts.forceWhatsapp || partner.envia_por_whatsapp == 1);
    const wantEm = usaEm && (opts.forceEmail    || partner.envia_por_email    == 1);
    const pdf = opts.pdf || null;

    // Contexto de rastreio — toda tentativa (ou ausência dela) vira linha em
    // order_notifications para que a tela de ordens saiba o que aconteceu.
    const S = orderDelivery.STATUS;
    const rastreio = (canal, status, extra = {}) => orderDelivery.registrar({
        authNumber:       order.authNumber,
        tipo:             order.tipo,
        destinatarioTipo: opts.destinatarioTipo || 'posto',
        partnerId:        partner.id || null,
        destinatarioNome: partner.razaoSocial || partner.nomeFantasia || 'Destinatário',
        canal,
        status,
        order:            opts.rastrearPayload === false ? null : order,
        ...extra,
    });

    // ── WhatsApp ────────────────────────────────────────────────────────────
    if (!usaWa) {
        // Canal fora do escopo desta chamada (reenvio seletivo) — não mexe no registro.
    } else if (!wantWa) {
        // Canal desligado no cadastro do posto. Não é erro, mas precisa ficar
        // visível — senão a ordem "some" sem nenhum registro.
        await rastreio('whatsapp', S.DESATIVADO);
    } else if (!partner.whatsapp) {
        await rastreio('whatsapp', S.SEM_CONTATO, { erro: 'Parceiro sem número de WhatsApp cadastrado.' });
        out.whatsapp = 'sem contato cadastrado';
    }

    if (wantWa && partner.whatsapp) {
        await rastreio('whatsapp', S.PENDENTE, { destino: partner.whatsapp });
        try {
            // Envia o PDF como base64 (mesmo buffer já gerado para o e-mail).
            // O microsserviço usa o buffer direto — sem precisar baixar a URL,
            // o que evita falhas silenciosas que faziam o WhatsApp chegar
            // apenas com o texto, sem o anexo.
            const pdfB64 = pdf?.buffer ? pdf.buffer.toString('base64') : null;
            const resp = await whatsappService.enviarMensagem(
                partner.whatsapp,
                partner.razaoSocial || 'Posto',
                `ordem_${order.tipo || 'abastecimento'}_${order.authNumber || ''}`,
                buildOrderText(order),
                pdf?.url || null,
                pdf?.filename || null,
                pdfB64,
                pdfB64 ? 'application/pdf' : null
            );
            // O microsserviço devolve pdfStatus = 'enviado' | 'falha: <msg>' | null.
            // Texto entregue mas PDF não é PARCIAL — o posto recebeu a ordem, mas
            // sem o documento; quem emitiu precisa saber.
            const pediuAnexo = !!(pdfB64 || pdf?.url);
            const pdfStatus = resp?.pdfStatus || null;
            const parcial = pediuAnexo && pdfStatus && pdfStatus !== 'enviado';
            await rastreio('whatsapp', parcial ? S.PARCIAL : S.ENVIADO, {
                destino: partner.whatsapp,
                erro: parcial ? `Texto entregue, PDF não: ${pdfStatus}` : null,
                incrementaTentativa: true,
            });
            out.whatsapp = parcial ? `parcial (PDF: ${pdfStatus})` : (pediuAnexo ? 'enviado (com PDF)' : 'enviado');
        } catch (e) {
            console.warn(`[orderNotifier] WhatsApp falhou para ${partner.razaoSocial}:`, e.message);
            await rastreio('whatsapp', S.FALHA, {
                destino: partner.whatsapp, erro: e.message, incrementaTentativa: true,
            });
            out.whatsapp = `falha: ${e.message}`;
        }
    }

    // ── E-mail ──────────────────────────────────────────────────────────────
    if (!usaEm) {
        // Fora do escopo desta chamada.
    } else if (!wantEm) {
        await rastreio('email', S.DESATIVADO);
    } else if (!partner.email) {
        await rastreio('email', S.SEM_CONTATO, { erro: 'Parceiro sem e-mail cadastrado.' });
        out.email = 'sem contato cadastrado';
    }

    if (wantEm && partner.email) {
        try {
            const attachments = pdf?.buffer ? [{
                filename: pdf.filename || `Autorizacao_${order.authNumber || 'TEMP'}.pdf`,
                content: pdf.buffer,
                contentType: 'application/pdf',
            }] : undefined;
            const authNum = String(order.authNumber || '').padStart(6, '0');
            const ri = order.registroInterno || '';
            const dateStr = fmtDateISO(order.date);
            const baseSubject = ri
                ? `Autorizacao_${authNum}_${ri}_${dateStr}`
                : `Ordem de Abastecimento Nº ${authNum}`;
            const emailSubject = order.isAlteracao ? `[ALTERADA] ${baseSubject}` : baseSubject;
            const r = await sendEmail({
                to: partner.email,
                subject: emailSubject,
                text: buildOrderText(order),
                html: buildOrderHtml(order),
                attachments,
            });
            await rastreio('email', r.skipped ? S.FALHA : S.ENVIADO, {
                destino: partner.email,
                erro: r.skipped ? `Envio pulado: ${r.reason}` : null,
                incrementaTentativa: true,
            });
            out.email = r.skipped ? `pulado: ${r.reason}` : (pdf?.buffer ? 'enviado (com PDF)' : 'enviado');
        } catch (e) {
            console.warn(`[orderNotifier] E-mail falhou para ${partner.razaoSocial}:`, e.message);
            await rastreio('email', S.FALHA, {
                destino: partner.email, erro: e.message, incrementaTentativa: true,
            });
            out.email = `falha: ${e.message}`;
        }
    }

    // Se nenhum canal entregou, avisa em tempo real quem estiver na tela.
    await notificarSeFalhou(order, out, opts.destinatarioTipo || 'posto', partner);

    return out;
};

// Emite socket quando a ordem NÃO chegou ao destino por nenhum canal.
// O frontend usa isso para o toast imediato ao emitir a ordem — sem isso o
// usuário só descobriria pelo badge, depois de recarregar a lista.
const notificarSeFalhou = async (order, out, destinatarioTipo, partner) => {
    try {
        const okWa = out.whatsapp === 'enviado' || String(out.whatsapp || '').startsWith('enviado');
        const okEm = out.email === 'enviado' || String(out.email || '').startsWith('enviado');
        const parcial = String(out.whatsapp || '').startsWith('parcial');
        if (okWa || okEm || parcial) return;
        if (!global.io) return;
        global.io.emit('ordem:falha_envio', {
            authNumber:       order.authNumber,
            destinatarioTipo,
            destinatarioNome: partner?.razaoSocial || partner?.nomeFantasia || 'Destinatário',
            whatsapp:         out.whatsapp,
            email:            out.email,
        });
        console.error(`🚨 [orderNotifier] Ordem #${order.authNumber} NÃO entregue a ${destinatarioTipo} — whatsapp: ${out.whatsapp} | email: ${out.email}`);
    } catch (_) {}
};

// ─── Notificação principal de entrada do comboio ────────────────────────────
// Envia para:
//   1) Posto fornecedor (respeita flags envia_por_whatsapp / envia_por_email)
//   2) Comboio (sempre — quando há contato configurado)
const notifyComboioEntrada = async ({ partnerId, comboioVehicleId, order }) => {
    const result = { posto: null, comboio: null, pdf: null };

    // Gera o PDF UMA vez e reusa em todos os canais/destinatários
    let pdf = null;
    try {
        pdf = await buildOrderPdfArtifact(order);
        result.pdf = { url: pdf.url, filename: pdf.filename };
    } catch (e) {
        console.warn('[orderNotifier] geração de PDF falhou:', e.message);
    }

    // 1) Posto fornecedor
    if (partnerId) {
        try {
            const [rows] = await db.query(
                `SELECT id, razaoSocial, whatsapp, email, envia_por_whatsapp, envia_por_email
                 FROM partners WHERE id = ?`, [partnerId]
            );
            if (rows.length > 0) {
                result.posto = await sendToPartner(
                    rows[0],
                    { ...order, partnerName: rows[0].razaoSocial },
                    { pdf, destinatarioTipo: 'posto' }
                );
            } else {
                // Ordem aponta para um partnerId que não existe mais — silêncio
                // total antes desta mudança. Agora fica registrado.
                await orderDelivery.registrar({
                    authNumber: order.authNumber, tipo: order.tipo,
                    destinatarioTipo: 'posto', partnerId, canal: 'whatsapp',
                    status: orderDelivery.STATUS.SEM_CONTATO,
                    erro: `Posto ${partnerId} não encontrado no cadastro.`, order,
                });
            }
        } catch (e) {
            console.warn('[orderNotifier] erro ao buscar posto:', e.message);
            await orderDelivery.registrar({
                authNumber: order.authNumber, tipo: order.tipo,
                destinatarioTipo: 'posto', partnerId, canal: 'whatsapp',
                status: orderDelivery.STATUS.FALHA,
                erro: `Erro ao buscar posto: ${e.message}`, order,
            });
        }
    } else {
        // Ordem sem posto vinculado: nada a enviar, mas registramos para a
        // tela não mostrar "pendente" eternamente.
        await orderDelivery.registrar({
            authNumber: order.authNumber, tipo: order.tipo,
            destinatarioTipo: 'posto', canal: 'whatsapp',
            status: orderDelivery.STATUS.SEM_CONTATO,
            erro: 'Ordem sem posto vinculado.', order,
        });
    }

    // 2) Comboio (espelho em partners) — sempre tenta enviar se contato existir
    if (comboioVehicleId) {
        try {
            const comboioPartnerId = buildComboioPartnerId(comboioVehicleId);
            const [rows] = await db.query(
                `SELECT id, razaoSocial, whatsapp, email FROM partners WHERE id = ?`,
                [comboioPartnerId]
            );
            if (rows.length > 0) {
                const c = rows[0];
                // Para o comboio, força os canais que tiverem contato cadastrado
                result.comboio = await sendToPartner(
                    { ...c, envia_por_whatsapp: c.whatsapp ? 1 : 0, envia_por_email: c.email ? 1 : 0 },
                    order,
                    { forceWhatsapp: !!c.whatsapp, forceEmail: !!c.email, pdf, destinatarioTipo: 'comboio' }
                );
            }
        } catch (e) {
            console.warn('[orderNotifier] erro ao buscar comboio:', e.message);
        }
    }

    return result;
};

module.exports = {
    notifyComboioEntrada,
    sendToPartner,
    buildOrderText,
    buildOrderHtml,
    buildOrderPdfArtifact,
};
