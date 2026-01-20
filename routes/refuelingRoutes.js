// routes/refuelingRoutes.js
const express = require('express');
const router = express.Router();
const refuelingController = require('../controllers/refuelingController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- ROTA DE UPLOAD (IMPORTANTE: Antes das rotas com :id) ---
router.post('/upload-pdf', refuelingController.upload.single('file'), refuelingController.uploadOrderPdf);

// Rotas CRUD padrão
router.get('/', refuelingController.getAllRefuelings);
router.get('/:id', refuelingController.getRefuelingById);
router.post('/', refuelingController.createRefuelingOrder);
router.put('/:id', refuelingController.updateRefuelingOrder);
router.delete('/:id', refuelingController.deleteRefuelingOrder);

// Rota para confirmar um abastecimento em aberto
router.put('/:id/confirm', refuelingController.confirmRefuelingOrder);

module.exports = router;