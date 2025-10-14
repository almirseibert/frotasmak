// routes/updateRoutes.js
const express = require('express');
const router = express.Router();
// NOTA: Você precisará criar este controller, ou me enviar o adminController para eu adaptar.
// Por enquanto, vamos assumir que a lógica está em 'adminController'.
const adminController = require('../controllers/adminController');

// Rota para buscar a última mensagem de atualização
// Corresponde a GET /api/updates/latest
router.get('/latest', adminController.getUpdateMessage);

module.exports = router;
