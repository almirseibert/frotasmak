// backend/services/evidenciaCarimboService.js
// -----------------------------------------------------------------------------
// Render do carimbo — Evidências de Campo, Fase 2 (§5) + Fase 10.
// NÃO-DESTRUTIVO: o original nunca é tocado. As variantes são geradas sob demanda
// e cacheadas por stamp_version em cache/<registroId>/<variante>_v<versao>.jpg.
//   thumb   (400px)  — gerada na hora do ingest e a cada edição de carimbo
//   stamped (1600px) — preguiçosa, com mapa de promessas em voo (§5.1)
//   clean            — original só com .rotate(), EXIF removido (§5.5)
// A fonte no carimbo é DejaVu (mono na 1ª linha), instalada no contêiner via
// fontconfig+ttf-dejavu (§5.6) — provado na Fase 0.
//
// Fase 10: o carimbo perdeu a tarja (retângulo escuro + barra marrom lateral).
// O texto agora é branco com CONTORNO PRETO, legível sobre qualquer fundo.
// -----------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { SUBDIRS, resolverCaminho, relativizar } = require('../utils/evidenciaRegras');

// Revisão do DESENHO do carimbo. Incrementar sempre que montarSvgTexto mudar:
// entra no nome do arquivo em cache e força o re-render das variantes 'stamped'
// já geradas. NÃO usar stamp_version para isso — ela entra no HMAC das URLs
// (evidenciaRegras.js:104-106) e bumpá-la invalidaria toda URL assinada em voo.
const STAMP_RENDER_REV = 2;

const emVoo = new Map(); // chave absoluta -> Promise, para não renderizar 2x

const escaparXml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Só 'stamped' carrega a revisão de render: thumb e clean não mudaram de desenho,
// e a thumb em cache é a ÚLTIMA CÓPIA DE PIXELS de um registro arquivado
// (evidenciaOffloadService.purgarVariantes preserva thumb* de propósito).
const caminhoVariante = (registroId, variante, versao) =>
    path.join(SUBDIRS.cache, String(registroId),
        variante === 'stamped'
            ? `stamped_v${versao}_r${STAMP_RENDER_REV}.jpg`
            : `${variante}_v${versao}.jpg`);

// ---- Texto do carimbo (sem tarja) ----------------------------------------------
// `linhas` é um array de strings já resolvidas (valores efetivos COALESCE(ov,dev)).
//
// Cada linha é desenhada DUAS VEZES: uma cópia preta preenchida e contornada por
// baixo, a branca por cima. Poderia ser uma passada só com paint-order="stroke
// fill" (SVG 2), mas se o librsvg do contêiner ignorasse a propriedade o stroke
// pintaria SOBRE o fill e o texto viraria um borrão preto ilegível — falha
// silenciosa que só apareceria numa foto já entregue ao cliente. A dupla passada
// usa só primitivas SVG 1.1.
const ENTRELINHA = 1.35;  // bold + contorno precisa de mais respiro que texto fino
const PAD_RODAPE = 1.0;   // em múltiplos de fs0 — inclui folga p/ os descendentes

function montarSvgTexto(width, height, linhas) {
    const area = Math.round(height * 0.22);   // mesma região de layout de antes
    // Tamanho por ALTURA: as N linhas mais o respiro do rodapé cabem na área.
    const fsAltura = Math.max(14, Math.floor(area / (linhas.length * ENTRELINHA + PAD_RODAPE)));
    // ...e por LARGURA (a linha mais longa não pode transbordar). Avanço médio de
    // ~0.62em cobre o mono da 1ª linha e o proporcional das demais.
    const padX = Math.round(fsAltura * 0.8);
    const maisLonga = Math.max(1, ...linhas.map(l => String(l).length));
    const fsLargura = Math.floor((width - padX * 2) / (maisLonga * 0.62));
    const fs0 = Math.max(12, Math.min(fsAltura, fsLargura));
    const sw = Math.max(2, Math.round(fs0 * 0.14)); // espessura do contorno
    // Ancora pelo RODAPÉ e empilha para cima: sem a tarja, o que precisa ficar
    // estável é a distância até a borda de baixo, não o topo do bloco.
    const yUltima = height - Math.round(fs0 * PAD_RODAPE);

    const corpo = linhas.map((txt, i) => {
        const y = yUltima - Math.round((linhas.length - 1 - i) * fs0 * ENTRELINHA);
        const fonte = i === 0 ? 'DejaVu Sans Mono' : 'DejaVu Sans';
        const t = escaparXml(txt);
        // bold em TODAS as linhas: glifo fino não sustenta contorno.
        const comuns = `x="${padX}" y="${y}" font-family="${fonte}" font-size="${fs0}"`
            + ` font-weight="bold" xml:space="preserve"`;
        return `<text ${comuns} fill="#000000" stroke="#000000" stroke-width="${sw}"`
            + ` stroke-linejoin="round" stroke-linecap="round">${t}</text>`
            + `<text ${comuns} fill="#ffffff">${t}</text>`;
    }).join('');

    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${corpo}</svg>`
    );
}

// Monta as linhas do carimbo a partir dos valores efetivos do registro + regra.
// `campos` (config nos 3 níveis) pode ocultar linhas; coordenada é SEMPRE impressa.
// `reduzido` (anexo retroativo, Fase 10): só a imagem e o aviso de que a foto foi
// alocada depois. Precisa de um branch próprio justamente porque a coordenada é
// incondicional abaixo — sem ele sairia "?, ?".
function montarLinhas(dados, campos = {}, { reduzido = false } = {}) {
    if (reduzido) {
        const linhas = [`Anexada posteriormente · referente a ${dados.dataRefBr || '-'}`];
        if (dados.codigo) linhas.push(dados.codigo);
        return linhas;
    }
    const mostra = (chave) => campos[chave] !== false; // default: mostra tudo
    const linhas = [];
    // Linha 1 (mono, negrito): data/hora + fuso
    if (mostra('data_hora')) linhas.push(`${dados.dataHora || ''} (GMT-3)`);
    // Coordenada — NÃO configurável, sempre presente
    const coord = [dados.latitude, dados.longitude]
        .map(v => (v == null ? '?' : Number(v).toFixed(6))).join(', ');
    const prec = dados.precisao_m != null ? ` · ±${dados.precisao_m} m` : '';
    linhas.push(`${coord}${mostra('precisao') ? prec : ''}`);
    if (mostra('obra')) {
        const dist = dados.distancia_obra_m != null ? ` · ${dados.distancia_obra_m} m do centro` : '';
        linhas.push(`Obra: ${dados.obra || '-'}${dist}`);
    }
    if (mostra('equipamento')) linhas.push(`Equipamento: ${dados.equipamento || '-'}`);
    const rodape = [];
    if (mostra('operador') && dados.operador) rodape.push(`Operador: ${dados.operador}`);
    if (mostra('horimetro') && dados.leitura) rodape.push(dados.leitura);
    if (dados.codigo) rodape.push(dados.codigo);
    if (dados.momentoLabel) rodape.push(dados.momentoLabel);
    if (rodape.length) linhas.push(rodape.join(' · '));
    if (mostra('linha_livre') && dados.linha_livre) linhas.push(dados.linha_livre);
    return linhas.slice(0, 6);
}

async function _renderStamped(origAbs, destAbs, dados, campos, opts = {}) {
    const img = sharp(origAbs).rotate(); // aplica EXIF orientation (§5.5)
    const meta = await img.metadata();
    const largura = Math.min(meta.width || 1600, 1600);
    const base = await img.resize({ width: largura, withoutEnlargement: true }).toBuffer();
    const b = sharp(base);
    const m2 = await b.metadata();
    const svg = montarSvgTexto(m2.width, m2.height, montarLinhas(dados, campos, opts));
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    await sharp(base)
        .composite([{ input: svg, top: 0, left: 0 }])
        .jpeg({ quality: 82 })
        .toFile(destAbs);
    return destAbs;
}

async function _renderClean(origAbs, destAbs) {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    // .rotate() sem argumento aplica a tag EXIF; não copiar metadados = sem GPS no
    // arquivo entregue (§5.5 — "sem geolocalização" tem que ser sem EXIF também).
    await sharp(origAbs).rotate().jpeg({ quality: 88 }).toFile(destAbs);
    return destAbs;
}

async function _renderThumb(origAbs, destAbs) {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    await sharp(origAbs).rotate().resize(400).jpeg({ quality: 72 }).toFile(destAbs);
    return destAbs;
}

// Gera (se preciso) e devolve o caminho ABSOLUTO da variante pedida.
async function obterVariante(registro, variante) {
    const { id, arquivo_rel, stamp_version } = registro;
    const versao = stamp_version || 1;
    const destAbs = caminhoVariante(id, variante, versao);

    if (fs.existsSync(destAbs)) return destAbs;
    if (emVoo.has(destAbs)) return emVoo.get(destAbs);

    const origAbs = resolverCaminho(arquivo_rel);
    if (!origAbs || !fs.existsSync(origAbs)) {
        throw Object.assign(new Error('Arquivo original ausente'), { code: 'ORIG_AUSENTE' });
    }

    const p = (async () => {
        if (variante === 'clean') return _renderClean(origAbs, destAbs);
        if (variante === 'thumb') return _renderThumb(origAbs, destAbs);
        // Carimbo removido pelo admin (§5.2): a variante 'stamped' vira limpa.
        if (registro.stamp_mode === 'limpo') return _renderClean(origAbs, destAbs);
        // Anexo retroativo (Fase 10): carimbo reduzido, sem GPS nem dados de campo.
        const reduzido = registro.stamp_mode === 'reduzido';
        return _renderStamped(origAbs, destAbs, registro._dados || {}, registro._campos || {}, { reduzido });
    })().finally(() => emVoo.delete(destAbs));

    emVoo.set(destAbs, p);
    return p;
}

// Chamado no ingest e a cada edição de carimbo: (re)gera a thumb já.
async function gerarThumbIngest(registro) {
    const destAbs = caminhoVariante(registro.id, 'thumb', registro.stamp_version || 1);
    const origAbs = resolverCaminho(registro.arquivo_rel);
    if (!origAbs) return null;
    await _renderThumb(origAbs, destAbs);
    return relativizar(destAbs);
}

// Apaga o cache de variantes de um registro (ao editar carimbo / offload).
function limparCache(registroId) {
    const dir = path.join(SUBDIRS.cache, String(registroId));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Varre o cache apagando variantes 'stamped' de revisões de render antigas.
// NUNCA toca em thumb*/clean*: para um registro arquivado a thumb é a última
// cópia de pixels no servidor (purgarVariantes preserva). Idempotente.
function varrerStampedAntigos() {
    let apagados = 0;
    let dirs = [];
    try { dirs = fs.readdirSync(SUBDIRS.cache); } catch { return { apagados: 0 }; }
    for (const dir of dirs) {
        const abs = path.join(SUBDIRS.cache, dir);
        let arquivos = [];
        try { arquivos = fs.readdirSync(abs); } catch { continue; }
        for (const f of arquivos) {
            if (!f.startsWith('stamped_')) continue;               // nunca thumb/clean
            if (f.endsWith(`_r${STAMP_RENDER_REV}.jpg`)) continue; // já é da revisão atual
            try { fs.unlinkSync(path.join(abs, f)); apagados++; } catch { /* */ }
        }
    }
    return { apagados };
}

module.exports = {
    obterVariante, gerarThumbIngest, limparCache, caminhoVariante,
    montarLinhas, montarSvgTexto, // exportados para o dossiê/preview reutilizarem
    varrerStampedAntigos, STAMP_RENDER_REV,
};
