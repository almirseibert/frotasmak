const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');
const authMiddleware = require('../middlewares/authMiddleware'); // Adicionado authMiddleware

router.use(authMiddleware); // Protegendo todas as rotas de obras

// Rotas CRUD padrão
router.get('/', obraController.getAllObras);
// Painel de planejamento estratégico — precisa vir antes de '/:id'
router.get('/planejamento', require('../controllers/planejamentoController').getPlanejamento);
// Panorama de capacidade (aba Panorama) — idem, antes de '/:id'
router.get('/planejamento/panorama', require('../controllers/planejamentoController').getPanorama);
// Itens do plano de trabalho + resolução do item para uma máquina (tela de alocação)
router.get('/:id/plano-itens', obraController.getPlanoItens);
router.get('/:id', obraController.getObraById);
router.post('/', obraController.createObra);
router.put('/:id', obraController.updateObra);
router.delete('/:id', obraController.deleteObra);

// Rota especializada para Finalização de Obra
// O controlador agora tem a função 'finishObra', então esta linha funcionará
router.put('/:id/finish', obraController.finishObra);

router.put('/:obraId/historico/:historyId', obraController.updateObraHistoryEntry);
router.delete('/:obraId/historico/:historyId', obraController.deleteObraHistoryEntry);


module.exports = router;