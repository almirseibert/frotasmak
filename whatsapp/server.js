require('dotenv').config();

const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// =====================================================================
// Autenticação por API Key
// =====================================================================
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['apikey'] || req.headers['x-api-key'];
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'API Key inválida ou ausente.' });
    }
    next();
});

// =====================================================================
// Estado do cliente WhatsApp
// =====================================================================
let clientStatus = 'DESCONECTADO'; // DESCONECTADO | QR_PRONTO | AUTENTICADO | PRONTO
let qrCodeBase64 = null;
let client = null;
let reconnectTimer = null;

function agendarReconexao(ms = 30000) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        console.log('🔄 Tentando reconectar WhatsApp...');
        initClient();
    }, ms);
}

function initClient() {
    if (client) {
        try { client.destroy(); } catch (_) {}
        client = null;
    }

    const authPath = path.join(__dirname, '.wwebjs_auth');

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--single-process'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('📱 QR Code recebido — gerando imagem SVG...');
        clientStatus = 'QR_PRONTO';
        try {
            // toString com type:'svg' é puro JS — não precisa de node-canvas
            const svg = await qrcode.toString(qr, { type: 'svg', width: 256, margin: 2 });
            qrCodeBase64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
            console.log('✅ QR Code SVG gerado com sucesso.');
        } catch (err) {
            console.error('❌ Erro ao gerar QR Code SVG:', err.message);
            // Fallback: envia a string crua para o frontend renderizar
            qrCodeBase64 = qr;
        }
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp autenticado com sucesso.');
        clientStatus = 'AUTENTICADO';
        qrCodeBase64 = null;
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp pronto para enviar mensagens!');
        clientStatus = 'PRONTO';
        qrCodeBase64 = null;
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Falha de autenticação:', msg);
        clientStatus = 'DESCONECTADO';
        agendarReconexao();
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp desconectado:', reason);
        clientStatus = 'DESCONECTADO';
        client = null;
        agendarReconexao();
    });

    client.initialize().catch((err) => {
        console.error('❌ Erro ao inicializar WhatsApp:', err.message);
        clientStatus = 'DESCONECTADO';
        agendarReconexao(60000);
    });
}

// =====================================================================
// Endpoints
// =====================================================================

// Health check (sem autenticação — para Easypanel monitorar)
app.get('/health', (req, res) => {
    res.json({ ok: true, status: clientStatus });
});

// Status atual + QR Code (se disponível)
app.get('/status', (req, res) => {
    res.json({ status: clientStatus, qr: qrCodeBase64 });
});

// Enviar mensagem de texto (+ documento opcional)
app.post('/send', async (req, res) => {
    const { number, message, documentUrl } = req.body;

    if (!number || !message) {
        return res.status(400).json({ error: 'Campos obrigatórios: number, message' });
    }

    if (clientStatus !== 'PRONTO') {
        return res.status(503).json({ error: `WhatsApp não está pronto. Status: ${clientStatus}` });
    }

    const chatId = `${number}@c.us`;

    try {
        const response = await client.sendMessage(chatId, message);
        const messageId = response?.id?._serialized || null;

        if (documentUrl) {
            const secureUrl = documentUrl.replace('http://', 'https://');
            const media = await MessageMedia.fromUrl(secureUrl, { unsafeMime: true });
            media.filename = 'Termo_Notificacao_FrotasMAK.pdf';
            await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
            console.log(`📎 Documento enviado para ${number}`);
        }

        console.log(`✅ Mensagem enviada para ${number}`);
        res.json({ ok: true, messageId });

    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Reiniciar cliente WhatsApp manualmente
app.post('/restart', (req, res) => {
    console.log('🔄 Reinício solicitado via API.');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setImmediate(() => initClient());
    res.json({ ok: true, message: 'Reinicialização iniciada.' });
});

// =====================================================================
// Start
// =====================================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log(`║  🟢 FrotaMAK WhatsApp Service             ║`);
    console.log(`║  📡 Porta: ${PORT}                            ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    initClient();
});

process.on('unhandledRejection', (reason) => {
    console.error('🚨 Promise rejeitada:', reason);
});