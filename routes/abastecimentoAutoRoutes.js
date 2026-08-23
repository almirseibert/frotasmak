// routes/abastecimentoAutoRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/abastecimentoAutoController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAnyPage } = require('../utils/permissions');

router.use(authMiddleware);

// Configurar o aceite automático mexe em quem libera abastecimento sozinho:
// mesma exigência de papel das demais ações do setor.
const podeOperar = requireAnyPage(['refueling', 'admin_solicitacoes']);

router.get('/config', podeOperar, ctrl.getConfig);
router.put('/config', podeOperar, ctrl.updateConfig);
router.get('/metricas', podeOperar, ctrl.getMetricas);
router.get('/analises/:id', podeOperar, ctrl.getAnalises);
router.post('/reprocessar/:id', podeOperar, ctrl.reprocessar);

module.exports = router;
