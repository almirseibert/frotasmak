// backend/routes/evidenciaPublicRoutes.js
// Rota PÚBLICA de imagem — montada ACIMA do authMiddleware porque se autentica
// sozinha por HMAC (§4). <img src> não carrega Authorization; a assinatura na
// query resolve isso, e stamp_version na assinatura invalida URLs antigas.
const express = require('express');
const ctrl = require('../controllers/evidenciaController');

const router = express.Router();

router.get('/:id/:variante', ctrl.servirVariante);

module.exports = router;
