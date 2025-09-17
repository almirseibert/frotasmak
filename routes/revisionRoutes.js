// routes/revisionRoutes.js
const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', revisionController.getAllRevisions);
router.get('/:id', revisionController.getRevisionById);
router.post('/', revisionController.createRevision);
router.put('/:id', revisionController.updateRevision);
router.delete('/:id', revisionController.deleteRevision);

module.exports = router;