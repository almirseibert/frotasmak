const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rota para buscar o plano de revisões consolidado (usado pelo Dashboard/RevisionsPage)
// Espera-se que esta rota retorne Veículos com seus Planos e status 'isDue' agregados.
router.get('/plan', revisionController.getConsolidatedRevisionPlan);

// Rota para buscar o histórico de revisões de um veículo específico
router.get('/history/:vehicleId', revisionController.getRevisionHistoryByVehicle);

// Rota para CONCLUIR uma revisão/manutenção
router.post('/complete', revisionController.completeRevision);

// Rotas CRUD para Planos de Revisão
router.get('/', revisionController.getAllRevisionPlans);
router.post('/', revisionController.createRevisionPlan);
router.put('/:id', revisionController.updateRevisionPlan);
router.delete('/:id', revisionController.deleteRevisionPlan);

module.exports = router;
