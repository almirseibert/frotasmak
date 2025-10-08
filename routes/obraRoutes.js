const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');

// Rotas CRUD padrão
router.get('/', obraController.getAllObras);
router.get('/:id', obraController.getObraById);
router.post('/', obraController.createObra);
router.put('/:id', obraController.updateObra);
router.delete('/:id', obraController.deleteObra);

// Rota especializada para Finalização de Obra
// O controlador agora tem a função 'finishObra', então esta linha funcionará
router.put('/:id/finish', obraController.finishObra);

module.exports = router;
