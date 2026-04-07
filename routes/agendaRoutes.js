const express = require('express');
const router = express.Router();
const agendaController = require('../controllers/agendaController');
const { protect } = require('../middlewares/authMiddleware'); // Garantindo acesso seguro via JWT

// Todas as rotas de agenda são protegidas (o usuário precisa estar logado)
router.use(protect);

// Rotas CRUD
router.get('/', agendaController.getEventos);
router.post('/', agendaController.criarEvento);
router.put('/:id', agendaController.atualizarEvento);
router.delete('/:id', agendaController.deletarEvento);

// Rotas Específicas de UI/UX (Sininho e Checklist)
router.patch('/:id/concluir', agendaController.marcarConcluido);
router.get('/notificacoes', agendaController.getNotificacoesPendentes);

module.exports = router;