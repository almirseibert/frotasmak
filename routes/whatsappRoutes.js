const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const db = require('../database');

// Status + QR Code
router.get('/status', async (req, res) => {
    try {
        const data = await whatsappService.getStatus(); // await estava faltando
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reiniciar cliente
router.post('/reiniciar', async (req, res) => {
    try {
        await whatsappService.reiniciar();
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar mensagem de teste
router.post('/enviar-teste', async (req, res) => {
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) {
        return res.status(400).json({ error: 'Campos obrigatórios: numero, mensagem' });
    }
    try {
        await whatsappService.enviarMensagem(numero, 'Teste Admin', 'TESTE_ADMIN', mensagem);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Histórico de mensagens
router.get('/logs', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, destinatario_nome, destinatario_numero, motivo_envio,
                    mensagem, status, criado_em
             FROM whatsapp_logs
             ORDER BY criado_em DESC
             LIMIT 50`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;