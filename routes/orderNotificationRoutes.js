// routes/orderNotificationRoutes.js
// Consulta e reenvio do status de entrega das ordens de abastecimento.
const express = require('express');
const router = express.Router();
const db = require('../database');
const orderDelivery = require('../services/orderDelivery');
const orderRetryService = require('../services/orderRetryService');
const whatsappService = require('../services/whatsappService');

// GET /api/orderNotifications/status?authNumbers=12,13,14
// Resumo por ordem — alimenta o badge na lista de ordens.
router.get('/status', async (req, res) => {
    try {
        const raw = String(req.query.authNumbers || '').trim();
        if (!raw) return res.json({});
        const nums = raw.split(',')
            .map(n => parseInt(n, 10))
            .filter(Number.isFinite)
            .slice(0, 500);
        res.json(await orderDelivery.buscarPorAuthNumbers(nums));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/orderNotifications/pendencias?dias=7
// Tudo que não chegou ao destino — painel admin.
router.get('/pendencias', async (req, res) => {
    try {
        const dias = Math.min(parseInt(req.query.dias, 10) || 7, 90);
        const [pendencias, total] = await Promise.all([
            orderDelivery.listarPendencias({ dias }),
            orderDelivery.contarPendencias({ dias }),
        ]);
        res.json({ total, pendencias });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/orderNotifications/preflight
// Consultado ao ABRIR a tela de emissão de ordem: diz se dá para confiar que a
// ordem será entregue. Sem isso o usuário emite às cegas.
router.get('/preflight', async (req, res) => {
    try {
        const { status } = await whatsappService.getStatus();
        const pronto = status === 'PRONTO';
        const pendencias = await orderDelivery.contarPendencias({ dias: 2 });
        res.json({
            whatsappStatus: status,
            whatsappPronto: pronto,
            pendencias48h: pendencias,
            aviso: pronto ? null
                : 'WhatsApp desconectado — a ordem será registrada, mas NÃO será entregue ao posto até a conexão voltar. O sistema reenvia automaticamente quando reconectar.',
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/orderNotifications/:id/reenviar — reenvia um canal específico.
router.post('/:id/reenviar', async (req, res) => {
    try {
        const r = await orderRetryService.reenviarRegistro(req.params.id);
        if (!r.ok) return res.status(422).json({ error: r.motivo });
        req.io?.emit('server:sync', { resource: 'refuelings' });
        res.json({ ok: true, resultado: r.resultado });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/orderNotifications/ordem/:authNumber/reenviar
// Reenvia todos os canais pendentes de uma ordem — é o botão "Reenviar" da tela.
router.post('/ordem/:authNumber/reenviar', async (req, res) => {
    try {
        const authNumber = parseInt(req.params.authNumber, 10);
        if (!Number.isFinite(authNumber)) {
            return res.status(400).json({ error: 'authNumber inválido.' });
        }
        await orderDelivery.ensureTable();
        const [rows] = await db.query(
            `SELECT id, canal FROM order_notifications
              WHERE authNumber = ? AND status <> ?`,
            [authNumber, orderDelivery.STATUS.ENVIADO]
        );
        if (rows.length === 0) {
            return res.status(422).json({ error: 'Nada a reenviar para esta ordem.' });
        }

        const resultados = [];
        for (const row of rows) {
            const r = await orderRetryService.reenviarRegistro(row.id);
            resultados.push({ canal: row.canal, ok: r.ok, motivo: r.motivo });
        }
        const algumOk = resultados.some(r => r.ok);
        req.io?.emit('server:sync', { resource: 'refuelings' });
        res.status(algumOk ? 200 : 422).json({ ok: algumOk, resultados });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
