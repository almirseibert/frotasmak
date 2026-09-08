'use strict';
/* =============================================================================
 * Spike de risco — Evidências de Campo (Fase 0). DESCARTÁVEL.
 *
 * Roda dentro do contêiner alpine e responde, com PASS/FAIL automático, às
 * perguntas que o plano (§12, fase 0) diz que precisam ser respondidas antes de
 * escrever qualquer linha do módulo. Sai com código != 0 se algum teste DURO
 * falhar, para poder ser usado em CI.
 *
 * Testes duros (falham o processo):  1 sharp · 2 acento · 4 vazão · 5 fuso
 * Teste informativo (nunca falha):   3 HEIF/HEIC (decide Plano A vs Plano B)
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) {}

const results = [];
function record(nome, ok, detalhe, { hard = true } = {}) {
    results.push({ nome, ok, detalhe, hard });
    const tag = ok ? '\x1b[32mPASS\x1b[0m' : (hard ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mINFO\x1b[0m');
    console.log(`  [${tag}] ${nome}\n         ${detalhe}`);
}

async function main() {
    console.log('\n=== SPIKE EVIDÊNCIAS DE CAMPO — Fase 0 ===\n');

    // ---------------------------------------------------------------------
    // Teste 1 — require('sharp') carrega no alpine
    // ---------------------------------------------------------------------
    let sharp;
    try {
        sharp = require('sharp');
        const v = sharp.versions || {};
        record('1. require("sharp") no alpine',
            true,
            `sharp ${v.sharp || '?'} · libvips ${v.vips || '?'}`);
    } catch (err) {
        record('1. require("sharp") no alpine', false, String(err && err.message));
        return finalize(); // sem sharp, nada mais roda
    }

    // ---------------------------------------------------------------------
    // Teste 3 (rodado cedo, é só leitura de capacidade) — suporte a HEIF/HEIC
    // Determina Plano A (decodifica HEIC no servidor) vs Plano B (no cliente).
    // ---------------------------------------------------------------------
    const heif = (sharp.format && sharp.format.heif) || {};
    const heifIn = !!(heif.input && heif.input.buffer);
    record('3. Suporte a HEIF/HEIC de entrada (informativo)',
        heifIn,
        heifIn
            ? 'sharp DECODIFICA HEIC → Plano A: transcodificar no servidor funciona.'
            : 'sharp NÃO decodifica HEIC (binário pré-compilado sem libheif). '
              + 'Use Plano B: decodificar no cliente (heic2any) antes de enfileirar, '
              + 'ou o bloco comentado do Dockerfile.spike.',
        { hard: false });

    // ---------------------------------------------------------------------
    // Teste 2 — acento renderiza no SVG (fontconfig + fonte)
    // Estratégia: desenhar texto branco acentuado sobre banda escura e contar
    // pixels claros. Sem fonte, o librsvg não desenha nada → contagem ~0.
    // ---------------------------------------------------------------------
    try {
        const W = 900, H = 240;
        const svg = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
               <rect width="100%" height="100%" fill="#1c1a17"/>
               <rect x="0" y="0" width="8" height="${H}" fill="#9E7A42"/>
               <text x="28" y="55"  font-family="DejaVu Sans Mono" font-size="30" fill="#ffffff">03/09/2026 07:14:22 (GMT-3)</text>
               <text x="28" y="105" font-family="DejaVu Sans Mono" font-size="30" fill="#ffffff">Início do expediente · Horímetro 4.812,5 h</text>
               <text x="28" y="155" font-family="DejaVu Sans"      font-size="30" fill="#ffffff">Operador: João da Silva · Obra: BR-386</text>
               <text x="28" y="205" font-family="DejaVu Sans"      font-size="30" fill="#ffffff">Acentos: ÁÉÍÓÚ áéíóú Ç ç Ã Õ ã õ</text>
             </svg>`);

        const { data } = await sharp(svg).greyscale().raw().toBuffer({ resolveWithObject: true });
        let claros = 0;
        for (let i = 0; i < data.length; i++) if (data[i] > 200) claros++;

        // Salva PNG para conferência visual (o dígito e o acento precisam estar nítidos).
        await sharp(svg).png().toFile(path.join(OUT_DIR, 'carimbo-teste.png'));

        const ok = claros > 3000; // texto real gera dezenas de milhares; ausência de fonte ~0
        record('2. Acento no SVG (librsvg + DejaVu)',
            ok,
            `${claros.toLocaleString('pt-BR')} px de texto desenhados. `
            + `PNG salvo em out/carimbo-teste.png — CONFIRA os acentos a olho.`);
    } catch (err) {
        record('2. Acento no SVG (librsvg + DejaVu)', false, String(err && err.message));
    }

    // ---------------------------------------------------------------------
    // Teste 4 — vazão de composição do carimbo (renders/s)
    // Meta do plano: >= 8/s. Compõe a banda numa foto ~1600px repetidas vezes.
    // ---------------------------------------------------------------------
    try {
        const BW = 1600, BH = 1200;
        const base = await sharp({
            create: { width: BW, height: BH, channels: 3, background: { r: 110, g: 118, b: 96 } },
        }).jpeg({ quality: 80 }).toBuffer();

        const faixaH = Math.round(BH * 0.22);
        const banda = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${faixaH}">
               <rect width="100%" height="100%" fill="rgba(28,26,23,0.80)"/>
               <rect x="0" y="0" width="10" height="${faixaH}" fill="#9E7A42"/>
               <text x="30" y="55"  font-family="DejaVu Sans Mono" font-size="34" fill="#fff">Início · Horímetro 4.812,5 h · ±8 m</text>
               <text x="30" y="105" font-family="DejaVu Sans"      font-size="30" fill="#fff">Obra: BR-386 km 342 · -29.463812, -51.961204</text>
               <text x="30" y="150" font-family="DejaVu Sans"      font-size="26" fill="#e9d9bf">MAK Serviços · Operador: João da Silva</text>
             </svg>`);
        const bandaPng = await sharp(banda).png().toBuffer();

        const N = 40;
        const t0 = Date.now();
        for (let i = 0; i < N; i++) {
            await sharp(base)
                .rotate() // aplica EXIF orientation, como no §5.5
                .composite([{ input: bandaPng, top: BH - faixaH, left: 0 }])
                .jpeg({ quality: 82 })
                .toBuffer();
        }
        const seg = (Date.now() - t0) / 1000;
        const vazao = N / seg;
        await sharp(base).composite([{ input: bandaPng, top: BH - faixaH, left: 0 }])
            .jpeg({ quality: 82 }).toFile(path.join(OUT_DIR, 'carimbo-composto.jpg'));

        record('4. Vazão de render do carimbo (meta ≥ 8/s)',
            vazao >= 8,
            `${vazao.toFixed(1)} renders/s (${N} imagens em ${seg.toFixed(2)} s). `
            + `Exemplo composto em out/carimbo-composto.jpg.`);
    } catch (err) {
        record('4. Vazão de render do carimbo (meta ≥ 8/s)', false, String(err && err.message));
    }

    // ---------------------------------------------------------------------
    // Teste 5 — fuso do contêiner é GMT-3 (getTimezoneOffset === 180)
    // ---------------------------------------------------------------------
    const offset = new Date().getTimezoneOffset(); // GMT-3 => +180
    record('5. Fuso do contêiner é America/Sao_Paulo (GMT-3)',
        offset === 180,
        `TZ=${process.env.TZ || '(vazio)'} · offset=${offset} min · agora=${new Date().toString()}`);

    finalize();
}

function finalize() {
    const hardFails = results.filter(r => r.hard && !r.ok);
    console.log('\n----------------------------------------------------------');
    console.log(hardFails.length === 0
        ? '\x1b[32m✔ Fase 0 aprovada — pode iniciar a implantação.\x1b[0m'
        : `\x1b[31m✘ ${hardFails.length} teste(s) duro(s) reprovado(s): `
          + hardFails.map(r => r.nome).join(', ') + '\x1b[0m');
    console.log('----------------------------------------------------------\n');
    process.exit(hardFails.length === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Erro inesperado no spike:', err);
    process.exit(2);
});
