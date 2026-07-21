// services/contratoPdfGenerator.js
// Geração server-side do PDF de Contrato de Prestação de Serviço / Locação de
// Equipamento com Operador (terceirizados). Reaproveita o cache de logo do
// pdfGenerator de abastecimento.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOGO_URL = 'https://i.postimg.cc/pVnwyfRq/MAK-Servi-os-Logotipo.png';
const LOGO_CACHE_PATH = path.join(__dirname, '..', 'public', 'mak-logo-cache.png');

const ensureLogo = () => new Promise((resolve) => {
    if (fs.existsSync(LOGO_CACHE_PATH)) return resolve(LOGO_CACHE_PATH);
    const file = fs.createWriteStream(LOGO_CACHE_PATH);
    https.get(LOGO_URL, (res) => {
        if (res.statusCode !== 200) { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); return resolve(null); }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(LOGO_CACHE_PATH)));
    }).on('error', () => { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); resolve(null); });
});

const fmtBRL = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtNum = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Horas: sem casa decimal quando inteiro (514, não 514,0); 1 casa quando fracionário (7,5).
const fmtHoras = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const fmtDate = (d) => {
    if (!d) return '____/____/______';
    try {
        const date = new Date(d);
        if (isNaN(date.getTime())) return '____/____/______';
        return date.toLocaleDateString('pt-BR');
    } catch { return '____/____/______'; }
};

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// Data por extenso para o fecho ("17 de julho de 2026").
const fmtDateExtenso = (d) => {
    try {
        const date = d ? new Date(d) : new Date();
        if (isNaN(date.getTime())) return '';
        return `${date.getDate()} de ${MESES[date.getMonth()]} de ${date.getFullYear()}`;
    } catch { return ''; }
};

// Número por extenso para prazos em meses (cobre os valores usuais de contrato).
// Fora do mapa, o PDF mostra só o algarismo — sem parêntese por extenso.
const NUM_EXTENSO = {
    1: 'um', 2: 'dois', 3: 'três', 4: 'quatro', 5: 'cinco', 6: 'seis',
    7: 'sete', 8: 'oito', 9: 'nove', 10: 'dez', 11: 'onze', 12: 'doze',
    13: 'treze', 14: 'quatorze', 15: 'quinze', 16: 'dezesseis', 17: 'dezessete',
    18: 'dezoito', 19: 'dezenove', 20: 'vinte', 24: 'vinte e quatro',
    30: 'trinta', 36: 'trinta e seis', 48: 'quarenta e oito', 60: 'sessenta',
};
const mesesExtenso = (n) => (NUM_EXTENSO[n] ? ` (${NUM_EXTENSO[n]})` : '');

// Aplica máscara de CNPJ (00.000.000/0000-00) ou CPF (000.000.000-00) a partir
// dos dígitos. Se o valor não tiver a quantidade esperada de dígitos, devolve o
// original (evita mascarar dado incompleto/errado como se fosse válido).
const maskCNPJ = (v) => {
    const dig = String(v || '').replace(/\D/g, '');
    if (dig.length !== 14) return (v && String(v).trim()) || '';
    return dig.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
};
const maskCPF = (v) => {
    const dig = String(v || '').replace(/\D/g, '');
    if (dig.length !== 11) return (v && String(v).trim()) || '';
    return dig.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
};

// Corrige erros de digitação comuns no sufixo societário (LLTDA → LTDA etc.) e
// normaliza o espaçamento antes do sufixo, sem alterar o núcleo da razão social.
const normalizeSufixoSocietario = (s) => {
    if (typeof s !== 'string' || !s.trim()) return s;
    return s
        .replace(/\bL+TDA\b\.?/gi, 'LTDA')          // LLTDA, LLLTDA, LTDA.
        .replace(/\bLTD\b\.?/gi, 'LTDA')            // LTD → LTDA
        .replace(/\bEIRELLI\b/gi, 'EIRELI')
        .replace(/\bS\.?\s*\/?\s*A\b\.?/gi, 'S.A.') // S A, S/A, SA → S.A.
        .replace(/\s{2,}/g, ' ')
        .trim();
};

// Qualificação do representante legal da CONTRATANTE (MAK) — dado societário fixo
// da empresa, conforme contrato-modelo validado. Ajustar aqui se houver troca de
// signatário.
const MAK_REPRESENTANTE = {
    nome: 'Thiago Arthur Klaus',
    nacionalidade: 'brasileiro',
    profissao: 'empresário',
    cpf: '026.692.750-52',
};

// A fonte padrão do pdfkit (Helvetica/WinAnsiEncoding) não tem glifo para emoji e
// símbolos fora do CP1252 — em vez de imprimir lixo binário, removemos esses
// caracteres de qualquer valor vindo do cadastro (nome de obra, parceiro etc.).
const sanitizeText = (s) => {
    if (typeof s !== 'string') return s;
    return s
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2300}-\u{23FF}]/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
};

/**
 * Gera o PDF do contrato. Recebe { contrato, locador, obra }.
 * Retorna Promise<Buffer>.
 */
const generateContratoPdf = async ({ contrato = {}, locador = {}, obra = {} } = {}) => {
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
            .text('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', 0, 48, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica').fontSize(11)
            .text('Locação de equipamento com operador', 0, 68, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica-Bold').fontSize(11)
            .text(`Nº ${contrato.numero || '—'}`, 0, 84, { align: 'right', width: pageWidth - margin });

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

        const locadorNome = normalizeSufixoSocietario(sanitizeText(locador.razaoSocial || locador.nome)) || '___________________________';
        const locadorTelefone = sanitizeText(locador.telefone);
        const locadorEndereco = sanitizeText(locador.endereco);
        const locadorBairro = sanitizeText(locador.bairro);
        const locadorCidade = sanitizeText(locador.cidade);
        const locadorCep = sanitizeText(locador.cep);
        const tipoMaquina = sanitizeText(contrato.tipoMaquina) || '________________';
        const obraNome = sanitizeText(obra.nome || obra.nome_obra) || '________________';

        // Pessoa física × jurídica muda a qualificação da CONTRATADA (CPF vs CNPJ).
        const isPF = String(locador.tipoPessoa || '').toLowerCase() === 'fisica';
        const locadorDoc = isPF ? maskCPF(locador.cnpj) : maskCNPJ(locador.cnpj);
        const locadorQualif = isPF
            ? (locadorDoc ? `, pessoa física, inscrita no CPF sob nº ${locadorDoc}` : `, pessoa física`)
            : (locadorDoc ? `, pessoa jurídica de direito privado, inscrita no CNPJ sob nº ${locadorDoc}` : '');

        // Representante legal da CONTRATADA (assinante). Precedência: o preenchido no
        // próprio contrato prevalece; na ausência, cai no representante legal do
        // cadastro do terceiro (partners.representanteLegal*). Resolve-se como bloco
        // para não parear nome de uma origem com CPF de outra.
        let cRepNome, cRepQualif, cRepCpf;
        if (sanitizeText(contrato.contratadaRepresentanteNome)) {
            cRepNome = sanitizeText(contrato.contratadaRepresentanteNome);
            cRepQualif = sanitizeText(contrato.contratadaRepresentanteQualificacao);
            cRepCpf = maskCPF(contrato.contratadaRepresentanteCpf);
        } else {
            cRepNome = sanitizeText(locador.representanteLegalNome);
            cRepQualif = '';
            cRepCpf = maskCPF(locador.representanteLegalCpf);
        }

        // Trecho de qualificação do representante da CONTRATADA (nome, qualificação, CPF).
        // Pessoa física sem representante nomeado assina em nome próprio (sem "por seu representante legal").
        const contratadaRepTexto = cRepNome
            ? `, neste ato representada por ${cRepNome}` +
              `${cRepQualif ? `, ${cRepQualif}` : ''}` +
              `${cRepCpf ? `, inscrito no CPF sob nº ${cRepCpf}` : ''}`
            : (isPF ? `` : `, neste ato por seu representante legal`);

        // Endereço da CONTRATADA (logradouro livre + bairro + cidade/UF + CEP, do cadastro).
        const enderecoPartes = [
            locadorEndereco,
            locadorBairro,
            locadorCidade,
            locadorCep ? `CEP ${String(locadorCep).replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') || locadorCep}` : null,
        ].filter(Boolean);
        const contratadaEnderecoTexto = enderecoPartes.length
            ? `, ${isPF ? 'residente e domiciliada em' : 'com sede na'} ${enderecoPartes.join(', ')}`
            : '';

        // ── Qualificação das partes ──────────────────────────────────
        paragraph(
            `MAK SERVIÇOS E PAVIMENTAÇÕES LTDA, pessoa jurídica de direito privado, com sede na ` +
            `Rodovia BR-392, nº 3639, Bairro Tomazetti, Santa Maria/RS, inscrita no CNPJ sob nº ` +
            `13.137.265/0001-88, neste ato representada por ${MAK_REPRESENTANTE.nome}, ` +
            `${MAK_REPRESENTANTE.nacionalidade}, ${MAK_REPRESENTANTE.profissao}, inscrito no CPF sob nº ` +
            `${MAK_REPRESENTANTE.cpf}, doravante denominada simplesmente CONTRATANTE, e, de outro lado, ` +
            `${locadorNome}${locadorQualif}${contratadaEnderecoTexto}` +
            `${locadorTelefone ? `, telefone ${locadorTelefone}` : ''}${contratadaRepTexto}, ` +
            `doravante denominada simplesmente CONTRATADA, convencionam o presente contrato de ` +
            `locação de máquina e prestação de serviços, mediante as seguintes cláusulas e condições:`
        );

        // ── Objeto ───────────────────────────────────────────────────
        heading('CLÁUSULA 1ª — DO OBJETO');
        paragraph(
            `O presente contrato tem por objeto a locação de equipamento para prestação de serviços ` +
            `(incluindo operador) do tipo ${tipoMaquina}, pela CONTRATADA, ` +
            `na obra "${obraNome}", ` +
            `mediante equipamento próprio com operador.`
        );
        paragraph(
            `a) A CONTRATADA deverá fornecer, às suas expensas, operador da máquina devidamente ` +
            `habilitado e treinado, combustível, manutenção, reposição de óleos e graxas e transporte ` +
            `até o local da prestação dos serviços.`
        );
        paragraph(`b) O período de transporte da máquina não será computado como hora trabalhada.`);
        paragraph(`c) Os trabalhos poderão ser supervisionados por técnicos contratados pela CONTRATANTE.`);
        paragraph(`d) Os locais onde serão prestados os serviços ora contratados serão indicados pela CONTRATANTE.`);
        // Observações do cadastro entram como item adicional do objeto (não mais em cláusula própria ao fim).
        if (contrato.observacoes && String(contrato.observacoes).trim()) {
            paragraph(`e) ${sanitizeText(String(contrato.observacoes))}`);
        }

        // ── Volume e preço ───────────────────────────────────────────
        heading('CLÁUSULA 2ª — DO VOLUME E DO PREÇO');
        let itens = contrato.itensContratados;
        if (typeof itens === 'string') { try { itens = JSON.parse(itens); } catch { itens = []; } }
        if (!Array.isArray(itens)) itens = [];

        if (contrato.contractType === 'fechado') {
            if (itens.length > 0) {
                paragraph(
                    `A CONTRATADA executará o objeto pelo valor global e fechado de ` +
                    `${fmtBRL(contrato.valorTotal)}, independentemente do volume de horas efetivamente executado, ` +
                    `compreendendo os seguintes volumes de máquina:`
                );
                itens.forEach((i) => {
                    paragraph(`• ${sanitizeText(i.type) || '—'}: ${fmtHoras(Number(i.hours) || 0)} horas.`);
                });
            } else {
                paragraph(
                    `A CONTRATADA executará o objeto pelo valor global e fechado de ` +
                    `${fmtBRL(contrato.valorTotal)}, independentemente do volume de horas efetivamente executado.`
                );
            }
        } else if (itens.length > 0) {
            paragraph(
                `A CONTRATADA executará os seguintes volumes de máquina, cujo somatório perfaz o valor ` +
                `global e fechado de ${fmtBRL(contrato.valorTotal)}:`
            );
            itens.forEach((i) => {
                const h = Number(i.hours) || 0;
                const p = Number(i.price) || 0;
                paragraph(
                    `• ${sanitizeText(i.type) || '—'}: ${fmtHoras(h)} h × ${fmtBRL(p)}/h = ${fmtBRL(h * p)}.`
                );
            });
        } else {
            paragraph(
                `A CONTRATADA executará o total de ${fmtHoras(contrato.horasContratadas)} horas de máquina, ` +
                `ao valor de ${fmtBRL(contrato.valorHora)} por hora, totalizando o valor global e fechado de ` +
                `${fmtBRL(contrato.valorTotal)}.`
            );
        }
        paragraph(
            `O preço para o presente contrato é o constante da proposta aprovada pela CONTRATANTE, ` +
            `entendido este como preço justo e suficiente para a total execução do presente objeto.`
        );
        paragraph(
            `As horas efetivamente executadas serão apuradas pelo Relatório de Horas da CONTRATANTE, ` +
            `servindo de acompanhamento físico da execução, sem alterar o valor global ora ajustado.`
        );
        const prazoPagamentoDias = contrato.prazoPagamentoDias || 45;
        paragraph(
            `O pagamento pela prestação dos serviços será feito em favor da CONTRATADA mediante ` +
            `depósito bancário em conta corrente por ela indicada, e somente após a expressa autorização ` +
            `da CONTRATANTE, mediante apresentação da nota fiscal e do relatório/planilha de horas, os ` +
            `quais deverão ser previamente conferidos e aceitos pela CONTRATANTE. O prazo de pagamento ` +
            `será de até ${prazoPagamentoDias} dias contados da data do aceite formal da CONTRATANTE, e ` +
            `não da mera conclusão dos serviços. Recaindo o vencimento em feriado ` +
            `(nacional, estadual ou municipal), o vencimento fica prorrogado para o primeiro dia útil ` +
            `subsequente. O CNPJ constante das notas fiscais/faturas deverá ser o constante na ` +
            `qualificação das partes deste contrato.`
        );
        paragraph(
            `A emissão da respectiva Nota Fiscal de prestação de serviços pela CONTRATADA é condição ` +
            `indispensável e prévia à realização de qualquer pagamento, que não será efetuado, a nenhum ` +
            `título, sem a apresentação do competente documento fiscal.`
        );
        paragraph(
            `Na hipótese de inadimplência no vencimento estipulado, a critério da CONTRATADA, será a ` +
            `mesma atualizada com juros de mora de ${fmtNum(contrato.percentualJurosMora || 1)}% ` +
            `(ao mês), bem como multa moratória de ${fmtNum(contrato.percentualMultaMora || 1)}% ` +
            `calculada sobre o valor da parcela inadimplida.`
        );

        // ── Abatimentos ──────────────────────────────────────────────
        heading('CLÁUSULA 3ª — DOS ABATIMENTOS');
        paragraph(
            `Serão descontados do valor global os adiantamentos pagos pela CONTRATANTE. Caso a ` +
            `CONTRATANTE forneça combustível aos equipamentos da CONTRATADA, o respectivo valor, apurado ` +
            `pelo preço efetivo de cada abastecimento, será igualmente deduzido do valor global, a título ` +
            `de adiantamento. O saldo a pagar corresponde ao valor global deduzido de tais abatimentos.`
        );

        // ── Vigência ─────────────────────────────────────────────────
        heading('CLÁUSULA 4ª — DA VIGÊNCIA E DO PRAZO');
        const prazoVigenciaMeses = parseInt(contrato.prazoVigenciaMeses, 10) > 0 ? parseInt(contrato.prazoVigenciaMeses, 10) : 6;
        paragraph(
            `O presente contrato vigora pelo prazo de ${prazoVigenciaMeses}${mesesExtenso(prazoVigenciaMeses)} ` +
            `${prazoVigenciaMeses === 1 ? 'mês' : 'meses'}, contados da data de assinatura deste instrumento, ` +
            `podendo ser prorrogado mediante acordo entre as partes, conforme o artigo 571 do Código Civil.`
        );
        // Quando o início de vigência é anterior à assinatura, ratifica os atos já
        // praticados para não deixar a execução pretérita sem cobertura contratual.
        const _assinatura = new Date();
        const _vigIni = contrato.vigenciaInicio ? new Date(contrato.vigenciaInicio) : null;
        if (_vigIni && !isNaN(_vigIni.getTime()) &&
            _vigIni < new Date(_assinatura.getFullYear(), _assinatura.getMonth(), _assinatura.getDate())) {
            paragraph(
                `As partes reconhecem e ratificam, para todos os fins de direito, os atos e serviços ` +
                `eventualmente praticados desde o início da vigência ora ajustado (` +
                `${fmtDate(contrato.vigenciaInicio)}), ainda que anteriores à data de assinatura deste ` +
                `instrumento, os quais passam a integrar o objeto do presente contrato.`
            );
        }

        // ── Execução e Gestão ────────────────────────────────────────
        heading('CLÁUSULA 5ª — DA EXECUÇÃO E GESTÃO DO CONTRATO');
        paragraph(`A execução dos serviços será iniciada imediatamente a partir da assinatura do presente contrato.`);
        paragraph(
            `A CONTRATANTE, através de seus representantes, será responsável pela requisição do objeto, ` +
            `acompanhamento da entrega e fiscalização dos mesmos, observando as exigências referidas no ` +
            `presente instrumento.`
        );

        // ── Obrigações das partes ────────────────────────────────────
        const prazoSubstituicao = contrato.prazoSubstituicaoHoras || 48;
        const prazoInicioServico = contrato.prazoInicioServicoHoras || 48;
        heading('CLÁUSULA 6ª — DAS OBRIGAÇÕES DAS PARTES');
        paragraph('São obrigações da CONTRATADA:');
        paragraph(
            `a) arcar com as despesas de manutenção e transporte das máquinas até o local de execução ` +
            `dos serviços, bem como entre os locais onde os serviços serão executados, além de todas as ` +
            `outras despesas inerentes à execução do presente contrato;`
        );
        paragraph(
            `b) responsabilizar-se, direta ou indiretamente, por transportes, encargos sociais, fiscais, ` +
            `trabalhistas, previdenciários e de ordem de classe, indenizações civis e qualquer outra que ` +
            `forem devidas a empregados da CONTRATADA no desempenho dos serviços, ficando a CONTRATANTE ` +
            `isenta de qualquer vínculo empregatício com os mesmos;`
        );
        paragraph(`c) no caso de necessidade de manutenção ou reparos, substituir ou reparar o equipamento no prazo máximo de ${prazoSubstituicao} horas;`);
        paragraph(
            `d) responder por quaisquer danos que venha a causar a terceiros, ficando a CONTRATANTE ` +
            `isenta de qualquer responsabilidade civil, criminal, previdenciária, trabalhista e fiscal, ` +
            `em virtude da presente prestação de serviços;`
        );
        paragraph(`e) iniciar os serviços solicitados em prazo máximo de até ${prazoInicioServico} horas após a autorização;`);
        paragraph(`f) não sublocar ou terceirizar os serviços;`);
        paragraph(`g) manter, durante toda a execução do contrato, as condições de habilitação e qualificação exigidas por lei;`);
        paragraph(
            `h) apresentar, sempre que solicitado pela CONTRATANTE, documentos inerentes ao contrato, em ` +
            `especial certidões negativas e documentos de posse e propriedade das máquinas, além de ` +
            `disponibilizar os equipamentos com operadores qualificados, comprovada a capacidade através ` +
            `de certificados de curso específico para operação de máquinas ou comprovação de tempo de ` +
            `serviço, e, para motoristas, CNH apropriada para a categoria;`
        );
        paragraph(
            `i) arcar com eventuais prejuízos, indenizações e demais responsabilidades causados à ` +
            `CONTRATANTE e/ou a terceiros, provocados por ineficiência, negligência, imperícia, ` +
            `imprudência ou irregularidades cometidas por seus empregados, filiados ou prepostos, na ` +
            `execução dos serviços contratados;`
        );
        paragraph(
            `j) arcar com todos os encargos fiscais, trabalhistas, previdenciários e outros inerentes ao ` +
            `cumprimento do objeto, ficando a CONTRATANTE isenta de qualquer responsabilidade civil, ` +
            `criminal ou trabalhista;`
        );
        paragraph(
            `k) entregar diariamente à CONTRATANTE o relatório das horas efetivamente trabalhadas por ` +
            `cada equipamento, acompanhado de registro fotográfico dos equipamentos em operação no dia, ` +
            `obrigação esta exigível independentemente da forma de contratação; nos casos em que o ` +
            `combustível for fornecido pela CONTRATANTE, a apresentação de tais documentos constitui, ` +
            `ainda, condição indispensável para a liberação do abastecimento;`
        );
        paragraph(
            `l) assumir integral e exclusiva responsabilidade por acidentes de trabalho que envolvam seus ` +
            `empregados, prepostos, operadores ou terceiros por ela contratados, ainda que ocorridos nas ` +
            `dependências, frentes de serviço ou obras da CONTRATANTE, respondendo, com exclusividade, por ` +
            `todas as indenizações e verbas de natureza civil, previdenciária, securitária e trabalhista ` +
            `deles decorrentes;`
        );
        paragraph(
            `m) na qualidade de única e exclusiva empregadora de seus trabalhadores, fornecer e fiscalizar ` +
            `o uso dos equipamentos de proteção individual (EPIs) e observar as Normas Regulamentadoras de ` +
            `segurança e medicina do trabalho aplicáveis, inexistindo entre os empregados da CONTRATADA e a ` +
            `CONTRATANTE qualquer vínculo empregatício, de subordinação, pessoalidade ou responsabilidade ` +
            `solidária ou subsidiária;`
        );
        paragraph(
            `n) manter a CONTRATANTE inteiramente indene de qualquer reclamação, autuação, notificação, ação ` +
            `judicial ou procedimento administrativo promovido por empregados, prepostos ou terceiros da ` +
            `CONTRATADA, ou por órgãos fiscalizadores, obrigando-se a assumir o polo passivo da demanda e a ` +
            `reembolsar a CONTRATANTE, em ação regressiva, de todo e qualquer valor que esta seja compelida ` +
            `a desembolsar, inclusive custas processuais e honorários advocatícios.`
        );
        paragraph('São obrigações da CONTRATANTE:');
        paragraph(`a) efetuar o pagamento dos serviços realizados no prazo estipulado na Cláusula 2ª, mediante nota fiscal devidamente preenchida em seu nome;`);
        paragraph(`b) fiscalizar o perfeito cumprimento do objeto deste contrato, cabendo-lhe, integralmente, o ônus decorrente, independentemente da fiscalização exercida pela CONTRATADA.`);

        // ── Rescisão ─────────────────────────────────────────────────
        const avisoPrevioRescisao = contrato.avisoPrevioRescisaoDias || 2;
        heading('CLÁUSULA 7ª — DA INEXECUÇÃO E DA RESCISÃO CONTRATUAL');
        paragraph(
            `A inexecução total ou parcial do contrato poderá ensejar sua rescisão, com as consequências ` +
            `contratuais e as previstas em lei ou regulamento acordado entre as partes.`
        );
        paragraph(`A CONTRATANTE, mediante comunicação prévia de ${avisoPrevioRescisao} dias, poderá suspender a execução dos serviços a qualquer tempo.`);
        paragraph(
            `Em caso de descumprimento de qualquer cláusula deste contrato, a parte prejudicada poderá ` +
            `rescindi-lo mediante notificação por escrito à outra parte, com antecedência mínima de ` +
            `${avisoPrevioRescisao} dias.`
        );

        // ── Penalidades ──────────────────────────────────────────────
        heading('CLÁUSULA 8ª — DAS PENALIDADES');
        paragraph('Pelo inadimplemento das obrigações, as partes contratantes estarão sujeitas às seguintes penalidades:');
        paragraph('a) advertência;');
        paragraph(`b) multa correspondente a ${fmtNum(contrato.percentualMultaInadimplemento || 0.5)}% do valor do contrato;`);
        paragraph('c) em caso de repetitividade das faltas ou falta mais grave, a penalidade será a rescisão contratual.');

        // ── Alteração ────────────────────────────────────────────────
        heading('CLÁUSULA 9ª — DA ALTERAÇÃO');
        paragraph(`Este contrato poderá ser alterado, porém sempre através de Termo Aditivo, numerado em ordem crescente e assinado por ambas as partes.`);

        // ── Casos omissos ────────────────────────────────────────────
        heading('CLÁUSULA 10ª — DOS CASOS OMISSOS');
        paragraph(`As hipóteses contratuais não previstas neste instrumento serão regidas pelo Código Civil Brasileiro, especialmente os artigos 593 a 609.`);

        // ── Condições gerais ─────────────────────────────────────────
        heading('CLÁUSULA 11ª — DAS CONDIÇÕES GERAIS');
        paragraph(
            `O presente contrato é obrigatório para as partes, seus herdeiros e sucessores, sendo suas ` +
            `obrigações exigíveis nas formas convencionadas, independentemente de interpelação ou ` +
            `notificação pessoal ou judicial.`
        );
        paragraph(
            `As disposições deste contrato prevalecem sobre quaisquer outros acordos anteriores entre as ` +
            `partes, verbais ou escritos, reconhecendo-o como título executivo extrajudicial, conforme ` +
            `disposição dos artigos 783 e 784, III, do Código de Processo Civil, sendo celebrado com ` +
            `fulcro no artigo 840 e seguintes do Código Civil, pelo que anuem e ratificam todas as ` +
            `estipulações do instrumento ora firmado.`
        );
        paragraph(
            `As partes firmam o presente instrumento em condição de igualdade, centrando as tratativas ` +
            `nos princípios da probidade e boa-fé, na forma do artigo 422 do Código Civil, não podendo ` +
            `assim, qualquer delas, alegar ignorância, vício, dolo, coação ou má-fé com o intuito de ver ` +
            `contaminada a relação contratual, eis que não se trata de contrato de adesão, mas sim, ` +
            `disposição mútua.`
        );
        paragraph(
            `Caso alguma cláusula, condição ou ajuste previsto neste instrumento tenha sua nulidade, ` +
            `anulabilidade ou invalidade reconhecida em razão de qualquer ato, tal circunstância não ` +
            `invalidará o contrato de um modo geral, mas tão somente aquela situação pontual.`
        );

        // ── Foro ─────────────────────────────────────────────────────
        heading('CLÁUSULA 12ª — DO FORO');
        paragraph(`Para dirimir as dúvidas emergentes do presente contrato, as partes de comum acordo elegem o Foro da Comarca de ${contrato.foroComarca || 'Santa Maria'}, RS.`);

        // ── Assinaturas ──────────────────────────────────────────────
        paragraph(
            `E por estarem assim justos e contratados, as partes firmam o presente instrumento, lavrado ` +
            `em duas vias de igual teor e forma, na presença de duas testemunhas, dando fiel cumprimento ` +
            `ao estabelecido.`
        );
        doc.moveDown(1);
        const sigY = Math.min(doc.y, doc.page.height - 190);
        doc.y = sigY;
        doc.font('Helvetica').fontSize(10)
            .text(`${contrato.foroComarca || 'Santa Maria'}, RS, ${fmtDateExtenso(new Date())}.`, margin, doc.y, { width: contentWidth });
        doc.moveDown(3);

        const colW = (contentWidth - 30) / 2;
        const lineY = doc.y;
        doc.moveTo(margin, lineY).lineTo(margin + colW, lineY).stroke('#000');
        doc.moveTo(margin + colW + 30, lineY).lineTo(pageWidth - margin, lineY).stroke('#000');
        doc.font('Helvetica-Bold').fontSize(9)
            .text(`CONTRATADA — ${normalizeSufixoSocietario(sanitizeText(locador.razaoSocial || locador.nome)) || ''}`, margin, lineY + 4, { width: colW, align: 'center' });
        doc.text('CONTRATANTE — MAK Serviços e Pavimentações Ltda', margin + colW + 30, lineY + 4, { width: colW, align: 'center' });

        doc.moveDown(4);
        const witY = doc.y;
        doc.font('Helvetica').fontSize(9).text('Testemunhas:', margin, witY);
        doc.moveDown(2);
        const witLineY = doc.y;
        doc.moveTo(margin, witLineY).lineTo(margin + colW, witLineY).stroke('#000');
        doc.moveTo(margin + colW + 30, witLineY).lineTo(pageWidth - margin, witLineY).stroke('#000');

        doc.end();
    });
};

module.exports = { generateContratoPdf };
