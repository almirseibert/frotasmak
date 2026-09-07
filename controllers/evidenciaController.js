// backend/controllers/evidenciaController.js
// -----------------------------------------------------------------------------
// Evidências de Campo — Fase 2: ingest, meu-escopo, arquivo, imagem assinada.
// MySQL 8, sem ORM. IDs de referência são VARCHAR(255) (users/obras/vehicles/
// employees), PKs novas VARCHAR(36).
// -----------------------------------------------------------------------------
const db = require('../database');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const {
    SUBDIRS, resolverCaminho, relativizar, exigeEvidencia,
    resolveRegraObra, haversineM, assinarTodas, assinarVariante, verificarAssinatura,
} = require('../utils/evidenciaRegras');
const carimbo = require('../services/evidenciaCarimboService');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { getAllowedReadingTypes } = require('../utils/vehicleRules');
const aderenciaSvc = require('../services/evidenciaAderenciaService');
const offloadSvc = require('../services/evidenciaOffloadService');
let pushService = null;
try { pushService = require('../services/pushService'); } catch { /* opcional */ }

const TIPOS_VALIDOS = ['horimetro_inicio', 'horimetro_fim', 'foto_manha', 'foto_tarde', 'extra'];
const TIPOS_COM_LEITURA = ['horimetro_inicio', 'horimetro_fim'];

const MOMENTO_LABEL = {
    horimetro_inicio: 'Início do expediente',
    horimetro_fim: 'Fim do expediente',
    foto_manha: 'Trabalho (manhã)',
    foto_tarde: 'Trabalho (tarde)',
    extra: 'Extra',
};

// data_ref no fuso do contêiner (TZ=America/Sao_Paulo). 'en-CA' => YYYY-MM-DD.
const hojeRef = () => new Date().toLocaleDateString('en-CA');
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const limparUpload = (f) => { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch { /* */ } };

// ---- Valores efetivos do carimbo (COALESCE(ov_*, dev_*)) + dados p/ o SVG -------
function montarDados(r) {
    const cap = r.ov_capturado_em || r.dev_capturado_em;
    const dataHora = cap ? new Date(cap).toLocaleString('pt-BR', { hour12: false }) : '';
    const lat = r.ov_latitude != null ? r.ov_latitude : r.dev_latitude;
    const lng = r.ov_longitude != null ? r.ov_longitude : r.dev_longitude;
    let leitura = null;
    if (r.horimetro != null) leitura = `Horímetro ${Number(r.horimetro).toLocaleString('pt-BR')} h`;
    else if (r.odometro != null) leitura = `Odômetro ${Number(r.odometro).toLocaleString('pt-BR')} km`;
    return {
        dataHora,
        latitude: lat, longitude: lng,
        precisao_m: r.dev_precisao_m != null ? Math.round(Number(r.dev_precisao_m)) : null,
        distancia_obra_m: r._distancia_obra_m ?? null,
        obra: r.ov_obra_nome || r.dev_obra_nome || r._obra_nome || null,
        equipamento: r.ov_equip_label || r.dev_equip_label || r._equip_label || null,
        operador: r.ov_operador_nome || r.dev_operador_nome || r._operador_nome || null,
        leitura,
        codigo: `EV-${String(r.id).slice(0, 8).toUpperCase()}`,
        momentoLabel: MOMENTO_LABEL[r.tipo] || null,
        linha_livre: r.ov_linha_extra || null,
    };
}

// Carrega um registro com os nomes juntados e a distância à obra calculada.
async function carregarRegistro(id) {
    const [rows] = await db.query(
        `SELECT r.*, o.nome AS _obra_nome, o.latitude AS _obra_lat, o.longitude AS _obra_lng,
                v.placa AS _placa, v.registroInterno AS _reg, v.modelo AS _modelo,
                e.nome AS _operador_nome
           FROM evidencia_registro r
           LEFT JOIN obras o     ON o.id = r.obra_id
           LEFT JOIN vehicles v  ON v.id = r.veiculo_id
           LEFT JOIN employees e ON e.id = r.employee_id
          WHERE r.id = ? LIMIT 1`, [id]);
    const r = rows[0];
    if (!r) return null;
    r._equip_label = [r._reg, r._placa].filter(Boolean).join(' · ') || r._modelo || null;
    const lat = r.ov_latitude != null ? r.ov_latitude : r.dev_latitude;
    const lng = r.ov_longitude != null ? r.ov_longitude : r.dev_longitude;
    r._distancia_obra_m = haversineM(lat, lng, r._obra_lat, r._obra_lng);
    return r;
}

// =============================================================================
// POST /api/evidencias — ingest multipart (campo 'foto'), idempotente em client_id
// =============================================================================
async function ingest(req, res) {
    const f = req.file;
    if (!f) {
        // Mensagem CONTÉM "arquivo" para virar 400 no handler global (server.js:2237).
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    try {
        const b = req.body || {};
        const client_id = (b.client_id || '').trim();
        const obra_id = (b.obra_id || '').trim();
        const veiculo_id = (b.veiculo_id || '').trim();
        const tipo = (b.tipo || '').trim();

        if (!client_id || !obra_id || !veiculo_id || !TIPOS_VALIDOS.includes(tipo)) {
            limparUpload(f);
            return res.status(400).json({ error: 'Dados obrigatórios ausentes (client_id, obra_id, veiculo_id, tipo).' });
        }

        // --- Idempotência: mesma captura reenviada pela fila offline ---
        // Melhoria: responder 200 com o registro existente (NUNCA 409), senão a
        // fila trata como erro permanente e descarta a foto.
        const [[jaExiste]] = await db.query('SELECT id, stamp_version FROM evidencia_registro WHERE client_id = ? LIMIT 1', [client_id]);
        if (jaExiste) {
            limparUpload(f);
            return res.status(200).json({
                jaExistia: true,
                id: jaExiste.id,
                urls: assinarTodas(jaExiste.id, jaExiste.stamp_version || 1),
            });
        }

        // --- Veículo: escopo §2 + tipo de leitura ---
        const [[veic]] = await db.query('SELECT id, tipo, placa, registroInterno, modelo FROM vehicles WHERE id = ? LIMIT 1', [veiculo_id]);
        if (!veic) { limparUpload(f); return res.status(400).json({ error: 'Veículo não encontrado.' }); }

        // --- Regra da obra + GPS obrigatório (§0/§5.4) ---
        const regra = await resolveRegraObra(db, obra_id);
        const dev_lat = num(b.dev_latitude);
        const dev_lng = num(b.dev_longitude);
        if (regra.exigir_gps && (dev_lat == null || dev_lng == null)) {
            limparUpload(f);
            return res.status(400).json({ error: 'Coordenada obrigatória: ative a localização e tente novamente.', campo: 'gps' });
        }

        // --- Leitura de horímetro/odômetro nos momentos de início/fim ---
        let horimetro = null, odometro = null;
        if (TIPOS_COM_LEITURA.includes(tipo)) {
            const leitura = num(b.leitura ?? b.horimetro ?? b.odometro);
            if (leitura == null) {
                limparUpload(f);
                return res.status(400).json({ error: 'Leitura obrigatória neste momento.', campo: 'leitura' });
            }
            const campoLeitura = getAllowedReadingTypes(veic.tipo)[0]; // 'horimetro' | 'odometro'
            const [[atualRow]] = await db.query(`SELECT ${campoLeitura} AS atual FROM vehicles WHERE id = ?`, [veiculo_id]);
            const atual = Number(atualRow?.atual || 0);
            if (leitura < atual) {
                // Formato que os clientes já sabem tratar (regressão de leitura).
                limparUpload(f);
                return res.status(400).json({
                    error: `${campoLeitura === 'horimetro' ? 'Horímetro' : 'Odômetro'} menor que o último registrado.`,
                    campo: campoLeitura, tipo: 'regressao',
                    valor_informado: leitura, valor_anterior: atual,
                });
            }
            if (campoLeitura === 'horimetro') horimetro = leitura; else odometro = leitura;
            // Propaga ao veículo (só sobe — a própria função garante).
            await updateVehicleReading(db, veiculo_id, veic.tipo, leitura, campoLeitura);
        }

        // --- employee/operador ---
        let employee_id = (b.employee_id || '').trim() || null;
        let operadorNome = (b.dev_operador_nome || req.user?.name || '').trim() || null;
        if (!employee_id && req.user?.id) {
            const [[u]] = await db.query('SELECT employeeId FROM users WHERE id = ? LIMIT 1', [req.user.id]);
            employee_id = u?.employeeId || null;
        }
        if (employee_id && !operadorNome) {
            const [[e]] = await db.query('SELECT nome FROM employees WHERE id = ? LIMIT 1', [employee_id]);
            operadorNome = e?.nome || null;
        }

        // --- obra + distância (só para gravar dev_obra_nome; cerca é informativa) ---
        const [[obraRow]] = await db.query('SELECT nome, latitude, longitude FROM obras WHERE id = ? LIMIT 1', [obra_id]);

        // --- data_ref + clock skew ---
        const devCap = b.dev_capturado_em ? new Date(b.dev_capturado_em) : new Date();
        const skewS = Math.round((Date.now() - devCap.getTime()) / 1000);
        let data_ref = (b.data_ref || '').trim() || hojeRef();
        if (Math.abs(skewS) > 3600) data_ref = hojeRef(); // relógio muito fora → servidor manda

        // --- grava o arquivo: inbox (multer) -> orig/<obra>/<AAAA>/<MM>/<id>.<ext> ---
        const id = randomUUID();
        const buf = fs.readFileSync(f.path);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        let width = null, height = null;
        try {
            const sharp = require('sharp');
            const meta = await sharp(buf).metadata();
            width = meta.width || null; height = meta.height || null;
        } catch { /* metadados são bônus */ }

        const d = new Date();
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        const destDir = path.join(SUBDIRS.orig, String(obra_id), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
        fs.mkdirSync(destDir, { recursive: true });
        const destAbs = path.join(destDir, `${id}${ext}`);
        fs.renameSync(f.path, destAbs);
        const arquivo_rel = relativizar(destAbs);

        const equipLabel = [veic.registroInterno, veic.placa].filter(Boolean).join(' · ') || veic.modelo || null;
        const turno = ['manha', 'tarde', 'indefinido'].includes(b.turno) ? b.turno
            : (tipo === 'foto_manha' ? 'manha' : tipo === 'foto_tarde' ? 'tarde' : 'indefinido');

        await db.query(
            `INSERT INTO evidencia_registro
               (id, client_id, obra_id, veiculo_id, employee_id, user_id, tipo, data_ref, turno,
                arquivo_rel, arquivo_bytes, arquivo_mime, sha256, largura_px, altura_px,
                dev_capturado_em, dev_latitude, dev_longitude, dev_precisao_m, dev_local_texto,
                dev_obra_nome, dev_equip_label, dev_operador_nome, dev_clock_skew_s, dev_origem,
                horimetro, odometro, observacao, stamp_version)
             VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?, 1)`,
            [
                id, client_id, obra_id, veiculo_id, employee_id, req.user?.id || null, tipo, data_ref, turno,
                arquivo_rel, buf.length, f.mimetype, sha256, width, height,
                devCap, dev_lat, dev_lng, num(b.dev_precisao_m), (b.dev_local_texto || '').trim() || null,
                obraRow?.nome || null, equipLabel, operadorNome, skewS, (b.dev_origem || 'web_online'),
                horimetro, odometro, (b.observacao || '').trim() || null,
            ]
        );

        // thumb já; stamped/clean são preguiçosas
        try { await carimbo.gerarThumbIngest({ id, arquivo_rel, stamp_version: 1 }); } catch (e) { console.warn('⚠️ thumb ingest:', e.message); }

        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }

        return res.status(201).json({ id, sha256, data_ref, urls: assinarTodas(id, 1) });
    } catch (err) {
        limparUpload(f);
        console.error('❌ [evidencias] ingest:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao registrar evidência.' });
    }
}

// =============================================================================
// GET /api/evidencias/meu-escopo — pacote offline do operador (§3.5)
// =============================================================================
async function meuEscopo(req, res) {
    try {
        const [[u]] = await db.query('SELECT employeeId FROM users WHERE id = ? LIMIT 1', [req.user.id]);
        const employeeId = u?.employeeId || null;
        const data = hojeRef();
        if (!employeeId) return res.json({ data, obras: [], equipamentos: [], hojeEnviado: {} });

        // Veículos nas obras ativas do operador (mesmo escopo de vehicleDocumentsController).
        const [linhas] = await db.query(
            `SELECT DISTINCT v.id, v.placa, v.registroInterno, v.modelo, v.tipo,
                    h.obraId AS obra_id, o.nome AS obra_nome, o.regiao, o.latitude, o.longitude
               FROM obras_historico_veiculos h
               JOIN vehicles v ON v.id = h.veiculoId
               LEFT JOIN obras o ON o.id = h.obraId
              WHERE h.dataSaida IS NULL
                AND h.obraId IN (
                    SELECT DISTINCT h2.obraId FROM obras_historico_veiculos h2
                     WHERE h2.employeeId = ? AND h2.dataSaida IS NULL
                )`,
            [employeeId]
        );

        // Só equipamentos no escopo §2 (horímetro).
        const equipamentos = linhas.filter(v => exigeEvidencia(v.tipo));
        const obraIds = [...new Set(equipamentos.map(v => v.obra_id).filter(Boolean))];
        const obras = [];
        for (const oid of obraIds) {
            const info = equipamentos.find(v => v.obra_id === oid);
            obras.push({
                id: oid, nome: info?.obra_nome || null, regiao: info?.regiao || null,
                latitude: info?.latitude ?? null, longitude: info?.longitude ?? null,
                regra: await resolveRegraObra(db, oid),
            });
        }

        // O que já foi enviado hoje: { veiculoId: [tipos] }
        const hojeEnviado = {};
        if (equipamentos.length) {
            const ids = equipamentos.map(v => v.id);
            const [envs] = await db.query(
                `SELECT veiculo_id, tipo FROM evidencia_registro
                  WHERE data_ref = ? AND estado <> 'descartado' AND veiculo_id IN (${ids.map(() => '?').join(',')})`,
                [data, ...ids]
            );
            for (const e of envs) (hojeEnviado[e.veiculo_id] = hojeEnviado[e.veiculo_id] || []).push(e.tipo);
        }

        return res.json({ data, obras, equipamentos, hojeEnviado });
    } catch (err) {
        console.error('❌ [evidencias] meu-escopo:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar escopo.' });
    }
}

// =============================================================================
// GET /api/evidencias — arquivo paginado (gestor). Teto de 92 dias no servidor.
// =============================================================================
async function listar(req, res) {
    try {
        const { obra_id, veiculo_id, employee_id, tipo, estado, de, ate } = req.query;
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
        const off = (page - 1) * limit;

        const where = []; const params = [];
        if (obra_id)     { where.push('r.obra_id = ?'); params.push(obra_id); }
        if (veiculo_id)  { where.push('r.veiculo_id = ?'); params.push(veiculo_id); }
        if (employee_id) { where.push('r.employee_id = ?'); params.push(employee_id); }
        if (tipo)        { where.push('r.tipo = ?'); params.push(tipo); }
        where.push('r.estado = ?'); params.push(estado || 'ativo');

        // Teto de 92 dias — nunca período ilimitado (§7).
        const ateD = ate || hojeRef();
        let deD = de;
        if (!deD) { const d = new Date(); d.setDate(d.getDate() - 30); deD = d.toLocaleDateString('en-CA'); }
        const diff = (new Date(ateD) - new Date(deD)) / 86400000;
        if (diff > 92) { const d = new Date(ateD); d.setDate(d.getDate() - 92); deD = d.toLocaleDateString('en-CA'); }
        where.push('r.data_ref BETWEEN ? AND ?'); params.push(deD, ateD);

        const whereSql = 'WHERE ' + where.join(' AND ');
        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM evidencia_registro r ${whereSql}`, params);
        const [rows] = await db.query(
            `SELECT r.id, r.obra_id, r.veiculo_id, r.employee_id, r.tipo, r.turno, r.data_ref,
                    r.dev_capturado_em, r.dev_latitude, r.dev_longitude, r.horimetro, r.odometro,
                    r.estado, r.stamp_version, r.dev_clock_skew_s,
                    o.nome AS obra_nome, v.placa, v.registroInterno, e.nome AS operador_nome
               FROM evidencia_registro r
               LEFT JOIN obras o ON o.id = r.obra_id
               LEFT JOIN vehicles v ON v.id = r.veiculo_id
               LEFT JOIN employees e ON e.id = r.employee_id
               ${whereSql}
               ORDER BY r.data_ref DESC, r.dev_capturado_em DESC
               LIMIT ? OFFSET ?`,
            [...params, limit, off]
        );
        const itens = rows.map(r => ({
            ...r,
            urls: {
                thumb: assinarVariante(r.id, 'thumb', r.stamp_version || 1),
                stamped: assinarVariante(r.id, 'stamped', r.stamp_version || 1),
            },
        }));
        return res.json({ total, page, limit, itens });
    } catch (err) {
        console.error('❌ [evidencias] listar:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao listar evidências.' });
    }
}

// =============================================================================
// GET /api/evidencias/:id — detalhe + histórico de auditoria
// =============================================================================
async function detalhe(req, res) {
    try {
        const r = await carregarRegistro(req.params.id);
        if (!r) return res.status(404).json({ error: 'Evidência não encontrada.' });
        let auditoria = [];
        try {
            const [a] = await db.query('SELECT * FROM evidencia_stamp_audit WHERE registro_id = ? ORDER BY created_at DESC', [r.id]);
            auditoria = a;
        } catch { /* tabela ainda não populada */ }
        return res.json({
            registro: r,
            dados_carimbo: montarDados(r),
            urls: assinarTodas(r.id, r.stamp_version || 1),
            auditoria,
        });
    } catch (err) {
        console.error('❌ [evidencias] detalhe:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar evidência.' });
    }
}

// =============================================================================
// GET /api/public/evidencias/:id/:variante — imagem assinada (SEM authMiddleware)
// =============================================================================
async function servirVariante(req, res) {
    try {
        const { id, variante } = req.params;
        const { v, exp, s } = req.query;
        if (!verificarAssinatura(id, variante, v, exp, s)) {
            return res.status(403).end();
        }
        const r = await carregarRegistro(id);
        if (!r) return res.status(404).end();
        // stamp_version entra na assinatura: URL de versão antiga não serve mais.
        if (String(r.stamp_version || 1) !== String(v)) return res.status(410).end();
        if (r.estado === 'arquivado') return res.status(410).json({ error: 'Evidência arquivada (bytes fora do servidor).' });

        r._dados = montarDados(r);
        r._campos = {}; // Fase 4 traz a config de campos por nível
        const abs = await carimbo.obterVariante(r, variante);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('Content-Type', 'image/jpeg');
        return fs.createReadStream(abs).pipe(res);
    } catch (err) {
        if (err.code === 'ORIG_AUSENTE') return res.status(410).end();
        console.error('❌ [evidencias] servirVariante:', err.message);
        return res.status(500).end();
    }
}

// =============================================================================
// GET /api/evidencias/minhas — últimos 7 dias do operador (app)
// =============================================================================
async function minhas(req, res) {
    try {
        const [[u]] = await db.query('SELECT employeeId FROM users WHERE id = ? LIMIT 1', [req.user.id]);
        const employeeId = u?.employeeId || null;
        const d = new Date(); d.setDate(d.getDate() - 7);
        const desde = d.toLocaleDateString('en-CA');
        const [rows] = await db.query(
            `SELECT r.id, r.veiculo_id, r.obra_id, r.tipo, r.data_ref, r.dev_capturado_em,
                    r.stamp_version, v.placa, v.registroInterno
               FROM evidencia_registro r
               LEFT JOIN vehicles v ON v.id = r.veiculo_id
              WHERE (r.user_id = ? OR r.employee_id = ?)
                AND r.data_ref >= ? AND r.estado <> 'descartado'
              ORDER BY r.dev_capturado_em DESC LIMIT 200`,
            [req.user.id, employeeId, desde]
        );
        const itens = rows.map(r => ({ ...r, urls: { thumb: assinarVariante(r.id, 'thumb', r.stamp_version || 1) } }));
        return res.json({ itens });
    } catch (err) {
        console.error('❌ [evidencias] minhas:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar suas evidências.' });
    }
}

// =============================================================================
// GET /api/evidencias/motivos-dispensa — catálogo de motivos ativos
// =============================================================================
async function motivosDispensa(req, res) {
    try {
        const [rows] = await db.query('SELECT codigo, label FROM evidencia_motivo_dispensa WHERE ativo = 1 ORDER BY ordem, label');
        return res.json({ motivos: rows });
    } catch (err) {
        console.error('❌ [evidencias] motivos:', err.message);
        return res.json({ motivos: [] });
    }
}

// =============================================================================
// POST /api/evidencias/dispensa — operador anula dia/turno (§8)
// =============================================================================
async function registrarDispensa(req, res) {
    try {
        const b = req.body || {};
        const obra_id = (b.obra_id || '').trim();
        const data_ref = (b.data_ref || '').trim() || hojeRef();
        const periodo = ['dia', 'manha', 'tarde'].includes(b.periodo) ? b.periodo : 'dia';
        const veiculo_id = (b.veiculo_id || '').trim() || null; // NULL = todos da obra
        if (!obra_id) return res.status(400).json({ error: 'Obra obrigatória.' });
        if (!b.motivo_codigo && !b.motivo_texto) return res.status(400).json({ error: 'Informe um motivo.' });

        const origem = (req.user?.role || req.user?.user_type) === 'operador' ? 'operador' : 'gestor';
        const id = randomUUID();
        await db.query(
            `INSERT INTO evidencia_dispensa
               (id, obra_id, veiculo_id, data_ref, periodo, motivo_codigo, motivo_texto, criado_por, criado_por_nome, origem)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [id, obra_id, veiculo_id, data_ref, periodo, (b.motivo_codigo || '').trim() || null,
             (b.motivo_texto || '').trim() || null, req.user?.id || null, req.user?.name || null, origem]
        );
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.status(201).json({ id });
    } catch (err) {
        console.error('❌ [evidencias] dispensa:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao registrar dispensa.' });
    }
}

// =============================================================================
// EDITOR DE CARIMBO (admin/gerência) — não-destrutivo, auditado (§5.2)
// =============================================================================
const CAMPOS_OV = ['ov_capturado_em', 'ov_latitude', 'ov_longitude', 'ov_local_texto',
    'ov_obra_nome', 'ov_equip_label', 'ov_operador_nome', 'ov_linha_extra', 'stamp_posicao'];
const CAMPOS_SENSIVEIS = ['ov_capturado_em', 'ov_latitude', 'ov_longitude']; // motivo obrigatório

async function _auditar(reg, acao, antes, depois, motivo, req) {
    await db.query(
        `INSERT INTO evidencia_stamp_audit
           (id, registro_id, stamp_version_antes, stamp_version_depois, acao, campos_antes, campos_depois, motivo, user_id, user_nome, ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), reg.id, reg.stamp_version, (reg.stamp_version || 1) + 1, acao,
         JSON.stringify(antes || {}), JSON.stringify(depois || {}), motivo || null,
         req.user?.id || null, req.user?.name || null, req.ip || null]
    );
}

async function carimboEditar(req, res) {
    try {
        const [[reg]] = await db.query('SELECT * FROM evidencia_registro WHERE id = ?', [req.params.id]);
        if (!reg) return res.status(404).json({ error: 'Evidência não encontrada.' });
        const b = req.body || {};
        const sets = []; const params = []; const antes = {}; const depois = {};
        let tocaSensivel = false;
        for (const campo of CAMPOS_OV) {
            if (!(campo in b)) continue;
            const val = b[campo] === '' ? null : b[campo];
            antes[campo] = reg[campo]; depois[campo] = val;
            sets.push(`${campo} = ?`); params.push(val);
            if (CAMPOS_SENSIVEIS.includes(campo) && String(reg[campo] ?? '') !== String(val ?? '')) tocaSensivel = true;
        }
        if (!sets.length) return res.status(400).json({ error: 'Nada para alterar.' });
        if (tocaSensivel && !(b.motivo && b.motivo.trim())) {
            return res.status(400).json({ error: 'Motivo obrigatório ao alterar data ou GPS.', campo: 'motivo' });
        }
        const novaVersao = (reg.stamp_version || 1) + 1;
        await db.query(`UPDATE evidencia_registro SET ${sets.join(', ')}, stamp_version = ? WHERE id = ?`, [...params, novaVersao, reg.id]);
        await _auditar(reg, 'editar', antes, depois, b.motivo, req);
        carimbo.limparCache(reg.id);
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.json({ ok: true, stamp_version: novaVersao, urls: assinarTodas(reg.id, novaVersao) });
    } catch (err) {
        console.error('❌ [evidencias] carimboEditar:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao editar carimbo.' });
    }
}

async function carimboRemover(req, res) {
    try {
        const [[reg]] = await db.query('SELECT * FROM evidencia_registro WHERE id = ?', [req.params.id]);
        if (!reg) return res.status(404).json({ error: 'Evidência não encontrada.' });
        if (!(req.body?.motivo && req.body.motivo.trim())) return res.status(400).json({ error: 'Motivo obrigatório para remover o carimbo.', campo: 'motivo' });
        const novaVersao = (reg.stamp_version || 1) + 1;
        await db.query(`UPDATE evidencia_registro SET stamp_mode = 'limpo', stamp_version = ? WHERE id = ?`, [novaVersao, reg.id]);
        await _auditar(reg, 'remover', { stamp_mode: reg.stamp_mode }, { stamp_mode: 'limpo' }, req.body.motivo, req);
        carimbo.limparCache(reg.id);
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.json({ ok: true, stamp_version: novaVersao, urls: assinarTodas(reg.id, novaVersao) });
    } catch (err) {
        console.error('❌ [evidencias] carimboRemover:', err.message);
        return res.status(500).json({ error: 'Falha ao remover carimbo.' });
    }
}

async function carimboRestaurar(req, res) {
    try {
        const [[reg]] = await db.query('SELECT * FROM evidencia_registro WHERE id = ?', [req.params.id]);
        if (!reg) return res.status(404).json({ error: 'Evidência não encontrada.' });
        const novaVersao = (reg.stamp_version || 1) + 1;
        const zerar = CAMPOS_OV.filter(c => c.startsWith('ov_')).map(c => `${c} = NULL`).join(', ');
        await db.query(`UPDATE evidencia_registro SET ${zerar}, stamp_mode='carimbado', stamp_version = ? WHERE id = ?`, [novaVersao, reg.id]);
        await _auditar(reg, 'restaurar_padrao', {}, {}, req.body?.motivo, req);
        carimbo.limparCache(reg.id);
        return res.json({ ok: true, stamp_version: novaVersao, urls: assinarTodas(reg.id, novaVersao) });
    } catch (err) {
        console.error('❌ [evidencias] carimboRestaurar:', err.message);
        return res.status(500).json({ error: 'Falha ao restaurar carimbo.' });
    }
}

// =============================================================================
// CONFIG DA OBRA (exigências/janelas) — GET/PUT
// =============================================================================
async function getConfig(req, res) {
    try { return res.json(await resolveRegraObra(db, req.params.obraId)); }
    catch (err) { return res.status(500).json({ error: err.message }); }
}
async function putConfig(req, res) {
    try {
        const b = req.body || {};
        await db.query(
            `INSERT INTO evidencia_config (obra_id, momentos_exigidos, horarios_limite, dias_semana, raio_cerca_m, exigir_gps, permitir_galeria, ativa)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE momentos_exigidos=VALUES(momentos_exigidos), horarios_limite=VALUES(horarios_limite),
               dias_semana=VALUES(dias_semana), raio_cerca_m=VALUES(raio_cerca_m), exigir_gps=VALUES(exigir_gps),
               permitir_galeria=VALUES(permitir_galeria), ativa=VALUES(ativa)`,
            [req.params.obraId,
             JSON.stringify(b.momentos_exigidos || null), JSON.stringify(b.horarios_limite || null),
             JSON.stringify(b.dias_semana || null), b.raio_cerca_m ?? 500,
             b.exigir_gps === false ? 0 : 1, b.permitir_galeria === true ? 1 : 0, b.ativa === false ? 0 : 1]
        );
        return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

// =============================================================================
// ADERÊNCIA — painel (§10.2)
// =============================================================================
async function aderencia(req, res) {
    try {
        const { obra_id } = req.query;
        const ate = req.query.ate || hojeRef();
        let de = req.query.de;
        if (!de) { const d = new Date(); d.setDate(d.getDate() - 7); de = d.toLocaleDateString('en-CA'); }
        const where = ['a.data_ref BETWEEN ? AND ?']; const params = [de, ate];
        if (obra_id) { where.push('a.obra_id = ?'); params.push(obra_id); }
        const [rows] = await db.query(
            `SELECT a.*, o.nome AS obra_nome, v.placa, v.registroInterno, e.nome AS operador_nome
               FROM evidencia_aderencia_dia a
               LEFT JOIN obras o ON o.id = a.obra_id
               LEFT JOIN vehicles v ON v.id = a.veiculo_id
               LEFT JOIN employees e ON e.id = a.employee_id
              WHERE ${where.join(' AND ')}
              ORDER BY a.data_ref DESC, o.nome, v.registroInterno`,
            params
        );
        const resumo = {
            equipamentos_dia: rows.length,
            completos: rows.filter(r => r.completo).length,
            exigidas: rows.reduce((s, r) => s + (r.exigidas || 0), 0),
            cumpridas: rows.reduce((s, r) => s + (r.cumpridas || 0), 0),
        };
        resumo.aderencia_pct = resumo.exigidas ? Math.round((resumo.cumpridas / resumo.exigidas) * 100) : 0;
        return res.json({ de, ate, resumo, dias: rows });
    } catch (err) {
        console.error('❌ [evidencias] aderencia:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar aderência.' });
    }
}

// =============================================================================
// CONSOLIDAÇÃO + PROJEÇÃO DA COBRANÇA (sob demanda) — não envia nada
// =============================================================================
async function consolidar(req, res) {
    try {
        const data = (req.body?.data || req.query.data || '').trim() || hojeRef();
        const a = await aderenciaSvc.consolidarDia(data);
        const c = await aderenciaSvc.projetarCobrancas(data);
        return res.json({ data, ...a, ...c });
    } catch (err) {
        console.error('❌ [evidencias] consolidar:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao consolidar.' });
    }
}

// =============================================================================
// COBRANÇA — FILA DE APROVAÇÃO MANUAL (Fase 5, modo seguro)
// =============================================================================
async function cobrancasListar(req, res) {
    try {
        const data = req.query.data || hojeRef();
        const status = req.query.status || 'PENDENTE';
        const where = ['data_ref = ?', 'status = ?']; const params = [data, status];
        if (req.query.obra_id) { where.push('obra_id = ?'); params.push(req.query.obra_id); }
        const [rows] = await db.query(
            `SELECT * FROM evidencia_cobranca_fila WHERE ${where.join(' AND ')} ORDER BY obra_nome, veic_label, tipo`,
            params
        );
        return res.json({ data, status, itens: rows });
    } catch (err) {
        console.error('❌ [evidencias] cobrancasListar:', err.message);
        return res.status(500).json({ error: 'Falha ao listar cobranças.' });
    }
}

const MOMENTO_CURTO = {
    horimetro_inicio: 'horímetro de início', horimetro_fim: 'horímetro final',
    foto_manha: 'foto da manhã', foto_tarde: 'foto da tarde',
};

// Aprova e ENVIA um item (push direto ao operador). É o ÚNICO ponto de disparo.
async function _enviarCobranca(item, req) {
    if (item.status !== 'PENDENTE') return { ok: false, motivo: 'nao_pendente' };
    const texto = `Falta a ${MOMENTO_CURTO[item.tipo] || item.tipo} da ${item.veic_label} na obra ${item.obra_nome || ''}. Envie pelo app.`;
    let enviado = false;
    if (pushService?.pushToUsers && item.operador_user_id) {
        try {
            await pushService.pushToUsers([item.operador_user_id], {
                title: 'Evidência pendente',
                body: texto,
                data: { tipo: 'evidencia_pendente', veiculo_id: item.veiculo_id, momento: item.tipo },
            });
            enviado = true;
        } catch (e) { console.warn('[evid cobranca] push:', e.message); }
    }
    // Dedupe/registro do envio.
    try {
        await db.query(
            `INSERT IGNORE INTO evidencia_cobranca_log (id, veiculo_id, obra_id, data_ref, tipo_cobranca, canal)
             VALUES (?,?,?,?,?, 'push')`,
            [randomUUID(), item.veiculo_id, item.obra_id, item.data_ref, item.tipo]
        );
    } catch { /* */ }
    await db.query(
        `UPDATE evidencia_cobranca_fila SET status='ENVIADA', enviado_em=NOW(), enviado_por=? WHERE id=?`,
        [req.user?.id || null, item.id]
    );
    return { ok: true, enviado, semToken: !enviado };
}

async function cobrancaAprovar(req, res) {
    try {
        const [[item]] = await db.query('SELECT * FROM evidencia_cobranca_fila WHERE id = ?', [req.params.id]);
        if (!item) return res.status(404).json({ error: 'Cobrança não encontrada.' });
        if (item.status !== 'PENDENTE') return res.status(400).json({ error: 'Cobrança já processada.' });
        const r = await _enviarCobranca(item, req);
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.json(r);
    } catch (err) {
        console.error('❌ [evidencias] cobrancaAprovar:', err.message);
        return res.status(500).json({ error: 'Falha ao enviar cobrança.' });
    }
}

async function cobrancasAprovarLote(req, res) {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado.' });
        let enviadas = 0, semToken = 0;
        for (const id of ids) {
            const [[item]] = await db.query('SELECT * FROM evidencia_cobranca_fila WHERE id = ?', [id]);
            if (item && item.status === 'PENDENTE') {
                const r = await _enviarCobranca(item, req);
                if (r.enviado) enviadas++; else semToken++;
            }
        }
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.json({ ok: true, enviadas, semToken });
    } catch (err) {
        console.error('❌ [evidencias] cobrancasAprovarLote:', err.message);
        return res.status(500).json({ error: 'Falha ao enviar cobranças.' });
    }
}

async function cobrancaIgnorar(req, res) {
    try {
        await db.query(`UPDATE evidencia_cobranca_fila SET status='IGNORADA', ignorado_em=NOW() WHERE id=? AND status='PENDENTE'`, [req.params.id]);
        return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

// =============================================================================
// POST /api/evidencias/dossie — PDF de comprovação (pdfkit) — Fase 6 (§10.3)
// =============================================================================
async function dossie(req, res) {
    try {
        const b = req.body || {};
        let regs = [];
        if (Array.isArray(b.ids) && b.ids.length) {
            for (const id of b.ids.slice(0, 300)) { const r = await carregarRegistro(id); if (r && r.estado === 'ativo') regs.push(r); }
        } else if (b.obra_id) {
            const ate = (b.ate || '').trim() || hojeRef();
            let de = (b.de || '').trim();
            if (!de) { const d = new Date(); d.setDate(d.getDate() - 30); de = d.toLocaleDateString('en-CA'); }
            const [rows] = await db.query(
                `SELECT id FROM evidencia_registro WHERE obra_id = ? AND data_ref BETWEEN ? AND ? AND estado='ativo'
                 ORDER BY data_ref, dev_capturado_em LIMIT 300`, [b.obra_id, de, ate]);
            for (const row of rows) { const r = await carregarRegistro(row.id); if (r) regs.push(r); }
        }
        if (!regs.length) return res.status(404).json({ error: 'Sem evidências para o dossiê.' });

        const obraNome = regs[0].ov_obra_nome || regs[0].dev_obra_nome || regs[0]._obra_nome || regs[0].obra_id;
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="dossie-evidencias.pdf"`);
        doc.pipe(res);

        doc.fontSize(20).fillColor('#1c1a17').text('Dossiê de Comprovação — Evidências de Campo');
        doc.moveDown(0.3).fontSize(12).fillColor('#555')
            .text(`Obra: ${obraNome}`)
            .text(`Total de evidências: ${regs.length}`)
            .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · MAK Serviços`);
        doc.moveDown();

        const W = doc.page.width - 80;
        for (const r of regs) {
            r._dados = montarDados(r); r._campos = {};
            let imgPath = null;
            try { imgPath = await carimbo.obterVariante(r, 'stamped'); } catch { /* imagem indisponível */ }
            const aspect = (r.altura_px && r.largura_px) ? r.altura_px / r.largura_px : 0.75;
            let imgH = Math.min(340, W * aspect);
            let imgW = imgH / aspect; if (imgW > W) { imgW = W; imgH = W * aspect; }
            if (doc.y + imgH + 60 > doc.page.height - 40) doc.addPage();
            const d = r._dados;
            doc.fontSize(11).fillColor('#1c1a17').text(`${d.equipamento || '-'} · ${d.momentoLabel || ''} · ${d.dataHora || ''}`);
            const y0 = doc.y + 2;
            if (imgPath) { try { doc.image(imgPath, 40, y0, { width: imgW }); doc.y = y0 + imgH + 4; } catch { doc.fillColor('#b91c1c').text('[imagem indisponível]'); } }
            doc.fontSize(9).fillColor('#666').text(
                `${d.latitude ?? '?'}, ${d.longitude ?? '?'}${d.precisao_m != null ? ` ±${d.precisao_m}m` : ''}`
                + `${d.leitura ? ' · ' + d.leitura : ''} · ${d.codigo}`);
            doc.moveDown(0.9);
        }
        doc.end();
    } catch (err) {
        console.error('❌ [evidencias] dossie:', err.code, '|', err.sqlMessage || err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar dossiê.' });
        else res.end();
    }
}

// =============================================================================
// OFFLOAD (arquivamento) + RESTAURAÇÃO — Fase 7 (§11)
// =============================================================================
async function offloadListar(req, res) {
    try { return res.json({ lotes: await offloadSvc.listarLotes(req.query.obra_id || null) }); }
    catch (err) { return res.status(500).json({ error: err.message }); }
}

async function offloadGerar(req, res) {
    try {
        const b = req.body || {};
        if (!b.obra_id) return res.status(400).json({ error: 'Obra obrigatória.' });
        const r = await offloadSvc.gerarLote(b.obra_id, { de: b.de || null, ate: b.ate || null, geradoPor: req.user?.id });
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.status(201).json(r);
    } catch (err) {
        console.error('❌ [evidencias] offloadGerar:', err.code, '|', err.message);
        return res.status(err.code === 'VAZIO' || err.code === 'GRANDE' ? 400 : 500).json({ error: err.message });
    }
}

async function offloadDownload(req, res) {
    try {
        const [[lote]] = await db.query('SELECT * FROM evidencia_offload WHERE id = ?', [req.params.id]);
        if (!lote || !lote.caminho_zip) return res.status(404).json({ error: 'Lote não encontrado.' });
        const abs = resolverCaminho(lote.caminho_zip);
        if (!abs || !fs.existsSync(abs)) return res.status(410).json({ error: 'ZIP não está mais em disco.' });
        await db.query(`UPDATE evidencia_offload SET status='BAIXADO', baixado_em=NOW() WHERE id=? AND status='PRONTO'`, [lote.id]);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
        return fs.createReadStream(abs).pipe(res);
    } catch (err) {
        if (!res.headersSent) return res.status(500).json({ error: err.message });
        return res.end();
    }
}

async function offloadConfirmar(req, res) {
    try {
        const r = await offloadSvc.confirmarBaixa(req.params.id, { userId: req.user?.id });
        try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ }
        return res.json({ ok: true, ...r });
    } catch (err) {
        console.error('❌ [evidencias] offloadConfirmar:', err.code, '|', err.message);
        return res.status(err.code ? 400 : 500).json({ error: err.message });
    }
}

async function restaurar(req, res) {
    try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'Envie ao menos um arquivo de imagem.' });
        const dry = String(req.query.preflight || req.body?.preflight || '') === '1' || req.path.endsWith('/preflight');
        const resultados = await offloadSvc.restaurarArquivos(files, { dry, userId: req.user?.id });
        if (!dry) { try { req.io?.emit('server:sync', { resource: 'evidencias', targets: ['evidencias'] }); } catch { /* */ } }
        const casados = resultados.filter(r => r.match === 'sha256' || r.match === 'hash8').length;
        return res.json({ dry, total: resultados.length, casados, resultados });
    } catch (err) {
        console.error('❌ [evidencias] restaurar:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

// =============================================================================
// CORTE DO WHATSAPP — Fase 9 (§12, §13.5). Parâmetro em system_settings,
// prontidão calculada da aderência, e resumo diário MANUAL por obra.
// =============================================================================
let whatsappService = null;
try { whatsappService = require('../services/whatsappService'); } catch { /* opcional */ }

const getSetting = async (k, def) => {
    try { const [[r]] = await db.query('SELECT value FROM system_settings WHERE `key` = ?', [k]); return r ? r.value : def; }
    catch { return def; }
};
const setSetting = async (k, v) => {
    await db.query('INSERT INTO system_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?', [k, String(v), String(v)]);
};

// Últimos N dias úteis (pula domingo) terminando hoje.
function ultimosDiasUteis(n) {
    const out = []; const d = new Date();
    while (out.length < n) {
        if (d.getDay() !== 0) out.push(d.toLocaleDateString('en-CA'));
        d.setDate(d.getDate() - 1);
    }
    return out.reverse();
}

async function corteConfig(req, res) {
    if (req.method === 'PUT') {
        try {
            const b = req.body || {};
            if (b.pct != null) await setSetting('evid_corte_pct', Math.max(0, Math.min(100, Number(b.pct))));
            if (b.dias != null) await setSetting('evid_corte_dias', Math.max(1, Math.min(30, Number(b.dias))));
            return res.json({ ok: true });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    const pct = Number(await getSetting('evid_corte_pct', 90));
    const dias = Number(await getSetting('evid_corte_dias', 5));
    return res.json({ pct, dias });
}

async function corteStatus(req, res) {
    try {
        const obra_id = req.query.obra_id || null;
        const pctMeta = Number(await getSetting('evid_corte_pct', 90));
        const diasMeta = Number(await getSetting('evid_corte_dias', 5));
        const datas = ultimosDiasUteis(diasMeta);
        const dias = [];
        for (const data of datas) {
            const where = ['data_ref = ?']; const params = [data];
            if (obra_id) { where.push('obra_id = ?'); params.push(obra_id); }
            const [[r]] = await db.query(
                `SELECT COALESCE(SUM(cumpridas),0) AS cumpr, COALESCE(SUM(exigidas),0) AS exig
                   FROM evidencia_aderencia_dia WHERE ${where.join(' AND ')}`, params);
            const pct = r.exig > 0 ? Math.round((r.cumpr / r.exig) * 100) : null;
            dias.push({ data, pct, ok: pct != null && pct >= pctMeta });
        }
        const pronto = dias.length > 0 && dias.every(d => d.ok);
        return res.json({ pct_meta: pctMeta, dias_meta: diasMeta, pronto, dias });
    } catch (err) {
        console.error('❌ [evidencias] corteStatus:', err.message);
        return res.status(500).json({ error: 'Falha ao calcular prontidão.' });
    }
}

// Resumo diário por obra — o WhatsApp muda de papel: em vez de 800 fotos, um
// resumo com o link do painel. MANUAL: o gestor gera e (opcionalmente) envia.
async function resumoObra(req, res) {
    try {
        const b = req.body || {};
        const obra_id = (b.obra_id || '').trim();
        const data = (b.data || '').trim() || hojeRef();
        if (!obra_id) return res.status(400).json({ error: 'Obra obrigatória.' });
        const [[obra]] = await db.query('SELECT nome FROM obras WHERE id = ? LIMIT 1', [obra_id]);
        const [[ad]] = await db.query(
            `SELECT COUNT(*) AS eq, COALESCE(SUM(completo),0) AS ok, COALESCE(SUM(cumpridas),0) AS cumpr, COALESCE(SUM(exigidas),0) AS exig
               FROM evidencia_aderencia_dia WHERE obra_id = ? AND data_ref = ?`, [obra_id, data]);
        const [[pend]] = await db.query(
            `SELECT COUNT(*) AS n FROM evidencia_cobranca_fila WHERE obra_id = ? AND data_ref = ? AND status = 'PENDENTE'`, [obra_id, data]);
        const pct = ad.exig > 0 ? Math.round((ad.cumpr / ad.exig) * 100) : 0;
        const base = (process.env.APP_PUBLIC_URL || 'https://frotamak.com');
        const texto =
            `📸 Evidências de Campo — ${obra?.nome || obra_id} — ${data.split('-').reverse().join('/')}\n`
            + `Aderência: ${pct}% (${ad.ok}/${ad.eq} equipamentos completos)\n`
            + (pend.n > 0 ? `Pendentes: ${pend.n} evidência(s).\n` : `Sem pendências. ✅\n`)
            + `Painel: ${base}`;

        let enviado = false;
        if (b.to && whatsappService?.enviarMensagem) {
            try { await whatsappService.enviarMensagem(String(b.to), obra?.nome || '—', 'evidencia_resumo_obra', texto, null); enviado = true; }
            catch (e) { console.warn('[evid resumo] whatsapp:', e.message); }
        }
        return res.json({ texto, enviado });
    } catch (err) {
        console.error('❌ [evidencias] resumoObra:', err.message);
        return res.status(500).json({ error: 'Falha ao gerar resumo.' });
    }
}

module.exports = {
    ingest, meuEscopo, listar, detalhe, servirVariante,
    minhas, motivosDispensa, registrarDispensa,
    carimboEditar, carimboRemover, carimboRestaurar,
    getConfig, putConfig, aderencia, consolidar,
    cobrancasListar, cobrancaAprovar, cobrancasAprovarLote, cobrancaIgnorar,
    dossie,
    offloadListar, offloadGerar, offloadDownload, offloadConfirmar, restaurar,
    corteConfig, corteStatus, resumoObra,
};
