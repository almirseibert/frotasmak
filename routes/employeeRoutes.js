const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', employeeController.getAllEmployees);
router.get('/:id', employeeController.getEmployeeById);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);

// Rotas especializadas
// Busca histórico de alocações (obra, operacional)
router.get('/:id/history', employeeController.getEmployeeHistory);
// Alternativa para mudança de status, se não estiver no PUT principal
router.put('/:id/status', employeeController.updateEmployeeStatus);

module.exports = router;