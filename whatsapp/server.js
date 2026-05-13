require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

const PORT    = process.env.PORT || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let clientStatus = 'DESCONECTADO';
let qrRaw        = null;   // string bruta para o qrcode.react no frontend
let client       = null;
let reconnectTimer = null;

// ─── PUPPETEER ARGS (Otimizados para Linux/Docker) ────────────────────────────
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
];

// ─── ROTA PÚBLICA (Para o navegador não mostrar erro 401) ─────────────────────
app.get('/', (req, res) => {
    res.send('🟢 Microsserviço WhatsApp FrotasMAK operando de forma segura. (Acesso à API requer API Key)');
});

app.get('/health', (req, res) => res.send('OK'));

// ─── MIDDLEWARE DE AUTENTICAÇÃO API ───────────────────────────────────────────
app.use((req, res, next) => {
    const key = req.headers['apikey'] || req.headers['x-api-key'];
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'API Key inválida ou ausente.' });
    }
    next();
});

// ─── INICIALIZAÇÃO E CONTROLE DO CLIENTE WHATSAPP ─────────────────────────────
function initClient() {
    if (client) {
        console.log('🧹 Limpando instância anterior do cliente...');
        try { client.destroy(); } catch (e) { console.log('Aviso ao destruir:', e.message); }
    }

    clientStatus = 'DESCONECTADO';
    qrRaw = null;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: PUPPETEER_ARGS
        }
    });

    // Eventos principais de Estado (Sincronizados com o Frontend React)
    client.on('qr', (qr) => {
        console.log('💡 QR Code gerado pelo WhatsApp Web!');
        qrRaw = qr;
        clientStatus = 'QR_PRONTO';
    });

    client.on('ready', () => {
        console.log('✅ Cliente WhatsApp pronto e conectado!');
        clientStatus = 'PRONTO';
        qrRaw = null;
    });

    client.on('authenticated', () => {
        console.log('🔐 Autenticado com sucesso!');
        clientStatus = 'AUTENTICADO';
        qrRaw = null;
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Falha na autenticação', msg);
        clientStatus = 'FALHA_AUTH';
        qrRaw = null;
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp desconectado!', reason);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        agendarReconexao();
    });

    console.log('⏳ Inicializando o Puppeteer/Chromium...');
    client.initialize().catch(err => {
        console.error('🚨 Erro crítico ao iniciar o Puppeteer:', err);
        agendarReconexao();
    });
}

function agendarReconexao() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        console.log('🔄 Tentando reconectar automaticamente...');
        initClient();
    }, 10000); // Tenta novamente em 10 segundos
}

// ─── ROTAS DA API PROTEGIDAS ──────────────────────────────────────────────────

app.get('/status', (req, res) => {
    res.json({ status: clientStatus, qr: qrRaw });
});

app.post('/send', async (req, res) => {
    if (clientStatus !== 'PRONTO') {
        return res.status(503).json({ error: `WhatsApp não está pronto. Status atual: ${clientStatus}` });
    }

    const { number, message, documentUrl } = req.body;
    
    try {
        const chatId = `${number}@c.us`;
        
        // 1. Envia a mensagem de texto
        const resp = await client.sendMessage(chatId, message);
        const messageId = resp?.id?._serialized || null;

        // 2. Envia documento se houver
        if (documentUrl) {
            console.log(`📎 Baixando e anexando documento de: ${documentUrl}`);
            const media = await MessageMedia.fromUrl(
                documentUrl.replace('http://', 'https://'), 
                { unsafeMime: true }
            );
            media.filename = 'Termo_Notificacao_FrotasMAK.pdf';
            await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
        }

        console.log(`✅ Mensagem ${documentUrl ? '(com anexo)' : ''} enviada → ${number}`);
        res.json({ success: true, messageId });

    } catch (err) {
        console.error('❌ Erro ao enviar mensagem:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Rota de Restart turbinada para limpar sessões travadas
app.post('/restart', async (req, res) => {
    console.log('🔄 Reinício manual solicitado. Executando limpeza severa...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    // Tenta destruir a instância atual do Puppeteer
    if (client) {
        try { await client.destroy(); } catch (e) { console.log('Aviso ao destruir Chromium:', e.message); }
    }

    // A MÁGICA AQUI: Deleta fisicamente a pasta de sessão corrompida
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        console.log('🗑️ Removendo pasta de autenticação corrompida para forçar novo QR Code...');
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
        } catch (err) {
            console.error('Erro ao deletar pasta de auth:', err);
        }
    }

    // Aguarda 2 segundos e inicia uma sessão 100% limpa
    setTimeout(initClient, 2000);
    res.json({ success: true, message: 'Sessão destruída e reiniciando o Puppeteer...' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
initClient();

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log(`║  🟢 FrotaMAK WhatsApp Service          ║`);
    console.log(`║  📡 Porta: ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════╝');
});