// routes/obraRoutes.js
const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', obraController.getAllObras);
router.get('/:id', obraController.getObraById);
router.post('/', obraController.createObra);
router.put('/:id', obraController.updateObra);
router.delete('/:id', obraController.deleteObra);

module.exports = router;