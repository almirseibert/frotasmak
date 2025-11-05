// routes/vehicleRoutes.js
const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicleController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão (Estas estão corretas)
router.get('/', vehicleController.getAllVehicles);
router.get('/:id', vehicleController.getVehicleById);
router.post('/', vehicleController.createVehicle);
router.put('/:id', vehicleController.updateVehicle);
router.delete('/:id', vehicleController.deleteVehicle);

// ====================================================================
// ROTAS CORRIGIDAS
// Os caminhos e métodos agora correspondem ao apiClient.js
// ====================================================================

// --- Alocação de Obra ---
// Frontend chama: POST /:id/allocate-obra
router.post('/:id/allocate-obra', vehicleController.allocateToObra);
// Frontend chama: POST /:id/deallocate-obra
router.post('/:id/deallocate-obra', vehicleController.deallocateFromObra);

// --- Alocação Operacional ---
// Frontend chama: POST /:id/assign-operational
router.post('/:id/assign-operational', vehicleController.assignToOperational);
// Frontend chama: POST /:id/unassign-operational
router.post('/:id/unassign-operational', vehicleController.unassignFromOperational);

// --- Manutenção ---
// Frontend chama: POST /:id/start-maintenance
router.post('/:id/start-maintenance', vehicleController.startMaintenance);
// Frontend chama: POST /:id/end-maintenance
router.post('/:id/end-maintenance', vehicleController.endMaintenance);


module.exports = router;