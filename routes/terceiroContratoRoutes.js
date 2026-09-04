// routes/terceiroContratoRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/terceiroContratoController');
const aditivos = require('../controllers/terceiroContratoAditivoController');

// ── Upload do contrato ASSINADO (PDF imutável) ────────────────────────────────
// Diretório próprio; filename único (nunca sobrescreve) para preservar histórico.
const ASSINADOS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'contratos_assinados');
if (!fs.existsSync(ASSINADOS_DIR)) fs.mkdirSync(ASSINADOS_DIR, { recursive: true });

const storageAssinado = multer.diskStorage({
    destination: (req, file, cb) => cb(null, ASSINADOS_DIR),
    filename: (req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `assinado-${req.params.id}-${unique}.pdf`);
    },
});
const uploadAssinado = multer({
    storage: storageAssinado,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.pdf') return cb(null, true);
        cb(new Error('Apenas PDF é permitido para o contrato assinado.'));
    },
});

// Termo aditivo assinado: mesmo diretório e mesmas regras do contrato assinado,
// prefixo próprio no filename para identificar o documento pelo arquivo.
const storageAditivo = multer.diskStorage({
    destination: (req, file, cb) => cb(null, ASSINADOS_DIR),
    filename: (req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `aditivo-${req.params.aditivoId}-${unique}.pdf`);
    },
});
const uploadAditivo = multer({
    storage: storageAditivo,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.pdf') return cb(null, true);
        cb(new Error('Apenas PDF é permitido para o termo aditivo assinado.'));
    },
});

router.use(authMiddleware);

router.get('/', controller.getTerceiroContratos);
router.post('/', controller.createTerceiroContrato);
router.put('/:id', controller.updateTerceiroContrato);
router.delete('/:id', controller.deleteTerceiroContrato);
router.post('/:id/pdf', controller.gerarContratoPdf);

// Contrato assinado (documento oficial vigente) + histórico.
router.get('/:id/docs', controller.getContratoDocs);
router.post('/:id/assinado', uploadAssinado.single('file'), controller.enviarContratoAssinado);
router.delete('/:id/assinado', controller.removerContratoAssinado);

// Máquinas do contrato: vínculo operacional, editável mesmo com contrato assinado.
router.put('/:id/maquinas', controller.updateMaquinasContrato);

// ── Termos aditivos ───────────────────────────────────────────────────────────
// Só sobre contrato assinado. O delta entra nos números vigentes apenas quando o
// termo aditivo ASSINADO é enviado.
router.get('/:id/aditivos', aditivos.getAditivos);
router.post('/:id/aditivos', aditivos.createAditivo);
router.put('/:id/aditivos/:aditivoId', aditivos.updateAditivo);
router.delete('/:id/aditivos/:aditivoId', aditivos.deleteAditivo);
router.post('/:id/aditivos/:aditivoId/pdf', aditivos.gerarAditivoPdf);
router.post('/:id/aditivos/:aditivoId/assinado', uploadAditivo.single('file'), aditivos.enviarAditivoAssinado);
router.delete('/:id/aditivos/:aditivoId/assinado', aditivos.removerAditivoAssinado);

// Tratamento de erro do Multer (tipo/ tamanho de arquivo).
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.includes('permitido')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

module.exports = router;
