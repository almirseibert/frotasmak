// services/contratoPdfCommon.js
// Peças compartilhadas entre o PDF do contrato (contratoPdfGenerator.js) e o do
// termo aditivo (aditivoPdfGenerator.js): logo, formatadores, máscaras e — o que
// mais importa — a QUALIFICAÇÃO DAS PARTES. O preâmbulo do aditivo tem que casar
// palavra por palavra com o do contrato que ele altera; por isso mora aqui e não
// duplicado nos dois arquivos.

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
// 'YYYY-MM-DD' é parseado como UTC pelo Date, e em UTC-3 isso recua um dia na
// exibição. Datas vindas do MySQL chegam como Date (pool em -03:00) e não têm o
// problema; strings ISO só de data (payload da API, seed, teste) tinham. Trata as
// duas formas como data local.
const parseDataLocal = (d) => {
    if (d instanceof Date) return d;
    const m = typeof d === 'string' && d.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z?)?$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(d);
};

const fmtDate = (d) => {
    if (!d) return '____/____/______';
    try {
        const date = parseDataLocal(d);
        if (isNaN(date.getTime())) return '____/____/______';
        return date.toLocaleDateString('pt-BR');
    } catch { return '____/____/______'; }
};

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// Data por extenso para o fecho ("17 de julho de 2026").
const fmtDateExtenso = (d) => {
    try {
        const date = d ? parseDataLocal(d) : new Date();
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

// Monta a qualificação das partes (CONTRATANTE MAK + CONTRATADA/locador) usada no
// preâmbulo do contrato e do termo aditivo. Devolve os pedaços já resolvidos para
// quem precisa deles soltos (nome da contratada nas assinaturas, por exemplo).
const qualificacaoPartes = ({ contrato = {}, locador = {} } = {}) => {
    const locadorNome = normalizeSufixoSocietario(sanitizeText(locador.razaoSocial || locador.nome)) || '___________________________';
    const locadorTelefone = sanitizeText(locador.telefone);

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
    const locadorCep = sanitizeText(locador.cep);
    const enderecoPartes = [
        sanitizeText(locador.endereco),
        sanitizeText(locador.bairro),
        sanitizeText(locador.cidade),
        locadorCep ? `CEP ${String(locadorCep).replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') || locadorCep}` : null,
    ].filter(Boolean);
    const contratadaEnderecoTexto = enderecoPartes.length
        ? `, ${isPF ? 'residente e domiciliada em' : 'com sede na'} ${enderecoPartes.join(', ')}`
        : '';

    const contratante =
        `MAK SERVIÇOS E PAVIMENTAÇÕES LTDA, pessoa jurídica de direito privado, com sede na ` +
        `Rodovia BR-392, nº 3639, Bairro Tomazetti, Santa Maria/RS, inscrita no CNPJ sob nº ` +
        `13.137.265/0001-88, neste ato representada por ${MAK_REPRESENTANTE.nome}, ` +
        `${MAK_REPRESENTANTE.nacionalidade}, ${MAK_REPRESENTANTE.profissao}, inscrito no CPF sob nº ` +
        `${MAK_REPRESENTANTE.cpf}, doravante denominada simplesmente CONTRATANTE`;
    const contratada =
        `${locadorNome}${locadorQualif}${contratadaEnderecoTexto}` +
        `${locadorTelefone ? `, telefone ${locadorTelefone}` : ''}${contratadaRepTexto}, ` +
        `doravante denominada simplesmente CONTRATADA`;

    return { locadorNome, isPF, contratante, contratada };
};

module.exports = {
    ensureLogo,
    fmtBRL, fmtNum, fmtHoras, fmtDate, fmtDateExtenso,
    NUM_EXTENSO, mesesExtenso,
    maskCNPJ, maskCPF,
    normalizeSufixoSocietario, sanitizeText,
    MAK_REPRESENTANTE,
    qualificacaoPartes,
};
