const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/obra/:obraId', billingController.getDailyLogs);
router.post('/', billingController.upsertDailyLog);
router.delete('/:id', billingController.deleteDailyLog);

module.exports = router;