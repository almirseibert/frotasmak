const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- Rotas de Revisão (Alinhadas com o Controller Atual) ---

// 1. Buscar todos os planos de revisão (Listagem principal)
router.get('/', revisionController.getAllRevisionPlans);

// 2. Criar um novo plano de revisão (Manual ou Automático)
router.post('/', revisionController.createRevisionPlan);

// 3. Atualizar/Agendar um plano existente (ou criar se não existir para o veículo)
// O frontend envia o ID do VEÍCULO na URL para edição/agendamento
router.put('/:id', revisionController.updateRevisionPlan);

// 4. Concluir uma revisão (Registra histórico e atualiza veículo)
router.post('/complete/:id', revisionController.completeRevision);

// 5. Deletar um plano de revisão (Remove agendamento)
// O frontend deve enviar o ID da REVISÃO aqui
router.delete('/:id', revisionController.deleteRevisionPlan);

module.exports = router;