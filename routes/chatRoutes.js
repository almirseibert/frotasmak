// routes/chatRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const chatController = require('../controllers/chatController');

router.use(authMiddleware);

router.get('/contacts', chatController.getContacts);
router.get('/search', chatController.searchMessages);
router.get('/export/:userId', chatController.exportConversation);
router.post('/block', chatController.blockUser);
router.post('/unblock', chatController.unblockUser);
router.post('/report', chatController.reportUser);
router.get('/messages/:userId', chatController.getMessages);
router.post('/messages', chatController.postMessage);
router.put('/messages/:id', chatController.editMessage);
router.delete('/messages/:id', chatController.deleteMessage);
router.post('/messages/:id/reaction', chatController.toggleReaction);
router.post('/messages/:id/pin', chatController.togglePin);
router.post('/read', chatController.markRead);

module.exports = router;
