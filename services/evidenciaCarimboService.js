// backend/services/evidenciaCarimboService.js
// -----------------------------------------------------------------------------
// Render do carimbo — Evidências de Campo, Fase 2 (§5).
// NÃO-DESTRUTIVO: o original nunca é tocado. As variantes são geradas sob demanda
// e cacheadas por stamp_version em cache/<registroId>/<variante>_v<versao>.jpg.
//   thumb   (400px)  — gerada na hora do ingest e a cada edição de carimbo
//   stamped (1600px) — preguiçosa, com mapa de promessas em voo (§5.1)
//   clean            — original só com .rotate(), EXIF removido (§5.5)
// A fonte no carimbo é DejaVu (mono na tarja), instalada no contêiner via
// fontconfig+ttf-dejavu (§5.6) — provado na Fase 0.
// -----------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { SUBDIRS, resolverCaminho, relativizar } = require('../utils/evidenciaRegras');

const emVoo = new Map(); // chave absoluta -> Promise, para não renderizar 2x

const escaparXml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const caminhoVariante = (registroId, variante, versao) =>
    path.join(SUBDIRS.cache, String(registroId), `${variante}_v${versao}.jpg`);

// ---- Faixa SVG do carimbo ------------------------------------------------------
// `linhas` é um array de strings já resolvidas (valores efetivos COALESCE(ov,dev)).
function montarSvgFaixa(width, height, linhas) {
    const faixa = Math.round(height * 0.22);
    const y0 = height - faixa;
    // Tamanho por ALTURA (cabe as N linhas na tarja)...
    const fsAltura = Math.max(14, Math.round(faixa / (linhas.length + 1.5)));
    // ...e por LARGURA (a linha mais longa não pode transbordar). Avanço médio de
    // ~0.62em cobre o mono da 1ª linha e o proporcional das demais.
    const padX = Math.round(fsAltura * 0.8);
    const maisLonga = Math.max(1, ...linhas.map(l => String(l).length));
    const fsLargura = Math.floor((width - padX * 2) / (maisLonga * 0.62));
    const fs0 = Math.max(12, Math.min(fsAltura, fsLargura));
    const linhasSvg = linhas.map((txt, i) => {
        const y = y0 + Math.round(fs0 * (i + 1.15));
        const fonte = i === 0 ? 'DejaVu Sans Mono' : 'DejaVu Sans';
        const cor = i === linhas.length - 1 ? '#e9d9bf' : '#ffffff';
        return `<text x="${padX}" y="${y}" font-family="${fonte}" font-size="${fs0}" font-weight="${i === 0 ? 'bold' : 'normal'}" fill="${cor}">${escaparXml(txt)}</text>`;
    }).join('');
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
           <rect x="0" y="${y0}" width="${width}" height="${faixa}" fill="rgba(28,26,23,0.80)"/>
           <rect x="0" y="${y0}" width="${Math.max(6, Math.round(width * 0.008))}" height="${faixa}" fill="#9E7A42"/>
           ${linhasSvg}
         </svg>`
    );
}

// Monta as linhas do carimbo a partir dos valores efetivos do registro + regra.
// `campos` (config nos 3 níveis) pode ocultar linhas; coordenada é SEMPRE impressa.
function montarLinhas(dados, campos = {}) {
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

async function _renderStamped(origAbs, destAbs, dados, campos) {
    const img = sharp(origAbs).rotate(); // aplica EXIF orientation (§5.5)
    const meta = await img.metadata();
    const largura = Math.min(meta.width || 1600, 1600);
    const base = await img.resize({ width: largura, withoutEnlargement: true }).toBuffer();
    const b = sharp(base);
    const m2 = await b.metadata();
    const svg = montarSvgFaixa(m2.width, m2.height, montarLinhas(dados, campos));
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
// `carregarDados(id)` é uma função que devolve { origRel, versao, dados, campos }.
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
        return _renderStamped(origAbs, destAbs, registro._dados || {}, registro._campos || {});
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

module.exports = {
    obterVariante, gerarThumbIngest, limparCache, caminhoVariante,
    montarLinhas, // exportado para o dossiê/preview reutilizar
};
