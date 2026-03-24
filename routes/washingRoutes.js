const express = require('express');
const router = express.Router();
const washingController = require('../controllers/washingController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- Rotas para Parceiros de Lavagem (Lava-Jatos) ---
router.get('/partners', washingController.getPartners);
router.post('/partners', washingController.createPartner);
router.delete('/partners/:id', washingController.deletePartner);

// --- Rotas para os Registros de Lavagens ---
router.get('/', washingController.getWashings);
router.post('/', washingController.createWashing);

module.exports = router;