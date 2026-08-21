// routes/orderRoutes.js
const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', orderController.getAllOrders);
router.get('/:id', orderController.getOrderById);
router.post('/', orderController.createOrder);
router.put('/:id', orderController.updateOrder);
router.delete('/:id', orderController.deleteOrder);

// Rota de cancelamento
router.put('/:id/cancel', orderController.cancelOrder);

// Dispara e-mail/WhatsApp ao fornecedor com o PDF gerado (chamada pós-save)
router.post('/:id/notify', orderController.notifyOrder);

module.exports = router;