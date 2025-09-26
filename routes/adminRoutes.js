// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas de gerenciamento de solicitações de cadastro
router.get('/registration-requests', adminController.getRegistrationRequests);
router.post('/registration-requests/approve', adminController.approveRegistrationRequest);
router.delete('/registration-requests/:id', adminController.deleteRegistrationRequest);

// Rotas de atribuição de papéis
router.put('/assign-role', adminController.assignRole);

// Rotas de mensagem de atualização
router.get('/update-message', adminController.getUpdateMessage);
router.put('/update-message', adminController.saveUpdateMessage);

module.exports = router;