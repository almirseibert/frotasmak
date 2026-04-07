const express = require('express');
const router = express.Router();
const agendaController = require('../controllers/agendaController');

// CORREÇÃO: Importando o middleware diretamente, no padrão do seu projeto
const authMiddleware = require('../middlewares/authMiddleware'); 

// Todas as rotas de agenda são protegidas (o usuário precisa estar logado)
router.use(authMiddleware);

// Rotas CRUD
router.get('/', agendaController.getEventos);
router.post('/', agendaController.criarEvento);
router.put('/:id', agendaController.atualizarEvento);
router.delete('/:id', agendaController.deletarEvento);

// Rotas Específicas de UI/UX (Sininho e Checklist)
router.patch('/:id/concluir', agendaController.marcarConcluido);
router.get('/notificacoes', agendaController.getNotificacoesPendentes);

module.exports = router;