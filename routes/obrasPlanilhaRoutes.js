const express = require('express');
const router = express.Router();
const controller = require('../controllers/obrasPlanilhaController');

router.get('/', controller.listar);
router.post('/sincronizar', controller.sincronizar);
router.post('/:id/ignorar', controller.ignorar);
router.post('/:id/vincular', controller.vincular);

module.exports = router;
