// routes/diarioDeBordoRoutes.js
const express = require('express');
const router = express.Router();
const diarioDeBordoController = require('../controllers/diarioDeBordoController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', diarioDeBordoController.getAllDiarioDeBordo);
router.get('/:id', diarioDeBordoController.getDiarioDeBordoById);
router.post('/', diarioDeBordoController.createDiarioDeBordo);
router.put('/:id', diarioDeBordoController.updateDiarioDeBordo);
router.delete('/:id', diarioDeBordoController.deleteDiarioDeBordo);

module.exports = router;