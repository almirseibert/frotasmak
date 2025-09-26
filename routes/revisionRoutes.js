// routes/revisionRoutes.js
const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', revisionController.getAllRevisions);
router.get('/:id', revisionController.getRevisionById);
router.post('/', revisionController.createRevision);
router.put('/:id', revisionController.updateRevision);
router.delete('/:id', revisionController.deleteRevision);

// Rota para concluir a revisão
router.put('/:id/complete', revisionController.completeRevision);

module.exports = router;