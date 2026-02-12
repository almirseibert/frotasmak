const express = require('express');
const router = express.Router();
const controller = require('../controllers/obraSupervisorController');
const authMiddleware = require('../middlewares/authMiddleware');

// Middleware global: Todas as rotas exigem login
router.use(authMiddleware);

// Rota Principal: Dashboard Modo TV
// GET /api/supervisor/dashboard
router.get('/dashboard', controller.getDashboardData);

// Rota Detalhes: Cockpit da Obra
// GET /api/supervisor/obra/:id
router.get('/obra/:id', controller.getObraDetails);

// Rota CRM: Registrar Contato
// POST /api/supervisor/crm
router.post('/crm', controller.addCrmLog);

// Rota Configuração: Salvar dados do contrato
// POST /api/supervisor/contract
router.post('/contract', controller.upsertContract);

module.exports = router;