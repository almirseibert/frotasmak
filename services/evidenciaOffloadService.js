// backend/services/evidenciaOffloadService.js
// -----------------------------------------------------------------------------
// Offload (arquivamento) + restauração — Evidências de Campo, Fase 7 (§11).
// Exportar e apagar são etapas SEPARADAS: gerarLote monta o ZIP e NÃO apaga nada;
// só confirmarBaixa (após o arquivo chegar à máquina de TI) apaga os originais.
// A restauração casa por sha256 (autoritativo) e devolve os bytes ao sistema.
// -----------------------------------------------------------------------------
const db = require('../database');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
// `archiver` é ESM-only nas versões recentes; num projeto CommonJS não dá para
// require()-á-lo. Carregamos via import() dinâmico dentro de gerarLote (lazy).
const { SUBDIRS, resolverCaminho, relativizar, garantirDirs } = require('../utils/evidenciaRegras');
const carimbo = require('./evidenciaCarimboService');
const carimboCfg = require('./evidenciaCarimboConfigService');

const CAP_ARQUIVOS = 5000;
const CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const slug = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

// Dados efetivos p/ o carimbo (compacto — evita depender do controller).
function buildDados(r) {
    const cap = r.ov_capturado_em || r.dev_capturado_em;
    const MOMENTO = {
        horimetro_inicio: 'Início do expediente', horimetro_fim: 'Fim do expediente',
        foto_manha: 'Trabalho (manhã)', foto_tarde: 'Trabalho (tarde)', extra: 'Extra',
        rotina_filtro: 'Limpeza de filtro', rotina_graxa: 'Engraxamento',
        planilha_trabalho: 'Planilha de trabalho',
    };
    let leitura = null;
    if (r.horimetro != null) leitura = `Horímetro ${Number(r.horimetro).toLocaleString('pt-BR')} h`;
    else if (r.odometro != null) leitura = `Odômetro ${Number(r.odometro).toLocaleString('pt-BR')} km`;
    return {
        dataHora: cap ? new Date(cap).toLocaleString('pt-BR', { hour12: false }) : '',
        latitude: r.ov_latitude != null ? r.ov_latitude : r.dev_latitude,
        longitude: r.ov_longitude != null ? r.ov_longitude : r.dev_longitude,
        precisao_m: r.dev_precisao_m != null ? Math.round(Number(r.dev_precisao_m)) : null,
        obra: r.ov_obra_nome || r.dev_obra_nome || r._obra_nome || null,
        equipamento: r.ov_equip_label || r.dev_equip_label || r._equip_label || null,
        operador: r.ov_operador_nome || r.dev_operador_nome || r._operador_nome || null,
        leitura,
        codigo: `EV-${String(r.id).slice(0, 8).toUpperCase()}`,
        momentoLabel: MOMENTO[r.tipo] || null,
        linha_livre: r.ov_linha_extra || r.observacao || null,
        // Sem isto o carimbo REDUZIDO de um anexo retroativo sairia no ZIP como
        // "Anexada posteriormente · referente a -".
        retroativo: r.origem_anexo === 'retroativo',
        dataRefBr: r.data_ref ? String(r.data_ref).slice(0, 10).split('-').reverse().join('/') : '',
    };
}

// ---- Gera o lote (ZIP). Não apaga nada. Marca a membership por offload_id. ----
async function gerarLote(obraId, { de, ate, geradoPor } = {}) {
    garantirDirs();
    const [[obra]] = await db.query('SELECT nome FROM obras WHERE id = ? LIMIT 1', [obraId]);
    const obraNome = obra?.nome || obraId;
    const obraSlug = slug(obraNome);

    const [regs] = await db.query(
        `SELECT r.*, v.placa AS _placa, v.registroInterno AS _reg, o.nome AS _obra_nome
           FROM evidencia_registro r
           LEFT JOIN vehicles v ON v.id = r.veiculo_id
           LEFT JOIN obras o ON o.id = r.obra_id
          WHERE r.obra_id = ? AND r.estado = 'ativo'
            ${de ? 'AND r.data_ref >= ?' : ''} ${ate ? 'AND r.data_ref <= ?' : ''}
          ORDER BY r.data_ref, r.dev_capturado_em`,
        [obraId, ...(de ? [de] : []), ...(ate ? [ate] : [])]
    );
    if (!regs.length) { const e = new Error('Sem evidências ativas no período.'); e.code = 'VAZIO'; throw e; }
    const bytes = regs.reduce((s, r) => s + Number(r.arquivo_bytes || 0), 0);
    if (regs.length > CAP_ARQUIVOS || bytes > CAP_BYTES) {
        const e = new Error(`Lote grande demais (${regs.length} fotos / ${(bytes / 1e9).toFixed(1)} GB). Reduza o período — máx. ${CAP_ARQUIVOS} fotos ou 2 GB.`);
        e.code = 'GRANDE'; throw e;
    }

    const loteId = randomUUID();
    await db.query(
        `INSERT INTO evidencia_offload (id, obra_id, periodo_inicio, periodo_fim, gerado_em, gerado_por, total_fotos, status, destino)
         VALUES (?,?,?,?, NOW(), ?, ?, 'GERANDO', 'TI / Desenvolvimento')`,
        [loteId, obraId, de || regs[0].data_ref, ate || regs[regs.length - 1].data_ref, geradoPor || null, regs.length]
    );

    const outDir = path.join(SUBDIRS.export, loteId);
    fs.mkdirSync(outDir, { recursive: true });
    const zipName = `MAK_EVID_${obraSlug}_${de || 'ini'}_a_${ate || 'fim'}.zip`;
    const zipPath = path.join(outDir, zipName);

    try {
        // archiver v8 é ESM-only e NÃO exporta mais a factory `archiver('zip')`:
        // expõe as classes (ZipArchive/TarArchive). Mantemos fallback p/ v5-7.
        const mod = await import('archiver');
        const makeZip = (opts) => (mod.ZipArchive ? new mod.ZipArchive(opts)
            : (mod.default || mod)('zip', opts));

        const output = fs.createWriteStream(zipPath);
        const archive = makeZip({ zlib: { level: 6 } });
        // Promise "pura" (executor síncrono): qualquer erro do stream rejeita
        // de verdade, em vez de virar unhandledRejection e deixar o lote GERANDO.
        const terminou = new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
            archive.on('warning', (w) => { if (w.code !== 'ENOENT') reject(w); });
        });
        archive.pipe(output);

        const manifest = [];
        const csv = ['data_ref;equipamento;tipo;operador;lat;lng;horimetro;arquivo'];
        const marcas = [];
        let idx = 0;
        for (const r of regs) {
            idx++;
            r._equip_label = [r._reg, r._placa].filter(Boolean).join(' · ') || r.modelo || null;
            r._dados = buildDados(r);
            try { r._campos = await carimboCfg.resolveCampos(db, r.obra_id, r.veiculo_id); }
            catch { r._campos = {}; }
            const dataRef = ymd(r.data_ref);
            const mes = dataRef.slice(0, 7);
            const hash8 = String(r.sha256 || '').slice(0, 8);
            const nome = `${dataRef}_${slug(r._reg)}_${slug(r._placa)}_${r.tipo}_${String(idx).padStart(3, '0')}_${hash8}.jpg`;
            const base = `MAK_EVID/${obraSlug}/${mes}`;

            let stampedAbs = null;
            try { stampedAbs = await carimbo.obterVariante(r, 'stamped'); } catch { /* sem carimbada */ }
            if (stampedAbs && fs.existsSync(stampedAbs)) archive.file(stampedAbs, { name: `${base}/carimbadas/${nome}` });
            const origAbs = resolverCaminho(r.arquivo_rel);
            if (origAbs && fs.existsSync(origAbs)) archive.file(origAbs, { name: `${base}/originais/${nome}` });

            manifest.push({
                id: r.id, sha256: r.sha256, tipo: r.tipo, data_ref: dataRef, arquivo: nome,
                dev: { capturado_em: r.dev_capturado_em, latitude: r.dev_latitude, longitude: r.dev_longitude, precisao_m: r.dev_precisao_m, operador: r.dev_operador_nome, obra: r.dev_obra_nome, equip: r.dev_equip_label },
                ov: { capturado_em: r.ov_capturado_em, latitude: r.ov_latitude, longitude: r.ov_longitude, operador: r.ov_operador_nome, obra: r.ov_obra_nome, equip: r.ov_equip_label, linha_extra: r.ov_linha_extra },
                stamp_version: r.stamp_version, stamp_mode: r.stamp_mode,
                // Proveniência: o ZIP é o artefato que sai da empresa, então
                // precisa dizer quais fotos foram anexadas depois do dia.
                origem_anexo: r.origem_anexo, anexado_em: r.anexado_em,
                horimetro: r.horimetro, odometro: r.odometro,
            });
            csv.push([dataRef, r._equip_label, r.tipo, r._dados.operador || '', r._dados.latitude ?? '', r._dados.longitude ?? '', r.horimetro ?? '', nome].join(';'));
            marcas.push([`${base}/originais`, nome, r.id]);
        }

        archive.append(JSON.stringify(manifest, null, 2), { name: `MAK_EVID/${obraSlug}/manifest.json` });
        archive.append(csv.join('\n'), { name: `MAK_EVID/${obraSlug}/relatorio-aderencia.csv` });
        archive.append(
            `Dossiê de arquivamento — Evidências de Campo\nObra: ${obraNome}\nPeríodo: ${de || 'início'} a ${ate || 'fim'}\nFotos: ${regs.length}\n\n` +
            `As pastas carimbadas/ e originais/ vão juntas. A restauração usa os ORIGINAIS (restaurar a carimbada quebraria a propriedade não-destrutiva).\n` +
            `Gerado em ${new Date().toLocaleString('pt-BR')}.\n`,
            { name: `MAK_EVID/${obraSlug}/LEIA-ME.txt` });

        archive.finalize();
        await terminou;

        // Só marca a membership depois que o ZIP existe de fato.
        for (const [pasta, nome, id] of marcas) {
            await db.query('UPDATE evidencia_registro SET offload_id=?, offload_pasta=?, offload_arquivo=? WHERE id=?',
                [loteId, pasta, nome, id]);
        }

        const size = fs.statSync(zipPath).size;
        await db.query('UPDATE evidencia_offload SET status=?, tamanho_bytes=?, caminho_zip=? WHERE id=?',
            ['PRONTO', size, relativizar(zipPath), loteId]);
        return { id: loteId, status: 'PRONTO', total_fotos: regs.length, tamanho_bytes: size };
    } catch (err) {
        // Falhou: não deixa lote-fantasma "gerando" nem fotos presas a ele.
        await removerLote(loteId).catch(() => {});
        throw err;
    }
}

// data_ref vem do mysql2 como Date (meia-noite local) — String(Date) virava
// "Mon Sep 14 ..." no nome do arquivo. Normaliza p/ YYYY-MM-DD.
function ymd(v) {
    if (v instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v || '').slice(0, 10);
}

// Remove o lote (linha + ZIP em disco) e solta as fotos marcadas. Nunca toca
// nos originais das evidências.
async function removerLote(loteId) {
    await db.query(`UPDATE evidencia_registro SET offload_id=NULL, offload_pasta=NULL, offload_arquivo=NULL
                     WHERE offload_id=? AND estado='ativo'`, [loteId]);
    await db.query('DELETE FROM evidencia_offload WHERE id=?', [loteId]);
    try { fs.rmSync(path.join(SUBDIRS.export, String(loteId)), { recursive: true, force: true }); } catch { /* */ }
}

// ---- Descarta um lote não confirmado (GERANDO travado, PRONTO, BAIXADO) ----
async function descartarLote(loteId) {
    const [[lote]] = await db.query('SELECT status FROM evidencia_offload WHERE id = ?', [loteId]);
    if (!lote) { const e = new Error('Lote não encontrado.'); e.code = 'NAO_ACHOU'; throw e; }
    if (lote.status === 'CONFIRMADO' || lote.status === 'PURGADO') {
        const e = new Error('Lote já confirmado/purgado — não pode ser descartado.'); e.code = 'JA_CONFIRMADO'; throw e;
    }
    await removerLote(loteId);
    return { descartado: true };
}

// Apaga as variantes stamped/clean do cache, PRESERVANDO a thumb (§9).
function purgarVariantes(registroId) {
    const dir = path.join(SUBDIRS.cache, String(registroId));
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.startsWith('thumb')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* */ } }
        }
    } catch { /* sem cache */ }
}

// ---- Confirma a baixa: AQUI (e só aqui) os originais são apagados ----
async function confirmarBaixa(loteId, { userId } = {}) {
    const [[lote]] = await db.query('SELECT * FROM evidencia_offload WHERE id = ?', [loteId]);
    if (!lote) { const e = new Error('Lote não encontrado.'); e.code = 'NAO_ACHOU'; throw e; }
    if (lote.status === 'CONFIRMADO' || lote.status === 'PURGADO') return { arquivadas: 0, jaConfirmado: true };
    if (lote.status !== 'PRONTO' && lote.status !== 'BAIXADO') { const e = new Error('Lote ainda não está pronto.'); e.code = 'NAO_PRONTO'; throw e; }

    const [regs] = await db.query(`SELECT id, arquivo_rel FROM evidencia_registro WHERE offload_id = ? AND estado = 'ativo'`, [loteId]);
    for (const r of regs) {
        const origAbs = resolverCaminho(r.arquivo_rel);
        if (origAbs && fs.existsSync(origAbs)) { try { fs.unlinkSync(origAbs); } catch { /* */ } }
        purgarVariantes(r.id);
    }
    await db.query(`UPDATE evidencia_registro SET estado='arquivado', offload_em=NOW(), offload_por=? WHERE offload_id=? AND estado='ativo'`, [userId || null, loteId]);
    await db.query(`UPDATE evidencia_offload SET status='CONFIRMADO', confirmado_em=NOW(), purgado_em=NOW() WHERE id=?`, [loteId]);
    return { arquivadas: regs.length };
}

// ---- Restauração por sha256 (autoritativo) / hash8 do nome (fallback) ----
function hash8DoNome(nome) {
    const m = String(nome || '').match(/([0-9a-f]{8})\.jpg$/i);
    return m ? m[1].toLowerCase() : null;
}

async function restaurarArquivos(files, { dry = false, userId } = {}) {
    const resultados = [];
    for (const f of files) {
        const buf = f.buffer || (f.path ? fs.readFileSync(f.path) : null);
        if (!buf) { resultados.push({ arquivo: f.originalname, match: 'erro', detalhe: 'sem conteúdo' }); continue; }
        const sha = crypto.createHash('sha256').update(buf).digest('hex');

        let [[reg]] = await db.query('SELECT * FROM evidencia_registro WHERE sha256 = ? LIMIT 1', [sha]);
        let via = 'sha256';
        if (!reg) {
            const h8 = hash8DoNome(f.originalname);
            if (h8) { const [rows] = await db.query('SELECT * FROM evidencia_registro WHERE LEFT(sha256,8) = ? LIMIT 1', [h8]); reg = rows[0]; via = 'hash8'; }
        }
        if (!reg) { resultados.push({ arquivo: f.originalname, match: 'none' }); continue; }

        const base = { arquivo: f.originalname, match: via, registroId: reg.id, estado: reg.estado };
        if (dry) { resultados.push(base); continue; }
        if (reg.estado !== 'arquivado') { resultados.push({ ...base, detalhe: 'não está arquivada — nada a fazer' }); continue; }

        const origAbs = resolverCaminho(reg.arquivo_rel);
        try {
            fs.mkdirSync(path.dirname(origAbs), { recursive: true });
            fs.writeFileSync(origAbs, buf);
            const hist = Array.isArray(reg.historico) ? reg.historico : (reg.historico ? JSON.parse(reg.historico) : []);
            hist.push({ offload_id: reg.offload_id, offload_pasta: reg.offload_pasta, offload_arquivo: reg.offload_arquivo, offload_em: reg.offload_em, restaurado_em: new Date().toISOString() });
            await db.query(
                `UPDATE evidencia_registro SET estado='ativo', restaurado_em=NOW(), restaurado_por=?,
                    offload_id=NULL, offload_pasta=NULL, offload_arquivo=NULL, historico=? WHERE id=?`,
                [userId || null, JSON.stringify(hist), reg.id]
            );
            carimbo.limparCache(reg.id); // regenera variantes a partir do original restaurado
            resultados.push({ ...base, restaurada: true });
        } catch (e) {
            resultados.push({ ...base, match: 'erro', detalhe: e.message });
        }
    }
    return resultados;
}

async function listarLotes(obraId) {
    const where = obraId ? 'WHERE l.obra_id = ?' : '';
    const [rows] = await db.query(
        `SELECT l.*, DATE_FORMAT(l.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
                DATE_FORMAT(l.periodo_fim, '%Y-%m-%d') AS periodo_fim, o.nome AS obra_nome
           FROM evidencia_offload l LEFT JOIN obras o ON o.id = l.obra_id ${where} ORDER BY l.gerado_em DESC LIMIT 100`,
        obraId ? [obraId] : []
    );
    return rows;
}

module.exports = { gerarLote, confirmarBaixa, descartarLote, restaurarArquivos, listarLotes, purgarVariantes };
