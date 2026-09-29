// services/aditivoPdfGenerator.js
// Minuta do TERMO ADITIVO ao contrato de prestação de serviços (terceirizados).
// Prevista na Cláusula 9ª do contrato-modelo: "Este contrato poderá ser alterado,
// porém sempre através de Termo Aditivo, numerado em ordem crescente e assinado
// por ambas as partes."
//
// O documento é autossuficiente: qualifica as partes com o MESMO texto do contrato
// (contratoPdfCommon.js), identifica o contrato alterado, descreve o delta, mostra
// o quadro consolidado resultante e ratifica o restante.

const PDFDocument = require('pdfkit');
const {
    ensureLogo, fmtBRL, fmtHoras, fmtDate, fmtDateExtenso,
    normalizeSufixoSocietario, sanitizeText, qualificacaoPartes,
} = require('./contratoPdfCommon');

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

const TIPO_TITULO = {
    acrescimo: 'ACRÉSCIMO DE VOLUME',
    supressao: 'SUPRESSÃO DE VOLUME',
    escopo: 'INCLUSÃO DE EQUIPAMENTO',
    reajuste: 'REAJUSTE DE PREÇO',
    prazo: 'PRORROGAÇÃO DE PRAZO',
};

// Frase de abertura da cláusula do objeto, por tipo de aditivo.
const objetoTexto = (tipo) => {
    switch (tipo) {
        case 'acrescimo':
            return 'O presente Termo Aditivo tem por objeto o ACRÉSCIMO do volume de horas de máquina contratado, nos termos da Cláusula 9ª do contrato originário.';
        case 'supressao':
            return 'O presente Termo Aditivo tem por objeto a SUPRESSÃO de parte do volume de horas de máquina contratado, nos termos da Cláusula 9ª do contrato originário.';
        case 'escopo':
            return 'O presente Termo Aditivo tem por objeto a INCLUSÃO de equipamento não previsto no contrato originário, com a respectiva fixação de preço e volume, nos termos da Cláusula 9ª.';
        case 'reajuste':
            return 'O presente Termo Aditivo tem por objeto o REAJUSTE do preço por hora de máquina, mantidos os volumes contratados, nos termos da Cláusula 9ª do contrato originário.';
        case 'prazo':
            return 'O presente Termo Aditivo tem por objeto a PRORROGAÇÃO do prazo de vigência do contrato originário, mantidos os volumes e preços ajustados, nos termos da Cláusula 9ª.';
        default:
            return 'O presente Termo Aditivo tem por objeto a alteração do contrato originário, nos termos de sua Cláusula 9ª.';
    }
};

/**
 * Gera o PDF do termo aditivo. Recebe:
 *   { contrato, aditivo, locador, obra, anterior, novo }
 * onde `anterior` e `novo` são blocos `vigente` (utils/contratoAditivos.js)
 * ANTES e DEPOIS deste aditivo — é o que sustenta o quadro comparativo.
 * Retorna Promise<Buffer>.
 */
const generateAditivoPdf = async ({ contrato = {}, aditivo = {}, locador = {}, obra = {}, anterior = {}, novo = {} } = {}) => {
    const logoPath = await ensureLogo();

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const margin = 50;
        const pageWidth = doc.page.width;
        const contentWidth = pageWidth - margin * 2;

        // ── Cabeçalho ────────────────────────────────────────────────
        if (logoPath) {
            try { doc.image(logoPath, margin, 40, { width: 120 }); } catch (_) {}
        }
        doc.font('Helvetica-Bold').fontSize(15)
            .text('TERMO ADITIVO', 0, 48, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica').fontSize(11)
            .text(TIPO_TITULO[aditivo.tipo] || 'ALTERAÇÃO CONTRATUAL', 0, 68, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica-Bold').fontSize(11)
            .text(`Nº ${aditivo.numero || '—'} — ao Contrato nº ${contrato.numero || '—'}`, 0, 84, { align: 'right', width: pageWidth - margin });

        doc.moveTo(margin, 110).lineTo(pageWidth - margin, 110).stroke('#cccccc');
        doc.y = 124;

        const paragraph = (text) => {
            doc.font('Helvetica').fontSize(10.5).fillColor('#000')
                .text(text, margin, doc.y, { width: contentWidth, align: 'justify', lineGap: 2 });
            doc.moveDown(0.6);
        };
        const heading = (text) => {
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
                .text(text, margin, doc.y, { width: contentWidth });
            doc.moveDown(0.2);
        };

        const obraNome = sanitizeText(obra.nome || obra.nome_obra) || '________________';
        const fechado = contrato.contractType === 'fechado';
        const partes = qualificacaoPartes({ contrato, locador });

        // ── Preâmbulo ────────────────────────────────────────────────
        // O aditivo se identifica como alteração do contrato e é firmado na data
        // dele mesmo. A data de início do contrato original NÃO entra aqui: não é
        // a vigência do aditivo. Efeito retroativo só quando informado (efeitosDesde).
        paragraph(
            `${partes.contratante}, e, de outro lado, ${partes.contratada}, ` +
            `resolvem celebrar o presente TERMO ADITIVO, que altera o Contrato de Prestação de Serviços com ` +
            `fornecimento de equipamentos e operadores nº ${contrato.numero || '—'}, ` +
            `relativo à obra "${obraNome}", mediante as cláusulas e condições seguintes:`
        );

        let proxima = 1;
        const clausula = (titulo) => { heading(`CLÁUSULA ${proxima}ª — ${titulo}`); proxima += 1; };

        // ── Objeto ───────────────────────────────────────────────────
        clausula('DO OBJETO DO ADITIVO');
        paragraph(objetoTexto(aditivo.tipo));

        const itensDelta = Array.isArray(aditivo.itensDelta) ? aditivo.itensDelta : [];
        const itensAntes = anterior.itensContratados || [];
        const valorDelta = num(aditivo.valorDelta);

        // ── Alteração de volume e preço ──────────────────────────────
        if (itensDelta.length > 0) {
            clausula('DA ALTERAÇÃO DO VOLUME E DO PREÇO');
            if (aditivo.tipo === 'reajuste') {
                paragraph('Ficam reajustados os preços por hora de máquina, na forma abaixo, mantidos os volumes contratados:');
                itensDelta.forEach((i) => {
                    const base = itensAntes.find((b) => b.type === i.type) || {};
                    paragraph(
                        `• ${sanitizeText(i.type) || '—'}: de ${fmtBRL(base.price)}/h para ${fmtBRL(i.price)}/h, ` +
                        `aplicado sobre ${fmtHoras(base.hours)} horas contratadas.`
                    );
                });
            } else if (fechado) {
                paragraph(
                    `Fica alterado o volume de horas de máquina do contrato, com o correspondente ` +
                    `${valorDelta < 0 ? 'decréscimo' : 'acréscimo'} de ` +
                    `${fmtBRL(Math.abs(valorDelta))} sobre o valor global e fechado ajustado, ` +
                    `nos seguintes termos:`
                );
                itensDelta.forEach((i) => {
                    const h = num(i.hours);
                    paragraph(`• ${sanitizeText(i.type) || '—'}: ${h < 0 ? 'supressão' : 'acréscimo'} de ${fmtHoras(Math.abs(h))} horas.`);
                });
            } else {
                paragraph(
                    `Fica alterado o limite de horas de máquina do contrato, nos seguintes termos, com o ` +
                    `${valorDelta < 0 ? 'decréscimo' : 'acréscimo'} de ${fmtBRL(Math.abs(valorDelta))} ` +
                    `no valor máximo contratual:`
                );
                itensDelta.forEach((i) => {
                    const h = num(i.hours);
                    const p = num(i.price);
                    const novoItem = !itensAntes.some((b) => b.type === i.type);
                    paragraph(
                        `• ${sanitizeText(i.type) || '—'}${novoItem ? ' (equipamento incluído por este aditivo)' : ''}: ` +
                        `${h < 0 ? 'supressão' : 'acréscimo'} de ${fmtHoras(Math.abs(h))} h × ${fmtBRL(p)}/h = ` +
                        `${fmtBRL(Math.abs(h * p))}.`
                    );
                });
            }
        }

        // ── Quadro consolidado ───────────────────────────────────────
        // Demonstra antes → alteração → total. Em contrato por hora o total é o
        // valor MÁXIMO contratual (teto), não obrigação de pagamento integral.
        clausula('DO QUADRO CONSOLIDADO');
        // "Contrato original" só é verdade quando não há aditivo anterior a este.
        const rotuloAntes = num(anterior.totalAditivos) > 0
            ? 'Quantitativo anterior (contrato e aditivos anteriores)'
            : 'Contrato original';
        if (fechado) {
            paragraph(
                `Em razão do presente aditivo, o contrato passa a vigorar com o volume total de ` +
                `${fmtHoras(novo.horasContratadas)} horas de máquina e o valor global e fechado de ` +
                `${fmtBRL(novo.valorTotal)}, assim distribuídos:`
            );
            (novo.itensContratados || []).forEach((i) => {
                paragraph(`• ${sanitizeText(i.type) || '—'}: ${fmtHoras(num(i.hours))} horas.`);
            });
            paragraph(
                `${rotuloAntes}: ${fmtBRL(anterior.valorTotal)}. ` +
                `Valor deste aditivo: ${fmtBRL(valorDelta)}. ` +
                `Valor global consolidado: ${fmtBRL(novo.valorTotal)}.`
            );
        } else {
            paragraph(
                `Em razão do presente aditivo, o contrato passa a ter o limite de ` +
                `${fmtHoras(novo.horasContratadas)} horas de máquina e o valor máximo contratual de ` +
                `${fmtBRL(novo.valorTotal)}, assim demonstrados:`
            );
            const linhaHP = (h, p) => `${fmtHoras(h)} h × ${fmtBRL(p)}/h = ${fmtBRL(h * p)}`;
            const multiplos = (novo.itensContratados || []).length > 1;
            (novo.itensContratados || []).forEach((i) => {
                const antes = itensAntes.find((b) => b.type === i.type);
                const delta = itensDelta.find((d) => d.type === i.type);
                const hAntes = num(antes?.hours);
                const pAntes = num(antes?.price);
                const hDelta = num(delta?.hours);
                const hNovo = num(i.hours);
                const pNovo = num(i.price);
                if (multiplos) paragraph(`${sanitizeText(i.type) || '—'}:`);
                const pre = multiplos ? '   ' : '';
                const sufixo = multiplos ? '' : ` (${sanitizeText(i.type) || '—'})`;
                if (antes) paragraph(`${pre}• ${rotuloAntes}${sufixo}: ${linhaHP(hAntes, pAntes)};`);
                if (hDelta !== 0) {
                    paragraph(`${pre}• ${hDelta < 0 ? 'Supressão' : 'Acréscimo'}: ${linhaHP(Math.abs(hDelta), pNovo)};`);
                }
                if (antes && pAntes !== pNovo) {
                    paragraph(`${pre}• Reajuste de preço: de ${fmtBRL(pAntes)}/h para ${fmtBRL(pNovo)}/h;`);
                }
                paragraph(`${pre}• Total máximo contratual: ${linhaHP(hNovo, pNovo)}.`);
            });
            if (multiplos) {
                paragraph(
                    `${rotuloAntes}: ${fmtBRL(anterior.valorTotal)}. ` +
                    `Valor deste aditivo: ${fmtBRL(valorDelta)}. ` +
                    `Valor máximo contratual consolidado: ${fmtBRL(novo.valorTotal)}.`
                );
            }
            paragraph(
                `O valor máximo contratual corresponde ao limite do contrato e não representa obrigação ` +
                `de pagamento integral pela CONTRATANTE.`
            );
        }

        // ── Medição e pagamento ──────────────────────────────────────
        clausula('DA MEDIÇÃO E DO PAGAMENTO');
        paragraph(
            `As horas efetivamente executadas serão apuradas pelo Relatório de Horas da CONTRATANTE, ` +
            `observadas as condições de medição, comprovação e apresentação dos relatórios previstas ` +
            `no contrato originário.`
        );
        if (fechado) {
            paragraph(
                `O Relatório de Horas serve de acompanhamento físico da execução, sem alterar o valor ` +
                `global ora ajustado.`
            );
        } else {
            paragraph(
                `O pagamento será realizado exclusivamente pelas horas efetivamente executadas, medidas e ` +
                `aceitas pela CONTRATANTE, ao valor unitário contratado para cada equipamento, observado o ` +
                `limite máximo de horas estabelecido neste aditivo.`
            );
        }

        // ── Vigência do aditivo / prazo ──────────────────────────────
        clausula('DA VIGÊNCIA');
        paragraph(
            aditivo.efeitosDesde
                ? `Este Termo Aditivo entra em vigor na data de sua assinatura, produzindo efeitos ` +
                  `retroativos a partir de ${fmtDate(aditivo.efeitosDesde)}, por expressa convenção das partes.`
                : `Este Termo Aditivo entra em vigor na data de sua assinatura.`
        );
        if (aditivo.novaVigenciaFim) {
            paragraph(
                `Fica prorrogado o prazo de vigência do contrato originário` +
                `${anterior.vigenciaFim ? `, anteriormente previsto para ${fmtDate(anterior.vigenciaFim)},` : ''} ` +
                `até ${fmtDate(aditivo.novaVigenciaFim)}.`
            );
        }

        // ── Justificativa ────────────────────────────────────────────
        clausula('DA JUSTIFICATIVA');
        paragraph(sanitizeText(String(aditivo.justificativa || '')) || '—');
        if (aditivo.observacoes && String(aditivo.observacoes).trim()) {
            paragraph(sanitizeText(String(aditivo.observacoes)));
        }

        // ── Ratificação ──────────────────────────────────────────────
        clausula('DA RATIFICAÇÃO');
        paragraph(
            `Permanecem inalteradas e em pleno vigor todas as demais cláusulas e condições do contrato ` +
            `originário nº ${contrato.numero || '—'} não expressamente modificadas por este instrumento, ` +
            `as quais as partes desde já ratificam integralmente.`
        );
        paragraph(
            `Este Termo Aditivo passa a integrar o contrato originário para todos os fins de direito, ` +
            `sendo reconhecido, em conjunto com aquele, como título executivo extrajudicial, na forma ` +
            `dos artigos 783 e 784, III, do Código de Processo Civil.`
        );
        paragraph(
            `Fica mantido o Foro da Comarca de ${contrato.foroComarca || 'Santa Maria'}, RS, eleito no ` +
            `contrato originário, para dirimir as dúvidas emergentes deste aditivo.`
        );

        // ── Assinaturas ──────────────────────────────────────────────
        paragraph(
            `E por estarem assim justas e contratadas, as partes firmam o presente Termo Aditivo, lavrado ` +
            `em duas vias de igual teor e forma, na presença de duas testemunhas.`
        );
        // O bloco de assinaturas vai inteiro numa página só. Se não couber no que
        // sobrou da página atual, abre outra — nunca recua o cursor para cima do
        // texto já escrito (era o que sobrepunha data e assinaturas às cláusulas).
        const colW = (contentWidth - 30) / 2;
        const contratadaLabel = `CONTRATADA — ${normalizeSufixoSocietario(sanitizeText(locador.razaoSocial || locador.nome)) || ''}`;
        const contratanteLabel = 'CONTRATANTE — MAK Serviços e Pavimentações Ltda';
        doc.font('Helvetica-Bold').fontSize(9);
        const labelH = Math.max(
            doc.heightOfString(contratadaLabel, { width: colW, align: 'center' }),
            doc.heightOfString(contratanteLabel, { width: colW, align: 'center' })
        );
        const blocoH = 14 + 45 + 4 + labelH + 30 + 12 + 30;
        doc.moveDown(1);
        if (doc.y + blocoH > doc.page.height - doc.page.margins.bottom) doc.addPage();

        doc.font('Helvetica').fontSize(10)
            .text(`${contrato.foroComarca || 'Santa Maria'}, RS, ${fmtDateExtenso(new Date())}.`, margin, doc.y, { width: contentWidth });

        const lineY = doc.y + 45;
        doc.moveTo(margin, lineY).lineTo(margin + colW, lineY).stroke('#000');
        doc.moveTo(margin + colW + 30, lineY).lineTo(pageWidth - margin, lineY).stroke('#000');
        doc.font('Helvetica-Bold').fontSize(9)
            .text(contratadaLabel, margin, lineY + 4, { width: colW, align: 'center' });
        doc.text(contratanteLabel, margin + colW + 30, lineY + 4, { width: colW, align: 'center' });

        const witY = lineY + 4 + labelH + 30;
        doc.font('Helvetica').fontSize(9).text('Testemunhas:', margin, witY);
        const witLineY = witY + 12 + 30;
        doc.moveTo(margin, witLineY).lineTo(margin + colW, witLineY).stroke('#000');
        doc.moveTo(margin + colW + 30, witLineY).lineTo(pageWidth - margin, witLineY).stroke('#000');

        doc.end();
    });
};

module.exports = { generateAditivoPdf };
