// routes/chatRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const chatController = require('../controllers/chatController');

router.use(authMiddleware);

router.get('/contacts', chatController.getContacts);
router.get('/messages/:userId', chatController.getMessages);
router.post('/messages', chatController.postMessage);
router.post('/read', chatController.markRead);

module.exports = router;
