// backend/services/pontoEspelhoParser.js
//
// =============================================================================
// LEITURA DIRETA DO ESPELHO DE PONTO (PDF COM TEXTO) — SEM IA
// =============================================================================
//
// O espelho sai sempre do mesmo sistema de ponto, no mesmo layout. Quando o PDF é
// o ORIGINAL (baixado do sistema, com texto selecionável), dá para ler as
// marcações direto das posições do texto, sem modelo nenhum.
//
// PDF "impresso" (Print to PDF / Ghostscript) NÃO serve aqui: nele cada letra é
// um desenho vetorial e não existe texto para extrair. Esse caso devolve
// SEM_TEXTO e quem chama decide o que fazer (hoje: leitura por IA, de reserva).
//
// Como o layout é lido:
//   • linhas  = trechos de texto agrupados pela coordenada y;
//   • colunas = posição x dos rótulos do cabeçalho da tabela ("H.R.",
//     "Marcações", "H. Ref", "H. Normais"…). Nada de x fixo no código: se o
//     sistema mudar margens ou escala, os rótulos continuam servindo de régua;
//   • um arquivo pode trazer VÁRIOS funcionários (cada "Funcionário:" novo abre
//     outro espelho).
//
// Este módulo só transcreve. A conferência (soma das marcações × "H. Normais")
// é feita por quem chama, em pontoEspelhoService.montarDias.

// Carregado sob demanda: ao ser importado no Node o pdf.js avisa no console que
// não achou o módulo `canvas`. Ele só serve para DESENHAR páginas; aqui só se lê
// texto, então o aviso é ruído e fica fora do log.
let pdfjsLib = null;
const getPdfjs = () => {
    if (!pdfjsLib) {
        const logOriginal = console.log;
        console.log = () => {};
        try {
            pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        } finally {
            console.log = logOriginal;
        }
    }
    return pdfjsLib;
};

const TOL_Y = 2.5; // pt — trechos com y a até isso de distância são a mesma linha

const RE_DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})/;
const RE_HORA_G = /(\d{1,2}:\d{2})\s*[*^]?/g;
const RE_HORA = /^\d{1,2}:\d{2}$/;

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const iso = (d, m, a) => `${a}-${m}-${d}`;

// ─── Extração: páginas → linhas → trechos com posição ────────────────────────

/**
 * @returns {Promise<Array<Array<{ y: number, itens: Array<{x0,x1,str}> }>>>}
 *          páginas, cada uma com as linhas de cima para baixo.
 */
const extrairPaginas = async (buffer) => {
    const doc = await getPdfjs().getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: false,
        disableFontFace: true,
        isEvalSupported: false,
        verbosity: 0,
    }).promise;

    const paginas = [];
    try {
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const conteudo = await page.getTextContent();
            const itens = conteudo.items
                .filter(it => it.str && it.str.trim())
                .map(it => ({
                    x0: it.transform[4],
                    x1: it.transform[4] + (it.width || 0),
                    y: it.transform[5],
                    str: it.str.trim(),
                }))
                .sort((a, b) => b.y - a.y || a.x0 - b.x0);

            const linhas = [];
            for (const it of itens) {
                const ultima = linhas[linhas.length - 1];
                if (ultima && Math.abs(ultima.y - it.y) <= TOL_Y) ultima.itens.push(it);
                else linhas.push({ y: it.y, itens: [it] });
            }
            linhas.forEach(l => l.itens.sort((a, b) => a.x0 - b.x0));
            paginas.push(linhas);
        }
    } finally {
        await doc.destroy();
    }
    return paginas;
};

const textoDe = (itens) => itens.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();

// ─── Cabeçalho da tabela: a régua das colunas ────────────────────────────────

const ehCabecalhoTabela = (linha) => {
    const t = semAcento(textoDe(linha.itens)).toLowerCase();
    return t.includes('marcac') && t.includes('normais');
};

const montarColunas = (linha) => {
    const acha = (re) => linha.itens.find(i => re.test(semAcento(i.str).toLowerCase())) || null;
    const marc = acha(/marcac/);
    const ref = acha(/h\.?\s*ref/);
    const normais = acha(/normais/);
    const hr = acha(/^h\.?\s*r\.?$/);
    if (!marc || !normais) return null;

    // Rótulos à direita de "Marcações": cada horário dessa área pertence à
    // coluna do rótulo mais próximo (os valores ficam centralizados no rótulo).
    const totais = linha.itens
        .filter(i => i.x0 > marc.x1)
        .map(i => ({ centro: (i.x0 + i.x1) / 2, normais: i === normais }));

    // Onde acaba a coluna Marcações: um pouco antes do 1º rótulo à direita.
    const primeiro = ref || linha.itens.filter(i => i.x0 > marc.x1).sort((a, b) => a.x0 - b.x0)[0];
    const fimMarc = primeiro.x0 - (primeiro.x1 - primeiro.x0) * 0.25;

    return { inicioMarc: hr ? hr.x1 : null, fimMarc, totais };
};

// ─── Linhas de dia ───────────────────────────────────────────────────────────

/** Separa os trechos de uma linha de dia nas áreas da tabela. */
const lerLinhaDia = (linha, colunas) => {
    const m = RE_DATA_BR.exec(linha.itens[0].str);
    const data = iso(m[1], m[2], m[3]);

    // À esquerda das marcações ficam a data, o dia da semana e o código H.R.
    let marc;
    if (colunas.inicioMarc != null) {
        marc = linha.itens.filter(i => i.x0 > colunas.inicioMarc && i.x0 < colunas.fimMarc);
    } else {
        // Sem o rótulo "H.R." para servir de régua: tira data, dia da semana e código.
        marc = linha.itens.filter(i => i.x0 < colunas.fimMarc).filter((i, idx) => idx > 0
            && !/^(SEG|TER|QUA|QUI|SEX|S[ÁA]B|DOM)$/i.test(i.str)
            && !(idx <= 2 && /^\d{2}$/.test(i.str)));
    }

    // "H. Normais": horário à direita cujo rótulo mais próximo é o de normais.
    let horasNormais = null;
    for (const i of linha.itens.filter(x => x.x0 >= colunas.fimMarc && RE_HORA.test(x.str))) {
        const c = (i.x0 + i.x1) / 2;
        const perto = colunas.totais.reduce((a, b) => (Math.abs(b.centro - c) < Math.abs(a.centro - c) ? b : a));
        if (perto.normais) horasNormais = i.str;
    }

    return { y: linha.y, data, textoMarc: textoDe(marc), horasNormais };
};

/** "13:01 17:23* (Independência do Brasil )" → marcações + observação. */
const separarMarcacoes = (texto) => {
    const marcacoes = [];
    let m;
    RE_HORA_G.lastIndex = 0;
    while ((m = RE_HORA_G.exec(texto)) !== null) marcacoes.push(m[1].padStart(5, '0'));
    const observacao = texto
        .replace(RE_HORA_G, ' ')
        .replace(/[()*^]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return { marcacoes, observacao: observacao || null };
};

// ─── Parser ──────────────────────────────────────────────────────────────────

const novoEspelho = () => ({
    funcionario_nome: null, funcionario_matricula: null, funcionario_cpf: null,
    periodo_inicio: null, periodo_fim: null, linhasDia: [], orfas: [],
});

/**
 * Lê o PDF e devolve os espelhos encontrados. Nunca lança.
 * @returns {Promise<{ ok: true, espelhos: object[] } | { ok: false, erro: string, detalhe: string }>}
 */
const parseEspelhoPdf = async (buffer) => {
    let paginas;
    try {
        paginas = await extrairPaginas(buffer);
    } catch (e) {
        return { ok: false, erro: 'PDF_INVALIDO', detalhe: `Não foi possível abrir o PDF (${e.message}).` };
    }
    if (!paginas.some(p => p.length)) {
        return { ok: false, erro: 'SEM_TEXTO', detalhe: 'O PDF não tem texto selecionável (foi impresso/digitalizado).' };
    }

    const espelhos = [];
    let atual = null;
    let colunas = null;
    let naTabela = false;
    // y cresce para cima e recomeça a cada página: soma um deslocamento por página
    // para que as distâncias entre linhas continuem comparáveis.
    let base = 0;

    for (const linhas of paginas) {
        for (const linha of linhas) {
            const texto = textoDe(linha.itens);
            const plano = semAcento(texto);
            const y = base - linha.y;

            const func = /Funcionario:\s*(\d+)\s*-\s*(.+?)(?:\s+CPF:|$)/i.exec(plano);
            if (func) {
                // Mesmo funcionário de novo = página de continuação do mesmo espelho.
                if (!atual || (atual.funcionario_matricula && atual.funcionario_matricula !== func[1])) {
                    atual = novoEspelho();
                    espelhos.push(atual);
                }
                atual.funcionario_matricula = func[1];
                // O nome sai do texto original (com acento), na mesma posição.
                const orig = /Funcion[áa]rio:\s*\d+\s*-\s*(.+?)(?:\s+CPF:|$)/i.exec(texto);
                atual.funcionario_nome = (orig ? orig[1] : func[2]).trim();
                naTabela = false;
            }
            const cpf = /CPF:\s*([\d.\-]{11,14})/i.exec(plano);
            if (cpf && atual && !atual.funcionario_cpf) atual.funcionario_cpf = cpf[1].replace(/\D/g, '');

            if (!naTabela) {
                const per = /(\d{2})\/(\d{2})\/(\d{4})\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(plano);
                if (per) {
                    // O período vem ANTES de "Funcionário:" na página: abre o espelho já aqui.
                    if (!atual || atual.linhasDia.length) { atual = novoEspelho(); espelhos.push(atual); }
                    if (!atual.periodo_inicio) {
                        atual.periodo_inicio = iso(per[1], per[2], per[3]);
                        atual.periodo_fim = iso(per[4], per[5], per[6]);
                    }
                    continue;
                }
            }

            if (ehCabecalhoTabela(linha)) {
                const c = montarColunas(linha);
                if (c) { colunas = c; naTabela = true; }
                continue;
            }
            if (!naTabela || !atual || !colunas) continue;

            if (/^Totais\b/i.test(plano)) { naTabela = false; continue; }

            if (RE_DATA_BR.test(linha.itens[0].str)) {
                atual.linhasDia.push({ ...lerLinhaDia(linha, colunas), y });
            } else if (linha.itens.every(i => i.x0 < colunas.fimMarc)) {
                // Texto da coluna Marcações que quebrou em mais de uma linha: fica
                // acima/abaixo da linha da data (as outras células são centralizadas).
                atual.orfas.push({ y, texto });
            }
        }
        base += 10000;
    }

    const resultado = [];
    for (const e of espelhos) {
        if (!e.linhasDia.length) continue;

        // Passo entre linhas normais da tabela (mediana): régua para saber de
        // qual dia é um texto quebrado.
        const ys = e.linhasDia.map(l => l.y).sort((a, b) => a - b);
        const difs = ys.slice(1).map((v, i) => v - ys[i]).filter(d => d > 0 && d < 5000).sort((a, b) => a - b);
        const passo = difs.length ? difs[Math.floor(difs.length / 2)] : 12;

        for (const o of e.orfas) {
            const perto = e.linhasDia.reduce((a, b) => (Math.abs(b.y - o.y) < Math.abs(a.y - o.y) ? b : a));
            if (Math.abs(perto.y - o.y) > passo * 0.9) continue;
            (o.y < perto.y ? (perto.antes = perto.antes || []) : (perto.depois = perto.depois || [])).push(o);
        }

        const dias = e.linhasDia.map(l => {
            const partes = [
                ...(l.antes || []).sort((a, b) => a.y - b.y).map(o => o.texto),
                l.textoMarc,
                ...(l.depois || []).sort((a, b) => a.y - b.y).map(o => o.texto),
            ].filter(Boolean).join(' ');
            const { marcacoes, observacao } = separarMarcacoes(partes);
            return { data: l.data, marcacoes, observacao, horas_normais: l.horasNormais, duvidoso: false };
        });

        resultado.push({
            funcionario_nome: e.funcionario_nome,
            funcionario_matricula: e.funcionario_matricula,
            funcionario_cpf: e.funcionario_cpf,
            periodo_inicio: e.periodo_inicio,
            periodo_fim: e.periodo_fim,
            dias,
        });
    }

    if (!resultado.length) {
        return { ok: false, erro: 'LAYOUT_NAO_RECONHECIDO', detalhe: 'O PDF tem texto, mas não no layout do espelho de ponto.' };
    }
    return { ok: true, espelhos: resultado };
};

module.exports = { parseEspelhoPdf };
