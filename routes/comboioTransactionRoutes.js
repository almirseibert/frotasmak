// routes/comboioTransactionRoutes.js
const express = require('express');
const router = express.Router();
const comboioTransactionController = require('../controllers/comboioTransactionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', comboioTransactionController.getAllComboioTransactions);
router.get('/:id', comboioTransactionController.getComboioTransactionById);
router.post('/', comboioTransactionController.createComboioTransaction);
router.put('/:id', comboioTransactionController.updateComboioTransaction);
router.delete('/:id', comboioTransactionController.deleteComboioTransaction);

module.exports = router;