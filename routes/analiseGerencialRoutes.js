const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/analiseGerencialController');
const pontoCtrl = require('../controllers/pontoEspelhoController');
const multer = require('multer');
const { canUserAccessPage } = require('../utils/permissions');

// Acesso à Análise Gerencial pela fonte única (page 'analise_gerencial'),
// mais a flag por-usuário canAccessAnaliseGerencial como concessão extra.
// (authMiddleware já foi aplicado globalmente em server.js antes de chegar aqui.)
const requireAnaliseAccess = (req, res, next) => {
    if (canUserAccessPage(req.user, 'analise_gerencial') || (req.user && req.user.canAccessAnaliseGerencial)) {
        return next();
    }
    return res.status(403).json({ error: 'Acesso negado à Análise Gerencial.' });
};

router.use(requireAnaliseAccess);

router.get('/discrepancias/obras', ctrl.obrasOverview);
router.get('/discrepancias/obra/:obraId', ctrl.obraDetalhe);
router.get('/discrepancias/:id', ctrl.discrepanciaDrill);
router.post('/discrepancias/:id/justificar', ctrl.justificar);
router.post('/discrepancias/reprocessar', ctrl.reprocessar);
router.get('/jornadas/operador/:employeeId', ctrl.jornadasOperador);
router.get('/projecao/:obraId', ctrl.getProjecaoObra);

// Espelho de ponto (trilha "Ponto" das jornadas). O arquivo fica só em memória:
// é lido pelo modelo e descartado, nada vai para public/uploads.
const uploadEspelho = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(
        null, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    ),
});
router.post('/ponto/espelho/ler', uploadEspelho.single('arquivo'), pontoCtrl.ler);
router.post('/ponto/espelho', pontoCtrl.salvar);
router.get('/ponto/espelho/:employeeId', pontoCtrl.listar);

module.exports = router;
