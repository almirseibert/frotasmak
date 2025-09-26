// routes/vehicleRoutes.js
const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicleController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', vehicleController.getAllVehicles);
router.get('/:id', vehicleController.getVehicleById);
router.post('/', vehicleController.createVehicle);
router.put('/:id', vehicleController.updateVehicle);
router.delete('/:id', vehicleController.deleteVehicle);

// Novas rotas para alocação e manutenção
router.post('/:id/obra/allocate', vehicleController.allocateToObra);
router.put('/:id/obra/deallocate', vehicleController.deallocateFromObra);
router.post('/:id/operational/assign', vehicleController.assignToOperational);
router.put('/:id/operational/unassign', vehicleController.unassignFromOperational);
router.post('/:id/maintenance/start', vehicleController.startMaintenance);
router.put('/:id/maintenance/end', vehicleController.endMaintenance);

module.exports = router;