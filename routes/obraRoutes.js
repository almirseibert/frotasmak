const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');
const authMiddleware = require('../middlewares/authMiddleware'); // Adicionado authMiddleware

router.use(authMiddleware); // Protegendo todas as rotas de obras

// Rotas CRUD padrão
router.get('/', obraController.getAllObras);
router.get('/:id', obraController.getObraById);
router.post('/', obraController.createObra);
router.put('/:id', obraController.updateObra);
router.delete('/:id', obraController.deleteObra);

// Rota especializada para Finalização de Obra
// O controlador agora tem a função 'finishObra', então esta linha funcionará
router.put('/:id/finish', obraController.finishObra);

// --- NOVO: Rota para editar uma entrada de histórico específica ---
// Esta rota é chamada pelo ObrasPage.js (EditPastVehicleAssignmentModal e EditActiveVehicleAssignmentModal)
router.put('/:obraId/historico/:historyId', obraController.updateObraHistoryEntry);


module.exports = router;