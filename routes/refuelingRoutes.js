// routes/refuelingRoutes.js
const express = require('express');
const router = express.Router();
const refuelingController = require('../controllers/refuelingController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', refuelingController.getAllRefuelings);
router.get('/:id', refuelingController.getRefuelingById);
router.post('/', refuelingController.createRefueling);
router.put('/:id', refuelingController.updateRefueling);
router.delete('/:id', refuelingController.deleteRefueling);

module.exports = router;