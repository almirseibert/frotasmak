const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rota para buscar o plano de revisões consolidado (GET /api/revisions/plan)
router.get('/plan', revisionController.getConsolidatedRevisionPlan);

// Rota para buscar o histórico de revisões de um veículo específico (GET /api/revisions/history/:vehicleId)
router.get('/history/:vehicleId', revisionController.getRevisionHistoryByVehicle);

// Rota para CONCLUIR uma revisão/manutenção (POST /api/revisions/complete)
router.post('/complete', revisionController.completeRevision);

// Rota para buscar todos os planos de revisão (GET /api/revisions/)
// Esta é a rota que o RevisionsPage.js usa para carregar os dados
router.get('/', revisionController.getAllRevisionPlans);

// Rota para CRIAR um novo plano (POST /api/revisions/)
router.post('/', revisionController.createRevisionPlan);

// Rota para ATUALIZAR/AGENDAR um plano (PUT /api/revisions/:id)
// O frontend envia o VEHICLE ID como :id
router.put('/:id', revisionController.updateRevisionPlan);

// Rota para DELETAR um plano (DELETE /api/revisions/:id)
// Esta rota espera o REVISION ID, não o vehicleId
router.delete('/:id', revisionController.deleteRevisionPlan);

module.exports = router;