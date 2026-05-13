require('dotenv').config();

const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');

const app = express();
app.use(express.json());

const PORT    = process.env.PORT            || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// ─── Auth ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['apikey'] || req.headers['x-api-key'];
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'API Key inválida ou ausente.' });
    }
    next();
});

// ─── Estado ──────────────────────────────────────────────────────────────────
let clientStatus = 'DESCONECTADO';
let qrRaw        = null;   // string bruta emitida pelo whatsapp-web.js
let client       = null;
let reconnectTimer = null;

// ─── Puppeteer args testados para containers Linux ───────────────────────────
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
];

// ─── Cliente WhatsApp ─────────────────────────────────────────────────────────
function agendarReconexao(ms = 30000) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        console.log('🔄 Reconectando WhatsApp...');
        initClient();
    }, ms);
}

function initClient() {
    if (client) {
        try { client.destroy(); } catch (_) {}
        client = null;
    }

    qrRaw        = null;
    clientStatus = 'DESCONECTADO';

    const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    console.log(`🔧 Chromium: ${chromiumPath || 'padrão do puppeteer'}`);

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
        puppeteer: {
            headless: true,
            executablePath: chromiumPath,
            args: PUPPETEER_ARGS,
        },
    });

    // ── Eventos ────────────────────────────────────────────────────────────
    client.on('qr', (qr) => {
        // qr é a string bruta — o frontend a renderiza via qrcode.react
        qrRaw = qr;
        clientStatus = 'QR_PRONTO';
        console.log(`📱 QR Code disponível (${qr.length} chars). Acesse /status para obter.`);
    });

    client.on('loading_screen', (pct) => {
        console.log(`⏳ WhatsApp carregando: ${pct}%`);
    });

    client.on('authenticated', () => {
        console.log('🔐 Autenticado com sucesso.');
        clientStatus = 'AUTENTICADO';
        qrRaw = null;
    });

    client.on('ready', async () => {
        clientStatus = 'PRONTO';
        qrRaw = null;
        const ver = await client.getWWebVersion().catch(() => '?');
        console.log(`✅ WhatsApp pronto! Versão WWeb: ${ver}`);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Falha de autenticação:', msg);
        clientStatus = 'DESCONECTADO';
        agendarReconexao();
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Desconectado:', reason);
        clientStatus = 'DESCONECTADO';
        client = null;
        agendarReconexao();
    });

    client.initialize().catch((err) => {
        console.error('❌ Erro ao inicializar Puppeteer:', err.message);
        clientStatus = 'DESCONECTADO';
        agendarReconexao(60000);
    });
}

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ ok: true, status: clientStatus });
});

// Retorna status + string bruta do QR (o frontend renderiza)
app.get('/status', (req, res) => {
    res.json({ status: clientStatus, qr: qrRaw });
});

// Enviar mensagem
app.post('/send', async (req, res) => {
    const { number, message, documentUrl } = req.body;

    if (!number || !message)
        return res.status(400).json({ error: 'Campos obrigatórios: number, message' });

    if (clientStatus !== 'PRONTO')
        return res.status(503).json({ error: `WhatsApp não está pronto. Status: ${clientStatus}` });

    try {
        const resp = await client.sendMessage(`${number}@c.us`, message);
        const messageId = resp?.id?._serialized || null;

        if (documentUrl) {
            const media = await MessageMedia.fromUrl(
                documentUrl.replace('http://', 'https://'),
                { unsafeMime: true }
            );
            media.filename = 'Termo_Notificacao_FrotasMAK.pdf';
            await client.sendMessage(`${number}@c.us`, media, { sendMediaAsDocument: true });
        }

        console.log(`✅ Mensagem enviada → ${number}`);
        res.json({ ok: true, messageId });

    } catch (err) {
        console.error('❌ Erro ao enviar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Reiniciar cliente
app.post('/restart', (req, res) => {
    console.log('🔄 Reinício solicitado via API.');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setImmediate(initClient);
    res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log(`║  🟢 FrotaMAK WhatsApp Service          ║`);
    console.log(`║  📡 Porta: ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════╝');
    initClient();
});

process.on('unhandledRejection', (r) => console.error('🚨 UnhandledRejection:', r));
