// routes/vehicleRoutes.js
const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicleController');
const authMiddleware = require('../middlewares/authMiddleware');

// Proteger todas as rotas com o middleware de autenticação
router.use(authMiddleware);

// Rota para listar todos os veículos
router.get('/', vehicleController.getAllVehicles);

// Rota para obter um único veículo por ID
router.get('/:id', vehicleController.getVehicleById);

// Rota para criar um novo veículo
router.post('/', vehicleController.createVehicle);

// Rota para atualizar um veículo existente
router.put('/:id', vehicleController.updateVehicle);

// Rota para deletar um veículo
router.delete('/:id', vehicleController.deleteVehicle);

module.exports = router;