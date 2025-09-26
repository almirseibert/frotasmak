// routes/partnerRoutes.js
const express = require('express');
const router = express.Router();
const partnerController = require('../controllers/partnerController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', partnerController.getAllPartners);
router.get('/:id', partnerController.getPartnerById);
router.post('/', partnerController.createPartner);
router.put('/:id', partnerController.updatePartner);
router.delete('/:id', partnerController.deletePartner);

// Nova rota para atualizar apenas os preços
router.put('/:id/prices', partnerController.updateFuelPrices);

module.exports = router;