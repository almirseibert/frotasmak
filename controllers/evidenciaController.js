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
    diaSolicitado, somarDias,
} = require('../utils/evidenciaRegras');
const carimbo = require('../services/evidenciaCarimboService');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { getAllowedReadingTypes } = require('../utils/vehicleRules');
const aderenciaSvc = require('../services/evidenciaAderenciaService');
const offloadSvc = require('../services/evidenciaOffloadService');
const rotinaSvc = require('../services/evidenciaRotinaService');
const carimboCfgSvc = require('../services/evidenciaCarimboConfigService');
const { TIPOS_ROTINA, ROTINA_LABEL, projetarCalendario } = require('../utils/evidenciaRotinas');
const { loadHolidaySet } = require('../utils/businessDays');
let pushService = null;
try { pushService = require('../services/pushService'); } catch { /* opcional */ }

// Os 4 momentos do dia. Rotinas e 'extra' NÃO entram aqui: é este array que
// governa a contagem de aderência (4/4) e o corte do WhatsApp.
const MOMENTOS_DIA = ['horimetro_inicio', 'foto_manha', 'foto_tarde', 'horimetro_fim'];
const TIPOS_VALIDOS = [...MOMENTOS_DIA, 'extra', ...TIPOS_ROTINA];
const TIPOS_COM_LEITURA = ['horimetro_inicio', 'horimetro_fim'];

const MOMENTO_LABEL = {
    horimetro_inicio: 'Início do expediente',
    horimetro_fim: 'Fim do expediente',
    foto_manha: 'Trabalho (manhã)',
    foto_tarde: 'Trabalho (tarde)',
    extra: 'Extra',
    rotina_filtro: ROTINA_LABEL.rotina_filtro,
    rotina_graxa: ROTINA_LABEL.rotina_graxa,
};

// data_ref no fuso do contêiner (TZ=America/Sao_Paulo). 'en-CA' => YYYY-MM-DD.
const hojeRef = () => new Date().toLocaleDateString('en-CA');
const paraBr = (ymd) => (ymd ? String(ymd).slice(0, 10).split('-').reverse().join('/') : '');
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

// server:sync do módulo. O ingest antes fazia req.io.emit — BROADCAST para todos
// os sockets, inclusive os ~200 operadores, a cada foto. Agora vai só para a sala
// 'gestores' mais a sala do próprio remetente, que é quem precisa do refresh.
const syncEvidencias = (req) => {
    try { global.emitSync?.(['evidencias']); } catch { /* */ }
    try {
        if (req?.user?.id) req.io?.to('user:' + req.user.id).emit('server:sync', { targets: ['evidencias'] });
    } catch { /* */ }
};
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
        // A observação da foto extra era gravada e nunca exibida em lugar nenhum.
        linha_livre: r.ov_linha_extra || r.observacao || null,
        // Anexo retroativo: o carimbo reduzido só precisa do dia de referência.
        retroativo: r.origem_anexo === 'retroativo',
        dataRefBr: paraBr(r.data_ref),
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

        // --- Regra da obra ---
        const regra = await resolveRegraObra(db, obra_id);

        // --- data_ref e modo retroativo (decisão do SERVIDOR, nunca do cliente) ---
        const hoje = hojeRef();
        const devCap = b.dev_capturado_em ? new Date(b.dev_capturado_em) : new Date();
        const skewS = Math.round((Date.now() - devCap.getTime()) / 1000);
        let data_ref = (b.data_ref || '').trim() || hoje;
        if (data_ref > hoje) {
            limparUpload(f);
            return res.status(400).json({ error: 'Data de referência no futuro.', campo: 'data_ref' });
        }
        const retroativo = data_ref < hoje;
        if (retroativo) {
            const atraso = diasEntre(data_ref, hoje);
            if (atraso > regra.retroativo_max_dias) {
                limparUpload(f);
                return res.status(400).json({
                    error: `Só é possível anexar fotos dos últimos ${regra.retroativo_max_dias} dias.`,
                    campo: 'data_ref',
                });
            }
        } else if (Math.abs(skewS) > 3600) {
            // Relógio do aparelho muito fora → o servidor manda. NUNCA aplicar no
            // retroativo: aqui o skew é esperado (a foto é de outro dia) e isto
            // reescreveria data_ref para hoje, matando o anexo retroativo.
            data_ref = hoje;
        }

        // --- GPS: obrigatório no dia, PROIBIDO no retroativo ---
        // No retroativo os campos dev_* de localização são forçados a NULL mesmo
        // que o cliente os envie: uma foto de arquivo não tem onde foi tirada.
        const dev_lat = retroativo ? null : num(b.dev_latitude);
        const dev_lng = retroativo ? null : num(b.dev_longitude);
        if (!retroativo && regra.exigir_gps && (dev_lat == null || dev_lng == null)) {
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
            const rotulo = campoLeitura === 'horimetro' ? 'Horímetro' : 'Odômetro';

            if (retroativo) {
                if (!regra.retroativo_horimetro) {
                    limparUpload(f);
                    return res.status(400).json({ error: 'Esta obra não aceita leitura em anexo retroativo.', campo: 'leitura' });
                }
                // NÃO comparar com vehicles: uma leitura passada é menor por
                // definição. A validação útil é contra os VIZINHOS no histórico de
                // evidências — pega tanto o valor absurdo para baixo quanto o para
                // cima, que envenenaria qualquer MAX(horimetro) do módulo.
                const [[viz]] = await db.query(
                    `SELECT (SELECT MAX(${campoLeitura}) FROM evidencia_registro
                              WHERE veiculo_id = ? AND data_ref < ? AND ${campoLeitura} IS NOT NULL
                                AND estado <> 'descartado') AS antes,
                            (SELECT MIN(${campoLeitura}) FROM evidencia_registro
                              WHERE veiculo_id = ? AND data_ref > ? AND ${campoLeitura} IS NOT NULL
                                AND estado <> 'descartado') AS depois`,
                    [veiculo_id, data_ref, veiculo_id, data_ref]
                );
                const antes = viz?.antes != null ? Number(viz.antes) : null;
                const depois = viz?.depois != null ? Number(viz.depois) : null;
                const foraDaJanela = (antes != null && leitura < antes) || (depois != null && leitura > depois);
                if (foraDaJanela && String(b.confirmar_fora_janela) !== '1') {
                    limparUpload(f);
                    return res.status(400).json({
                        error: `${rotulo} fora da janela do histórico deste equipamento.`,
                        campo: campoLeitura, tipo: 'fora_da_janela',
                        valor_informado: leitura, valor_anterior: antes, valor_posterior: depois,
                    });
                }
                if (campoLeitura === 'horimetro') horimetro = leitura; else odometro = leitura;
                // ⛔ Sem updateVehicleReading: a leitura atual do equipamento NÃO muda.
            } else {
                const [[atualRow]] = await db.query(`SELECT ${campoLeitura} AS atual FROM vehicles WHERE id = ?`, [veiculo_id]);
                const atual = Number(atualRow?.atual || 0);
                if (leitura < atual) {
                    // Formato que os clientes já sabem tratar (regressão de leitura).
                    limparUpload(f);
                    return res.status(400).json({
                        error: `${rotulo} menor que o último registrado.`,
                        campo: campoLeitura, tipo: 'regressao',
                        valor_informado: leitura, valor_anterior: atual,
                    });
                }
                if (campoLeitura === 'horimetro') horimetro = leitura; else odometro = leitura;
                // Propaga ao veículo (só sobe — a própria função garante).
                await updateVehicleReading(db, veiculo_id, veic.tipo, leitura, campoLeitura);
            }
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

        // --- Dedup cross-operador (B2): um registro por (veículo, dia, tipo).
        //     Evita que operadores diferentes (com escopo offline defasado) enviem
        //     várias fotos do mesmo equipamento no mesmo dia. 'extra' continua
        //     livre (fotos adicionais são o ponto dela). Responde 200 com o
        //     registro existente (nunca erro), então a fila trata como "já feito"
        //     e descarta a foto redundante em silêncio. O card já mostra "Enviado".
        //
        //     Vale também para o anexo retroativo: a dedup é por data_ref, então
        //     mandar a foto de ontem não colide com a de hoje — só impede duas
        //     fotos do MESMO momento no MESMO dia.
        if (tipo !== 'extra') {
            const [[jaDoDia]] = await db.query(
                `SELECT id, stamp_version FROM evidencia_registro
                  WHERE veiculo_id = ? AND data_ref = ? AND tipo = ? AND estado <> 'descartado'
                  LIMIT 1`,
                [veiculo_id, data_ref, tipo]
            );
            if (jaDoDia) {
                limparUpload(f);
                return res.status(200).json({
                    jaExistia: true, duplicado: true,
                    id: jaDoDia.id,
                    urls: assinarTodas(jaDoDia.id, jaDoDia.stamp_version || 1),
                });
            }
        }

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
                horimetro, odometro, observacao, stamp_mode, stamp_version,
                origem_anexo, anexado_em, anexado_por)
             VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, 1, ?,?,?)`,
            [
                id, client_id, obra_id, veiculo_id, employee_id, req.user?.id || null, tipo, data_ref, turno,
                arquivo_rel, buf.length, f.mimetype, sha256, width, height,
                // No retroativo dev_capturado_em guarda o instante da ANEXAÇÃO: a
                // coluna é NOT NULL e é a chave de ordenação do arquivo. Quem conta
                // a verdade sobre a origem é origem_anexo.
                retroativo ? new Date() : devCap,
                dev_lat, dev_lng,
                retroativo ? null : num(b.dev_precisao_m),
                retroativo ? null : ((b.dev_local_texto || '').trim() || null),
                obraRow?.nome || null, equipLabel, operadorNome,
                retroativo ? null : skewS,
                (b.dev_origem || 'web_online'),
                horimetro, odometro, (b.observacao || '').trim() || null,
                retroativo ? 'reduzido' : 'carimbado',
                retroativo ? 'retroativo' : 'campo',
                retroativo ? new Date() : null,
                retroativo ? (req.user?.id || null) : null,
            ]
        );

        // thumb já; stamped/clean são preguiçosas
        try { await carimbo.gerarThumbIngest({ id, arquivo_rel, stamp_version: 1 }); } catch (e) { console.warn('⚠️ thumb ingest:', e.message); }

        // Fecha a ocorrência aberta da rotina, se for o caso.
        if (TIPOS_ROTINA.includes(tipo)) {
            try { await rotinaSvc.marcarCumprida(db, { veiculoId: veiculo_id, tipo, dataRef: data_ref, registroId: id }); }
            catch (e) { console.warn('⚠️ [evidencias] marcarCumprida:', e.message); }
        }

        // Anexo retroativo muda um dia JÁ consolidado — sem isto os números
        // daquele dia ficam errados até alguém clicar em "Consolidar" no admin.
        // consolidarDia é idempotente; projetarCobrancas NÃO é chamado aqui, senão
        // criaria cobrança nova para um dia velho.
        if (retroativo) {
            aderenciaSvc.consolidarDia(data_ref)
                .catch(e => console.warn('⚠️ [evidencias] reconsolidar retroativo:', e.message));
        }

        syncEvidencias(req);

        return res.status(201).json({ id, sha256, data_ref, retroativo, urls: assinarTodas(id, 1) });
    } catch (err) {
        limparUpload(f);
        console.error('❌ [evidencias] ingest:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao registrar evidência.' });
    }
}

// =============================================================================
// GET /api/evidencias/meu-escopo — pacote offline do operador (§3.5)
// =============================================================================
// Equipamentos das obras ativas do operador (mesmo escopo de
// vehicleDocumentsController). Extraído de meuEscopo porque o endpoint de
// histórico precisa da MESMA lista para validar acesso — sem isso um operador
// enumeraria o histórico de qualquer veículo da frota.
async function equipamentosDoOperador(userId) {
    const [[u]] = await db.query('SELECT employeeId FROM users WHERE id = ? LIMIT 1', [userId]);
    const employeeId = u?.employeeId || null;
    if (!employeeId) return { employeeId: null, equipamentos: [] };

    const [linhas] = await db.query(
        `SELECT DISTINCT v.id, v.placa, v.registroInterno, v.modelo, v.tipo,
                v.horimetro, v.odometro,
                h.obraId AS obra_id, h.employeeId AS operador_id,
                o.nome AS obra_nome, o.regiao, o.latitude, o.longitude,
                e.nome AS operador_nome
           FROM obras_historico_veiculos h
           JOIN vehicles v ON v.id = h.veiculoId
           LEFT JOIN obras o ON o.id = h.obraId
           LEFT JOIN employees e ON e.id = h.employeeId
          WHERE h.dataSaida IS NULL
            AND h.obraId IN (
                SELECT DISTINCT h2.obraId FROM obras_historico_veiculos h2
                 WHERE h2.employeeId = ? AND h2.dataSaida IS NULL
            )`,
        [employeeId]
    );

    // B1 — Equipamentos que JÁ SAÍRAM da obra recentemente (até 7 dias). Sem isto
    // o operador perde a chance de regularizar o último dia assim que a máquina
    // deixa a obra. Vêm marcados com saiuDaObra/saiuEm e a faixa de dias usa a
    // data de saída como último dia disponível.
    const [saidas] = await db.query(
        // ANY_VALUE nos campos do operador: o GROUP BY colapsa as estadias e o
        // sql_mode=only_full_group_by recusaria h.employeeId/e.nome soltos. Para o
        // card de um equipamento que já saiu, o operador é informativo.
        `SELECT v.id, v.placa, v.registroInterno, v.modelo, v.tipo,
                v.horimetro, v.odometro,
                h.obraId AS obra_id, ANY_VALUE(h.employeeId) AS operador_id,
                o.nome AS obra_nome, o.regiao, o.latitude, o.longitude,
                ANY_VALUE(e.nome) AS operador_nome,
                MAX(h.dataSaida) AS saiu_em
           FROM obras_historico_veiculos h
           JOIN vehicles v ON v.id = h.veiculoId
           LEFT JOIN obras o ON o.id = h.obraId
           LEFT JOIN employees e ON e.id = h.employeeId
          WHERE h.dataSaida IS NOT NULL
            AND h.dataSaida >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            AND h.obraId IN (
                SELECT DISTINCT h2.obraId FROM obras_historico_veiculos h2
                 WHERE h2.employeeId = ? AND h2.dataSaida IS NULL
            )
            AND h.veiculoId NOT IN (
                SELECT h3.veiculoId FROM obras_historico_veiculos h3
                 WHERE h3.dataSaida IS NULL
            )
          GROUP BY v.id, h.obraId`,
        [employeeId]
    );

    // Só equipamentos no escopo §2 (horímetro). Os que saíram vêm marcados.
    const ativos = linhas.filter(v => exigeEvidencia(v.tipo));
    const saiuFmt = saidas
        .filter(v => exigeEvidencia(v.tipo))
        .map(v => ({
            ...v,
            saiuDaObra: true,
            saiuEm: v.saiu_em ? new Date(v.saiu_em).toLocaleDateString('en-CA') : null,
        }));
    return { employeeId, equipamentos: [...ativos, ...saiuFmt] };
}

async function meuEscopo(req, res) {
    try {
        const data = hojeRef();
        const { employeeId, equipamentos } = await equipamentosDoOperador(req.user.id);
        if (!employeeId) return res.json({ data, obras: [], equipamentos: [], hojeEnviado: {}, hojeContagem: {}, rotinas: {} });

        const obraIds = [...new Set(equipamentos.map(v => v.obra_id).filter(Boolean))];
        const obras = [];
        const regraPorObra = {};
        const feriadosPorRegiao = {};
        for (const oid of obraIds) {
            const info = equipamentos.find(v => v.obra_id === oid);
            const regra = await resolveRegraObra(db, oid);
            regraPorObra[oid] = regra;
            const regiao = info?.regiao || null;
            if (!(regiao in feriadosPorRegiao)) {
                try { feriadosPorRegiao[regiao] = await loadHolidaySet(db, { regiao }); }
                catch { feriadosPorRegiao[regiao] = new Set(); }
            }
            obras.push({
                id: oid, nome: info?.obra_nome || null, regiao,
                latitude: info?.latitude ?? null, longitude: info?.longitude ?? null,
                regra,
                solicitado_hoje: diaSolicitado(data, regra, feriadosPorRegiao[regiao]),
            });
        }

        // O que já foi enviado na data de referência de cada equipamento: hoje para
        // os ativos, a data de saída para os que saíram da obra (B1). `hojeEnviado`
        // (array de tipos) é mantido por compatibilidade; `hojeContagem` é o que
        // permite N fotos extras no mesmo dia sem que o badge do equipamento fique
        // verde com 4 extras e nenhum momento cumprido.
        const hojeEnviado = {};
        const hojeContagem = {};
        if (equipamentos.length) {
            const ids = equipamentos.map(v => v.id);
            const dataPorVeic = {};
            equipamentos.forEach(v => { dataPorVeic[v.id] = (v.saiuDaObra && v.saiuEm) ? v.saiuEm : data; });
            const datas = [...new Set(Object.values(dataPorVeic))];
            const [envs] = await db.query(
                // Agrupado por (veículo, dia, tipo): a CONTAGEM é o que permite N
                // fotos extras no mesmo dia, e o filtro por data_ref é o que faz o
                // equipamento que saiu da obra ser medido no ÚLTIMO dia em que
                // esteve lá, não em hoje.
                `SELECT veiculo_id, tipo, data_ref, COUNT(*) AS n FROM evidencia_registro
                  WHERE estado <> 'descartado'
                    AND veiculo_id IN (${ids.map(() => '?').join(',')})
                    AND data_ref IN (${datas.map(() => '?').join(',')})
                  GROUP BY veiculo_id, tipo, data_ref`,
                [...ids, ...datas]
            );
            for (const e of envs) {
                const relevante = dataPorVeic[e.veiculo_id];
                const eData = e.data_ref instanceof Date
                    ? e.data_ref.toLocaleDateString('en-CA')
                    : String(e.data_ref).slice(0, 10);
                if (eData !== relevante) continue;
                (hojeEnviado[e.veiculo_id] = hojeEnviado[e.veiculo_id] || []).push(e.tipo);
                (hojeContagem[e.veiculo_id] = hojeContagem[e.veiculo_id] || {})[e.tipo] = Number(e.n);
            }
        }

        // Rotinas semanais abertas. A materialização roda aqui porque este é o
        // caminho que o operador percorre todo dia; em try/catch porque falhar
        // numa rotina não pode derrubar a tela inteira (mesma postura do
        // gerarThumbIngest). garantirAgenda é idempotente.
        const rotinas = {};
        for (const v of equipamentos) {
            const regra = regraPorObra[v.obra_id];
            if (!regra) continue;
            try {
                const cfg = await rotinaSvc.resolveRegraRotina(db, v.obra_id, v.id);
                rotinas[v.id] = await rotinaSvc.garantirAgenda(db, {
                    veiculoId: v.id, obraId: v.obra_id, dataRef: data,
                    diasSemana: regra.dias_semana,
                    feriadoSet: feriadosPorRegiao[v.regiao || null],
                    cfg,
                });
            } catch (e) {
                console.warn('⚠️ [evidencias] agenda de rotinas:', e.message);
                rotinas[v.id] = [];
            }
        }

        return res.json({ data, obras, equipamentos, hojeEnviado, hojeContagem, rotinas });
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
                    r.estado, r.stamp_version, r.dev_clock_skew_s, r.origem_anexo, r.anexado_em,
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
        // Config de campos nos 3 níveis (global/obra/veículo). Ficou como TODO
        // desde a Fase 2 com a tabela criada e nunca lida.
        try { r._campos = await carimboCfgSvc.resolveCampos(db, r.obra_id, r.veiculo_id); }
        catch { r._campos = {}; }
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
// GET /api/evidencias/historico?veiculo_id=&dias= — faixa de dias do operador
// Teto rígido de 30 dias: é payload de celular, não passa pelo teto de 92 do
// `listar`. Três queries na janela inteira + laço em JS — nada de N+1 por dia.
// =============================================================================
const HISTORICO_TETO_DIAS = 30;

async function historico(req, res) {
    try {
        const veiculoId = (req.query.veiculo_id || '').trim();
        if (!veiculoId) return res.status(400).json({ error: 'Equipamento obrigatório.' });

        const { equipamentos } = await equipamentosDoOperador(req.user.id);
        const equip = equipamentos.find(v => String(v.id) === veiculoId);
        if (!equip) return res.status(403).json({ error: 'Equipamento fora do seu escopo.' });

        const regra = await resolveRegraObra(db, equip.obra_id);
        let feriadoSet = new Set();
        try { feriadoSet = await loadHolidaySet(db, { regiao: equip.regiao || null }); } catch { /* */ }

        const hoje = hojeRef();
        // Equipamento que já saiu da obra (B1): a faixa termina no último dia em
        // que ele esteve lá. Sem isto a tela ofereceria dias em que o equipamento
        // nem estava na obra — e o operador registraria um dia que não existiu.
        const ultimoDia = (equip.saiuDaObra && equip.saiuEm && equip.saiuEm < hoje) ? equip.saiuEm : hoje;
        const pedido = parseInt(req.query.dias || regra.historico_dias, 10);
        const janela = Math.min(HISTORICO_TETO_DIAS, Math.max(1, isNaN(pedido) ? regra.historico_dias : pedido));
        const desde = somarDias(ultimoDia, -(janela - 1));

        const [regs] = await db.query(
            `SELECT data_ref, tipo, COUNT(*) AS n FROM evidencia_registro
              WHERE veiculo_id = ? AND data_ref BETWEEN ? AND ? AND estado <> 'descartado'
              GROUP BY data_ref, tipo`,
            [veiculoId, desde, ultimoDia]
        );
        const [disps] = await db.query(
            `SELECT data_ref, periodo, motivo_codigo, motivo_texto FROM evidencia_dispensa
              WHERE obra_id = ? AND (veiculo_id = ? OR veiculo_id IS NULL)
                AND data_ref BETWEEN ? AND ? AND revogada_em IS NULL`,
            [equip.obra_id, veiculoId, desde, ultimoDia]
        );
        const [rots] = await db.query(
            `SELECT tipo, data_prevista, status FROM evidencia_rotina_agenda
              WHERE veiculo_id = ? AND data_prevista BETWEEN ? AND ?`,
            [veiculoId, desde, ultimoDia]
        );

        const porDia = {};
        for (const r of regs) {
            const d = String(r.data_ref).slice(0, 10);
            (porDia[d] = porDia[d] || {})[r.tipo] = Number(r.n);
        }
        const dispPorDia = {};
        for (const d of disps) dispPorDia[String(d.data_ref).slice(0, 10)] = d;
        const rotPorDia = {};
        for (const r of rots) {
            const d = String(r.data_prevista).slice(0, 10);
            (rotPorDia[d] = rotPorDia[d] || []).push({ tipo: r.tipo, status: r.status, label: ROTINA_LABEL[r.tipo] });
        }

        const exigidos = (regra.momentos_exigidos || MOMENTOS_DIA).filter(m => MOMENTOS_DIA.includes(m));
        const dias = [];
        for (let i = 0; i < janela; i++) {
            const data = somarDias(desde, i);
            const contagem = porDia[data] || {};
            const enviados = Object.keys(contagem);
            const solicitado = diaSolicitado(data, regra, feriadoSet);
            const atraso = diasEntre(data, hoje);
            const cumpridas = exigidos.filter(m => contagem[m]).length;
            dias.push({
                data,
                dow: new Date(`${data}T12:00:00`).getDay(),
                solicitado,
                feriado: feriadoSet.has(data),
                dispensado: !!dispPorDia[data],
                dispensa: dispPorDia[data] || null,
                momentos: exigidos,
                contagem,
                enviados,
                extras: contagem.extra || 0,
                rotinas: rotPorDia[data] || [],
                exigidas: solicitado ? exigidos.length : 0,
                cumpridas,
                completo: solicitado ? cumpridas >= exigidos.length : true,
                // Hoje não é "retroativo" — é o fluxo normal, com câmera e GPS.
                retroativo_permitido: atraso > 0 && atraso <= regra.retroativo_max_dias,
            });
        }

        // Janela de leitura para o aviso de "horímetro anterior": o front pré-valida
        // com isto, porque um 400 depois de enfileirar vira `recusado` silencioso.
        const campoLeitura = getAllowedReadingTypes(equip.tipo)[0];
        const [[viz]] = await db.query(
            `SELECT MIN(${campoLeitura}) AS minimo, MAX(${campoLeitura}) AS maximo
               FROM evidencia_registro
              WHERE veiculo_id = ? AND ${campoLeitura} IS NOT NULL AND estado <> 'descartado'`,
            [veiculoId]
        );

        return res.json({
            veiculo_id: veiculoId,
            obra_id: equip.obra_id,
            hoje,
            // Para equipamento que saiu da obra, ultimo_dia < hoje: a faixa termina
            // no último dia em que ele esteve lá e tudo nela é retroativo.
            ultimo_dia: ultimoDia,
            saiu_da_obra: !!equip.saiuDaObra,
            saiu_em: equip.saiuEm || null,
            janela_dias: janela,
            retroativo_max_dias: regra.retroativo_max_dias,
            retroativo_horimetro: regra.retroativo_horimetro,
            permitir_galeria: regra.permitir_galeria,
            campo_leitura: campoLeitura,
            leitura_atual: equip[campoLeitura] != null ? Number(equip[campoLeitura]) : null,
            leitura_min: viz?.minimo != null ? Number(viz.minimo) : null,
            leitura_max: viz?.maximo != null ? Number(viz.maximo) : null,
            dias: dias.reverse(), // mais recente primeiro
        });
    } catch (err) {
        console.error('❌ [evidencias] historico:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar o histórico.' });
    }
}

// =============================================================================
// POST /api/evidencias/divergencia — operador avisa que o escopo está errado
// Grava em operational_requests, que existe exatamente para "sugerir ao admin a
// real obra/operador de um veículo" e já tem aba própria + pop-up no admin.
// Não usa POST /api/operationalRequests porque aquela rota é montada ACIMA do
// authMiddleware (server.js:2364 vs 2372): req.user chegaria vazio e o reporte
// sairia sem solicitante.
// =============================================================================
const MOTIVO_DIVERGENCIA = {
    faltando: 'Equipamento na obra não aparece na lista',
    saiu: 'Equipamento já saiu da obra e continua na lista',
    operador_errado: 'Operador do equipamento está errado',
    outro: 'Outra divergência',
};

async function divergencia(req, res) {
    try {
        const b = req.body || {};
        const motivo = MOTIVO_DIVERGENCIA[b.motivo] ? b.motivo : 'outro';
        const obra_id = (b.obra_id || '').trim();
        const veiculo_id = (b.veiculo_id || '').trim() || null;
        const texto = (b.texto || '').trim();
        if (!obra_id) return res.status(400).json({ error: 'Obra obrigatória.' });
        if (!texto) return res.status(400).json({ error: 'Descreva a divergência.', campo: 'texto' });

        // Anti-repique: o operador cansado de esperar reenvia o mesmo aviso.
        const [[recente]] = await db.query(
            `SELECT id FROM operational_requests
              WHERE tipo = 'divergencia_evidencias' AND solicitante_id = ? AND obra_atual_id = ?
                AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE) LIMIT 1`,
            [String(req.user?.id || ''), obra_id]
        );
        if (recente) {
            return res.status(429).json({ error: 'Você acabou de enviar um aviso desta obra. Aguarde alguns minutos.' });
        }

        const [[obra]] = await db.query('SELECT nome FROM obras WHERE id = ? LIMIT 1', [obra_id]);
        let veicLabel = null, operadorNome = null;
        if (veiculo_id) {
            const [[v]] = await db.query(
                `SELECT v.registroInterno, v.placa, v.modelo, e.nome AS operador
                   FROM vehicles v
                   LEFT JOIN obras_historico_veiculos h ON h.veiculoId = v.id AND h.dataSaida IS NULL
                   LEFT JOIN employees e ON e.id = h.employeeId
                  WHERE v.id = ? LIMIT 1`, [veiculo_id]);
            veicLabel = [v?.registroInterno, v?.placa].filter(Boolean).join(' · ') || v?.modelo || null;
            operadorNome = v?.operador || null;
        }

        const [result] = await db.query(
            `INSERT INTO operational_requests
               (tipo, veiculo_id, veiculo_registro, obra_atual_id, obra_atual_nome,
                operador_atual_nome, valor_sugerido_id, valor_sugerido_nome, observacao,
                status, solicitante_id, solicitante_email)
             VALUES ('divergencia_evidencias', ?,?,?,?,?, NULL, ?, ?, 'pendente', ?, ?)`,
            [veiculo_id || '', veicLabel, obra_id, obra?.nome || null, operadorNome,
             MOTIVO_DIVERGENCIA[motivo], texto,
             req.user?.id || null, req.user?.email || null]
        );

        // Os dois eventos que a aba Requisições do admin já consome.
        try { req.io?.emit('server:sync', { targets: ['operationalRequests'] }); } catch { /* */ }
        try {
            req.io?.emit('admin:notificacao', {
                tipo: 'requisicao_operacional',
                mensagem: `Evidências: ${MOTIVO_DIVERGENCIA[motivo].toLowerCase()} na obra ${obra?.nome || obra_id}.`,
            });
        } catch { /* */ }

        return res.status(201).json({ id: result.insertId });
    } catch (err) {
        console.error('❌ [evidencias] divergencia:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao registrar o aviso.' });
    }
}

// =============================================================================
// GET /api/evidencias/veiculo/:vehicleId/calendario — quadro por equipamento (B4)
// Por data em que o equipamento esteve na obra (últimos 30 dias), diz se as
// imagens foram enviadas, faltam, ou o dia foi dispensado.
// =============================================================================
async function veiculoCalendario(req, res) {
    try {
        const veiculoId = req.params.vehicleId;

        // Mesma checagem de escopo do /historico: sem ela um operador enumeraria
        // o calendário de qualquer veículo da frota, não só dos seus.
        const { equipamentos } = await equipamentosDoOperador(req.user.id);
        if (!equipamentos.some(v => String(v.id) === String(veiculoId))) {
            return res.status(403).json({ error: 'Equipamento fora do seu escopo.' });
        }

        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        const janelaIni = new Date(hoje); janelaIni.setDate(janelaIni.getDate() - 29);

        // Estadias do equipamento em obra (para saber em quais dias ele esteve lá).
        const [stays] = await db.query(
            `SELECT dataEntrada, dataSaida FROM obras_historico_veiculos
              WHERE veiculoId = ? AND dataEntrada IS NOT NULL
              ORDER BY dataEntrada DESC LIMIT 30`,
            [veiculoId]
        );

        const diasNaObra = new Set();
        for (const s of stays) {
            const ent = new Date(s.dataEntrada); ent.setHours(0, 0, 0, 0);
            const sai = s.dataSaida ? new Date(s.dataSaida) : new Date(hoje); sai.setHours(0, 0, 0, 0);
            let d = new Date(Math.max(ent.getTime(), janelaIni.getTime()));
            const fim = new Date(Math.min(sai.getTime(), hoje.getTime()));
            for (; d <= fim; d.setDate(d.getDate() + 1)) diasNaObra.add(d.toLocaleDateString('en-CA'));
        }
        if (diasNaObra.size === 0) return res.json({ dias: [] });

        const datas = [...diasNaObra].sort();
        const min = datas[0], max = datas[datas.length - 1];
        const key = (v) => (v instanceof Date ? v.toLocaleDateString('en-CA') : String(v).slice(0, 10));

        const [regs] = await db.query(
            `SELECT data_ref, tipo FROM evidencia_registro
              WHERE veiculo_id = ? AND estado <> 'descartado' AND data_ref BETWEEN ? AND ?`,
            [veiculoId, min, max]
        );
        const [disp] = await db.query(
            `SELECT data_ref FROM evidencia_dispensa
              WHERE (veiculo_id = ? OR veiculo_id IS NULL) AND revogada_em IS NULL
                AND data_ref BETWEEN ? AND ?`,
            [veiculoId, min, max]
        );

        const FIXOS = ['horimetro_inicio', 'horimetro_fim', 'foto_manha', 'foto_tarde'];
        const porDia = {};
        regs.forEach(r => { const k = key(r.data_ref); (porDia[k] = porDia[k] || new Set()).add(r.tipo); });
        const dispDia = new Set(disp.map(d => key(d.data_ref)));

        const dias = datas.map(d => {
            const tipos = porDia[d] || new Set();
            const enviados = FIXOS.filter(t => tipos.has(t)).length;
            let status;
            if (dispDia.has(d)) status = 'dispensado';
            else if (enviados >= 4) status = 'completo';
            else if (enviados > 0) status = 'parcial';
            else status = 'faltando';
            return { data: d, enviados, exigidas: 4, status };
        });

        return res.json({ dias });
    } catch (err) {
        console.error('❌ [evidencias] calendario:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha ao carregar o calendário do equipamento.' });
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
        syncEvidencias(req);
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
        syncEvidencias(req);
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
        syncEvidencias(req);
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
        const faixa = (v, min, max, def) => {
            if (v == null || v === '') return def;
            const n = Number(v);
            return isNaN(n) ? def : Math.max(min, Math.min(max, n));
        };
        await db.query(
            `INSERT INTO evidencia_config (obra_id, momentos_exigidos, horarios_limite, dias_semana, raio_cerca_m,
                exigir_gps, permitir_galeria, ativa, retroativo_max_dias, retroativo_horimetro, historico_dias)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE momentos_exigidos=VALUES(momentos_exigidos), horarios_limite=VALUES(horarios_limite),
               dias_semana=VALUES(dias_semana), raio_cerca_m=VALUES(raio_cerca_m), exigir_gps=VALUES(exigir_gps),
               permitir_galeria=VALUES(permitir_galeria), ativa=VALUES(ativa),
               retroativo_max_dias=VALUES(retroativo_max_dias), retroativo_horimetro=VALUES(retroativo_horimetro),
               historico_dias=VALUES(historico_dias)`,
            [req.params.obraId,
             JSON.stringify(b.momentos_exigidos || null), JSON.stringify(b.horarios_limite || null),
             JSON.stringify(b.dias_semana || null), b.raio_cerca_m ?? 500,
             b.exigir_gps === false ? 0 : 1, b.permitir_galeria === true ? 1 : 0, b.ativa === false ? 0 : 1,
             faixa(b.retroativo_max_dias, 0, 60, null),
             b.retroativo_horimetro == null ? null : (b.retroativo_horimetro === false ? 0 : 1),
             faixa(b.historico_dias, 1, 30, null)]
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
    rotina_filtro: 'foto da limpeza de filtro', rotina_graxa: 'foto do engraxamento',
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
        syncEvidencias(req);
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
        syncEvidencias(req);
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
            r._dados = montarDados(r);
            try { r._campos = await carimboCfgSvc.resolveCampos(db, r.obra_id, r.veiculo_id); }
            catch { r._campos = {}; }
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
        syncEvidencias(req);
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
        syncEvidencias(req);
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
        if (!dry) { syncEvidencias(req); }
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

// Últimos N dias úteis terminando hoje.
//
// ⚠️ Antes pulava SÓ domingo. Quando o sábado deixou de ser dia de solicitação
// (Fase 10), ele passou a consolidar com exigidas=0 — e aí corteStatus calculava
// pct=null → ok=false → `pronto` NUNCA mais ficaria verde. Pular sábado também
// (e feriados, quando o Set é informado) é o que mantém o corte funcionando.
function ultimosDiasUteis(n, feriadoSet = null) {
    const out = []; const d = new Date();
    for (let i = 0; i < 400 && out.length < n; i++) {
        const ymd = d.toLocaleDateString('en-CA');
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6 && !(feriadoSet && feriadoSet.has(ymd))) out.push(ymd);
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
        let feriadoSet = null;
        if (obra_id) {
            try {
                const [[o]] = await db.query('SELECT regiao FROM obras WHERE id = ? LIMIT 1', [obra_id]);
                feriadoSet = await loadHolidaySet(db, { regiao: o?.regiao || null });
            } catch { /* */ }
        }
        const datas = ultimosDiasUteis(diasMeta, feriadoSet);
        const dias = [];
        for (const data of datas) {
            const where = ['data_ref = ?']; const params = [data];
            if (obra_id) { where.push('obra_id = ?'); params.push(obra_id); }
            const [[r]] = await db.query(
                `SELECT COALESCE(SUM(cumpridas),0) AS cumpr, COALESCE(SUM(exigidas),0) AS exig
                   FROM evidencia_aderencia_dia WHERE ${where.join(' AND ')}`, params);
            // exig = 0 significa "nada era exigido neste dia" (dia não solicitado ou
            // tudo dispensado) — isso é conformidade, não falha. Antes virava
            // pct=null → ok=false e travava a prontidão do corte.
            const pct = r.exig > 0 ? Math.round((r.cumpr / r.exig) * 100) : null;
            dias.push({ data, pct, sem_exigencia: r.exig == 0, ok: pct == null || pct >= pctMeta });
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

// =============================================================================
// CONFIG DAS ROTINAS SEMANAIS (3 níveis) + pré-visualização
// =============================================================================
async function rotinasConfig(req, res) {
    try {
        const escopo = ['global', 'obra', 'veiculo'].includes(req.query.escopo || req.body?.escopo)
            ? (req.query.escopo || req.body.escopo) : 'global';
        const escopoId = String((req.query.escopo_id ?? req.body?.escopo_id) || '');

        if (req.method === 'PUT') {
            const b = req.body || {};
            await rotinaSvc.salvarRegraRotina(db, {
                escopo, escopo_id: escopoId,
                ativa: b.ativa,
                freq_dias: b.freq_dias == null ? null : Math.max(2, Math.min(60, Number(b.freq_dias))),
                defasagem_dias: b.defasagem_dias == null ? null : Math.max(1, Math.min(30, Number(b.defasagem_dias))),
                carry_dias: b.carry_dias == null ? null : Math.max(0, Math.min(30, Number(b.carry_dias))),
                alternar_ordem: b.alternar_ordem,
                tipos: Array.isArray(b.tipos) ? b.tipos : null,
            });
            return res.json({ ok: true });
        }

        // Devolve a linha CRUA do nível (para o formulário saber o que é herdado)
        // e a regra EFETIVA resolvida (para o gestor ver o que vale de fato).
        const [[row]] = await db.query(
            'SELECT * FROM evidencia_rotina_config WHERE escopo = ? AND escopo_id = ? LIMIT 1',
            [escopo, escopoId]
        );
        let obraId = null, veiculoId = null;
        if (escopo === 'obra') obraId = escopoId;
        if (escopo === 'veiculo') {
            veiculoId = escopoId;
            const [[h]] = await db.query(
                'SELECT obraId FROM obras_historico_veiculos WHERE veiculoId = ? AND dataSaida IS NULL LIMIT 1',
                [escopoId]);
            obraId = h?.obraId || null;
        }
        const efetiva = await rotinaSvc.resolveRegraRotina(db, obraId, veiculoId);
        return res.json({ escopo, escopo_id: escopoId, propria: row || null, efetiva });
    } catch (err) {
        console.error('❌ [evidencias] rotinasConfig:', err.code, '|', err.sqlMessage || err.message);
        return res.status(500).json({ error: 'Falha na configuração de rotinas.' });
    }
}

// O agendador é determinístico e por isso invisível: sem esta prévia o gestor
// configuraria às cegas e só descobriria o efeito semanas depois.
async function rotinasPreview(req, res) {
    try {
        const veiculoId = (req.query.veiculo_id || '').trim();
        if (!veiculoId) return res.status(400).json({ error: 'Equipamento obrigatório.' });
        const de = (req.query.de || '').trim() || hojeRef();
        const ate = (req.query.ate || '').trim() || somarDias(de, 30);

        const [[h]] = await db.query(
            `SELECT h.obraId, o.regiao FROM obras_historico_veiculos h
               LEFT JOIN obras o ON o.id = h.obraId
              WHERE h.veiculoId = ? AND h.dataSaida IS NULL LIMIT 1`, [veiculoId]);
        const obraId = h?.obraId || null;
        const regra = await resolveRegraObra(db, obraId);
        const cfg = await rotinaSvc.resolveRegraRotina(db, obraId, veiculoId);
        let feriadoSet = new Set();
        try { feriadoSet = await loadHolidaySet(db, { regiao: h?.regiao || null }); } catch { /* */ }

        const itens = projetarCalendario(veiculoId, de, ate, {
            diasSemana: regra.dias_semana, feriadoSet, cfg,
        });
        return res.json({ veiculo_id: veiculoId, de, ate, cfg, dias_semana: regra.dias_semana, itens });
    } catch (err) {
        console.error('❌ [evidencias] rotinasPreview:', err.message);
        return res.status(500).json({ error: 'Falha ao projetar as rotinas.' });
    }
}

// =============================================================================
// CONFIG DE CAMPOS DO CARIMBO (3 níveis) + pré-visualização em imagem
// =============================================================================
async function carimboConfig(req, res) {
    try {
        const escopo = ['global', 'obra', 'veiculo'].includes(req.query.escopo || req.body?.escopo)
            ? (req.query.escopo || req.body.escopo) : 'global';
        const escopoId = String((req.query.escopo_id ?? req.body?.escopo_id) || '');
        if (req.method === 'PUT') {
            const campos = await carimboCfgSvc.salvarCampos(db, escopo, escopoId, req.body?.campos || {});
            return res.json({ ok: true, campos });
        }
        const propria = await carimboCfgSvc.lerCampos(db, escopo, escopoId);
        const efetiva = await carimboCfgSvc.resolveCampos(db,
            escopo === 'obra' ? escopoId : null,
            escopo === 'veiculo' ? escopoId : null);
        return res.json({ escopo, escopo_id: escopoId, chaves: carimboCfgSvc.CHAVES_CAMPO, propria, efetiva });
    } catch (err) {
        console.error('❌ [evidencias] carimboConfig:', err.message);
        return res.status(500).json({ error: 'Falha na configuração do carimbo.' });
    }
}

// Gera uma imagem sintética pelo MESMO caminho de render das fotos reais. Sem
// isto o admin edita os campos às cegas e só vê o resultado na próxima foto.
async function carimboPreview(req, res) {
    try {
        const sharp = require('sharp');
        const escopo = req.query.escopo || 'global';
        const escopoId = String(req.query.escopo_id || '');
        const campos = await carimboCfgSvc.resolveCampos(db,
            escopo === 'obra' ? escopoId : null,
            escopo === 'veiculo' ? escopoId : null);
        const reduzido = String(req.query.reduzido) === '1';

        const dados = {
            dataHora: new Date().toLocaleString('pt-BR', { hour12: false }),
            latitude: -29.4521, longitude: -51.9633, precisao_m: 8,
            distancia_obra_m: 120, obra: 'Obra de exemplo',
            equipamento: 'MAK-000 · ABC1D23', operador: 'Operador de exemplo',
            leitura: 'Horímetro 4.812,50 h', codigo: 'EV-PREVIEW0',
            momentoLabel: MOMENTO_LABEL.horimetro_inicio,
            linha_livre: null, dataRefBr: paraBr(somarDias(hojeRef(), -3)),
        };
        const linhas = carimbo.montarLinhas(dados, campos, { reduzido });
        const W = 900, H = 600;
        // Duas faixas (clara e escura) para conferir a legibilidade do contorno.
        const clara = await sharp({ create: { width: W, height: Math.round(H / 2), channels: 3, background: '#efeeea' } }).png().toBuffer();
        const base = await sharp({ create: { width: W, height: H, channels: 3, background: '#25301a' } })
            .composite([{ input: clara, top: Math.round(H / 2), left: 0 }]).png().toBuffer();
        const buf = await sharp(base)
            .composite([{ input: carimbo.montarSvgTexto(W, H, linhas), top: 0, left: 0 }])
            .jpeg({ quality: 85 }).toBuffer();

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(buf);
    } catch (err) {
        console.error('❌ [evidencias] carimboPreview:', err.message);
        return res.status(500).end();
    }
}

module.exports = {
    ingest, meuEscopo, listar, detalhe, servirVariante,
    minhas, historico, veiculoCalendario, divergencia, motivosDispensa, registrarDispensa,
    carimboEditar, carimboRemover, carimboRestaurar,
    getConfig, putConfig, aderencia, consolidar,
    rotinasConfig, rotinasPreview, carimboConfig, carimboPreview,
    cobrancasListar, cobrancaAprovar, cobrancasAprovarLote, cobrancaIgnorar,
    dossie,
    offloadListar, offloadGerar, offloadDownload, offloadConfirmar, restaurar,
    corteConfig, corteStatus, resumoObra,
};
