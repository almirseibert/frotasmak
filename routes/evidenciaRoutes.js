// backend/routes/evidenciaRoutes.js
// Rotas PROTEGIDAS do módulo Evidências de Campo (montadas abaixo do authMiddleware).
const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireAnyPage } = require('../utils/permissions');
const { SUBDIRS, garantirDirs } = require('../utils/evidenciaRegras');
const ctrl = require('../controllers/evidenciaController');

garantirDirs();

const router = express.Router();

// Guardas no padrão do par app/gestor (routes/solicitacaoRoutes.js).
const requireApp = requireAnyPage(['evidencias_app', 'admin_solicitacoes_app']);
const requireGestor = requireAnyPage(['admin_evidencias', 'admin_solicitacoes']);
// Edição de carimbo (§5.2) é mais restrita: só quem tem a página de gestão de
// evidências (admin/gerência/faturamento/supervisor), não o abastecimento.
const requireEditorCarimbo = requireAnyPage(['admin_evidencias']);

// --- Multer: destino inbox, teto 12 MB. Mensagem de recusa CONTÉM "arquivo" ---
// (server.js:2237 só converte para 400 quando err.message inclui "arquivo").
const storage = multer.diskStorage({
    destination: (req, file, cb) => { garantirDirs(); cb(null, SUBDIRS.inbox); },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `ev-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
});
const fileFilter = (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (ok.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Arquivo inválido: apenas imagens JPEG, PNG, WEBP ou HEIC.'), false);
};
const upload = multer({
    storage, fileFilter,
    limits: { fileSize: parseInt(process.env.EVIDENCIA_MAX_MB || '12', 10) * 1024 * 1024 },
});

// Restauração: arquivos em memória (casamento por sha256 dos bytes).
const uploadRestore = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: 20 * 1024 * 1024, files: 500 },
});

// ---- App (operador) ----
router.post('/', requireApp, upload.single('foto'), ctrl.ingest);
router.get('/meu-escopo', requireApp, ctrl.meuEscopo);
router.get('/minhas', requireApp, ctrl.minhas);
// Faixa de dias do equipamento (valida o escopo do operador lá dentro).
router.get('/historico', requireApp, ctrl.historico);
// Quadro por equipamento (30 dias). Mais enxuto que /historico e sem checagem de
// escopo — é a versão que a tela usava antes da faixa de dias.
router.get('/veiculo/:vehicleId/calendario', requireApp, ctrl.veiculoCalendario);
router.get('/motivos-dispensa', requireApp, ctrl.motivosDispensa);
router.post('/dispensa', requireApp, ctrl.registrarDispensa);
// Aviso de divergência de escopo (equipamento faltando/sobrando, operador errado).
router.post('/divergencia', requireApp, ctrl.divergencia);

// ---- Gestor: consolidação, aderência, cobrança manual, config ----
// (declaradas ANTES de '/:id' para não serem capturadas pela rota paramétrica)
router.get('/aderencia', requireGestor, ctrl.aderencia);
router.post('/consolidar', requireGestor, ctrl.consolidar);
router.get('/cobrancas', requireGestor, ctrl.cobrancasListar);
router.post('/cobrancas/aprovar-lote', requireGestor, ctrl.cobrancasAprovarLote);
router.post('/cobrancas/:id/aprovar', requireGestor, ctrl.cobrancaAprovar);
router.put('/cobrancas/:id/ignorar', requireGestor, ctrl.cobrancaIgnorar);
router.get('/config/:obraId', requireGestor, ctrl.getConfig);
router.put('/config/:obraId', requireGestor, ctrl.putConfig);
// Rotinas semanais: config em 3 níveis + prévia do calendário determinístico.
router.get('/rotinas/config', requireGestor, ctrl.rotinasConfig);
router.put('/rotinas/config', requireGestor, ctrl.rotinasConfig);
router.get('/rotinas/preview', requireGestor, ctrl.rotinasPreview);
// Campos do carimbo: leitura para qualquer gestor, escrita só para quem edita
// carimbo — mesmo split de corte/config (linhas 66-67).
router.get('/carimbo/config', requireGestor, ctrl.carimboConfig);
router.put('/carimbo/config', requireEditorCarimbo, ctrl.carimboConfig);
router.get('/carimbo/preview', requireGestor, ctrl.carimboPreview);
router.post('/dossie', requireGestor, ctrl.dossie);
// Corte do WhatsApp (Fase 9) — parâmetro, prontidão e resumo manual.
router.get('/corte/config', requireGestor, ctrl.corteConfig);
router.put('/corte/config', requireEditorCarimbo, ctrl.corteConfig);
router.get('/corte/status', requireGestor, ctrl.corteStatus);
router.post('/resumo-obra', requireGestor, ctrl.resumoObra);

// ---- Offload / arquivamento (admin — apaga originais na confirmação) ----
router.get('/offload', requireEditorCarimbo, ctrl.offloadListar);
router.post('/offload', requireEditorCarimbo, ctrl.offloadGerar);
router.get('/offload/:id/zip', requireEditorCarimbo, ctrl.offloadDownload);
router.post('/offload/:id/confirmar', requireEditorCarimbo, ctrl.offloadConfirmar);
router.post('/restaurar/preflight', requireEditorCarimbo, uploadRestore.array('arquivos'), ctrl.restaurar);
router.post('/restaurar', requireEditorCarimbo, uploadRestore.array('arquivos'), ctrl.restaurar);

// ---- Gestor: arquivo ----
router.get('/', requireGestor, ctrl.listar);
router.get('/:id', requireGestor, ctrl.detalhe);

// ---- Edição de carimbo: admin/gerência (§5.2) ----
router.put('/:id/carimbo', requireEditorCarimbo, ctrl.carimboEditar);
router.delete('/:id/carimbo', requireEditorCarimbo, ctrl.carimboRemover);
router.post('/:id/carimbo/restaurar', requireEditorCarimbo, ctrl.carimboRestaurar);

module.exports = router;
