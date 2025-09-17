// routes/fineRoutes.js
const express = require('express');
const router = express.Router();
const fineController = require('../controllers/fineController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', fineController.getAllFines);
router.get('/:id', fineController.getFineById);
router.post('/', fineController.createFine);
router.put('/:id', fineController.updateFine);
router.delete('/:id', fineController.deleteFine);

module.exports = router;