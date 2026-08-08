// routes/relatoRoutes.js
// Relato de Ocorrência e Manutenção de Frota (FRM-MAN-001).
const express = require('express');
const router = express.Router();
const relatoController = require('../controllers/relatoController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePage } = require('../utils/permissions');

router.use(authMiddleware);
router.use(requirePage('relatos'));

const adminOnly = (req, res, next) => {
    if (req.user?.user_type !== 'admin') {
        return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    next();
};

// ATENÇÃO: rotas estáticas ANTES de '/:id', senão o Express casa '/config' e
// '/os-mc' como se fossem um id de relato.
router.get('/config/sla', relatoController.getSlaConfig);
router.put('/config/sla', adminOnly, relatoController.updateSlaConfig);
router.get('/os-mc/:numero', relatoController.getPorOsMc);

// --- Cabeçalho ---
router.get('/', relatoController.getRelatos);
router.post('/', relatoController.createRelato);
router.get('/:id', relatoController.getRelatoById);
router.put('/:id', relatoController.updateRelato);
router.delete('/:id', relatoController.deleteRelato);

// --- Fechamento ---
// A prévia não persiste nada: só mostra como as ordens ficariam agrupadas e o
// cronograma em dias úteis antes de o gestor confirmar.
router.post('/:id/preview-fechamento', relatoController.previewFechamento);
router.post('/:id/fechar', relatoController.fecharRelato);
router.post('/:id/recalcular-prazos', relatoController.recalcularPrazos);
router.post('/:id/concluir', relatoController.concluirRelato);
router.post('/:id/cancelar', relatoController.cancelarRelato);

// --- Itens (seção 4 da ficha) ---
router.post('/:id/itens', relatoController.createRelatoItem);
router.put('/:id/itens/:itemId', relatoController.updateRelatoItem);
router.put('/:id/itens/:itemId/status', relatoController.updateRelatoItemStatus);
router.delete('/:id/itens/:itemId', relatoController.deleteRelatoItem);

module.exports = router;
