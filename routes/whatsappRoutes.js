const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');

router.get('/status', (req, res) => {
    res.json(whatsappService.getStatus());
});

router.post('/reiniciar', async (req, res) => {
    try {
        await whatsappService.reiniciar();
        res.json({ ok: true, message: 'Reinicialização do WhatsApp solicitada.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;