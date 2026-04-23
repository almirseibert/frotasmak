const express = require('express');
const router = express.Router();
const controller = require('../controllers/obraSupervisorController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/dashboard', controller.getDashboardData);
router.get('/obra/:id', controller.getObraDetails);
router.post('/crm', controller.addCrmLog);
router.post('/contract', controller.upsertContract);
router.post('/vehicle-mission', controller.updateVehicleNextMission);

// Rota para a listagem global de equipamentos
router.get('/allocations', controller.getAllocationForecast);

// ROTA NOVA DE BI (Análise de Produtividade)
router.get('/analytics', controller.getAnalyticsData);

module.exports = router;