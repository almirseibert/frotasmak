// routes/obraRoutes.js
const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', obraController.getAllObras);
router.get('/:id', obraController.getObraById);
router.post('/', obraController.createObra);
router.put('/:id', obraController.updateObra);
router.delete('/:id', obraController.deleteObra);

// Rota especializada para Finalização de Obra
// PUT /api/obras/:id/finish
router.put('/:id/finish', obraController.finishObra);

module.exports = router;
