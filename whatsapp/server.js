require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ─── PATCH whatsapp-web.js: envio de mídia quebrado pelo WA Web 2.3000.1047xxx ──
// Nessa build do WhatsApp Web o MediaData ganhou um campo privado `__x_id`.
// O sendMessage injetado espalha o media model no objeto da mensagem, esse campo
// sobrescreve o MsgKey e TODO envio de mídia falha com:
//   "Data passed to getter must include an id property (it's how we memoize)"
// O texto da ordem chega, o PDF não (status PARCIAL). Correção upstream ainda
// não publicada: https://github.com/wwebjs/whatsapp-web.js/pull/201923
// O código injetado é lido deste arquivo quando a lib é carregada, então o patch
// precisa rodar ANTES do require abaixo. Idempotente pela marca MARCA_PATCH_MIDIA
// (o arquivo patchado sobrevive a restart do container, só some no rebuild).
// Além de apagar o __x_id, devolve o MsgKey ao `id` — se o toJSON() do
// MediaData espalhado também trouxer `id`, o efeito é o mesmo erro.
// O resultado vai para GET /status (patchMidia) e aparece no painel do WhatsApp.
const MARCA_PATCH_MIDIA = 'frotasmak:patch-midia-v2';
let PATCH_MIDIA = 'não executado';
(function patchEnvioDeMidia() {
    try {
        const raiz = path.dirname(require.resolve('whatsapp-web.js'));
        const utilsPath = path.join(raiz, 'src', 'util', 'Injected', 'Utils.js');
        const src = fs.readFileSync(utilsPath, 'utf8');
        if (src.includes(MARCA_PATCH_MIDIA)) {
            PATCH_MIDIA = 'aplicado';
            console.log('🩹 [WWEBJS] Correção de envio de mídia já presente.');
            return;
        }
        // Fecha o `const message = { ... ...mediaOptions ... };` do sendMessage.
        const re = /(const message = \{[\s\S]*?\.\.\.mediaOptions[\s\S]*?\n([ \t]*)\};)/;
        if (!re.test(src)) {
            PATCH_MIDIA = 'trecho do sendMessage não encontrado';
            console.warn('⚠️ [WWEBJS] Trecho do sendMessage não encontrado — patch de mídia NÃO aplicado. PDFs podem não chegar.');
            return;
        }
        const patched = src.replace(re, (bloco, _m, indent) => {
            const linhas = [
                `// ${MARCA_PATCH_MIDIA}: o MediaData espalhado acima sobrescreve o MsgKey`,
                'delete message.__x_id;',
            ];
            if (/\bid:\s*newMsgKey\b/.test(bloco)) linhas.push('message.id = newMsgKey;');
            return `${bloco}\n\n${linhas.map(l => indent + l).join('\n')}`;
        });
        fs.writeFileSync(utilsPath, patched);
        PATCH_MIDIA = 'aplicado';
        console.log('🩹 [WWEBJS] Correção de envio de mídia aplicada (__x_id removido, id restaurado).');
    } catch (e) {
        PATCH_MIDIA = `falhou: ${e.message}`;
        console.warn('⚠️ [WWEBJS] Falha ao aplicar patch de envio de mídia:', e.message);
    }
})();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT    = process.env.PORT || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let clientStatus = 'DESCONECTADO';
let qrRaw        = null;
let client       = null;
let reconnectTimer = null;

// Cada initClient ganha uma geração. Eventos e erros de uma instância que já
// foi substituída NÃO podem agendar reconexão: a instância velha, morta pelo
// destroy no meio do initialize, agendava um reconnect que matava a nova no
// meio do initialize, que agendava outro... e o serviço nunca terminava de subir
// ("Target closed" / "Execution context was destroyed" em loop).
let geracaoCliente = 0;
let inicializando  = false;

// Falhas de autenticação seguidas. Zerado ao autenticar com sucesso.
let falhasAuthConsecutivas = 0;
const MAX_FALHAS_AUTH = 3;

// ─── PUPPETEER ARGS ───────────────────────────────────────────────────────────
const isWindows = process.platform === 'win32';
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    ...(!isWindows ? ['--disable-dev-shm-usage', '--no-zygote'] : []),
];

// ─── CAMINHO DA SESSÃO ────────────────────────────────────────────────────────
// PRECISA apontar para um volume persistente em produção. Se ficar dentro do
// filesystem do container (o default relativo antigo), TODO redeploy apaga a
// sessão e o WhatsApp cai exigindo leitura de QR Code — que era exatamente o
// motivo das ordens de abastecimento não chegarem aos postos após cada deploy.
const SESSION_PATH = process.env.WA_SESSION_PATH
    ? path.resolve(process.env.WA_SESSION_PATH)
    : path.join(__dirname, '.wwebjs_auth');

const BOOT_TIME = new Date().toISOString();

console.log(`📁 [SISTEMA] Sessão do WhatsApp em: ${SESSION_PATH}`);
if (!process.env.WA_SESSION_PATH) {
    console.log('ℹ️ [SISTEMA] WA_SESSION_PATH não definido — usando o caminho padrão. Confirme que ele está DENTRO do volume persistente.');
}

// ─── FUNÇÃO DE LIMPEZA PROFUNDA ───────────────────────────────────────────────
// Registro persistente dos eventos de sessão. Fica DENTRO do volume, ao lado da
// sessão, para sobreviver a restarts — é a única forma de responder depois
// "quem apagou a sessão e por quê" sem depender do log volátil do container.
// Fica DENTRO da pasta da sessão — é o único diretório que sabemos estar no
// volume persistente. limparPastaSessao() o preserva ao apagar o resto.
const EVENTS_LOG = path.join(SESSION_PATH, 'wa-session-events.log');
// Horários das últimas conexões ao WhatsApp — base do teto por hora da
// política anti-banimento. No volume para valer também entre restarts.
const CONEXOES_LOG = path.join(SESSION_PATH, 'wa-conexoes.json');
const ARQUIVOS_DE_CONTROLE = [path.basename(EVENTS_LOG), path.basename(CONEXOES_LOG)];

function registrarEventoSessao(evento) {
    try {
        const linha = `${new Date().toISOString()} ${evento}\n`;
        fs.mkdirSync(SESSION_PATH, { recursive: true });
        fs.appendFileSync(EVENTS_LOG, linha);
    } catch (_) { /* diagnóstico nunca pode derrubar o serviço */ }
}

// APAGAR A SESSÃO É DESTRUTIVO: obriga a ler o QR Code de novo, e enquanto
// ninguém lê, nenhuma ordem de abastecimento chega aos postos. Só deve
// acontecer quando a sessão está comprovadamente morta (logout/despareamento)
// ou por decisão explícita de um humano.
function limparPastaSessao(motivo = 'não informado') {
    const authPath = SESSION_PATH;
    registrarEventoSessao(`SESSAO_APAGADA motivo=${motivo}`);
    if (fs.existsSync(authPath)) {
        console.warn(`🧹 [SISTEMA] APAGANDO a pasta de sessão. Motivo: ${motivo}. Será necessário ler o QR Code novamente.`);
        // Preserva o histórico — é justamente o apagamento que precisamos poder
        // auditar depois — e as conexões recentes (o teto por hora não pode
        // zerar só porque a sessão foi apagada).
        const preservados = {};
        for (const arq of [EVENTS_LOG, CONEXOES_LOG]) {
            try { preservados[arq] = fs.readFileSync(arq, 'utf8'); } catch (_) {}
        }
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.warn('⚠️ [SISTEMA] Sessão removida — o serviço voltará pedindo QR Code.');
        } catch (err) {
            console.error('❌ [SISTEMA] Erro ao deletar pasta de auth:', err);
        }
        for (const [arq, conteudo] of Object.entries(preservados)) {
            try {
                fs.mkdirSync(authPath, { recursive: true });
                fs.writeFileSync(arq, conteudo);
            } catch (_) {}
        }
    }
}

// Quantos itens de sessão existem, ignorando os arquivos de controle.
function temSessao() {
    try {
        if (!fs.existsSync(SESSION_PATH)) return 0;
        return fs.readdirSync(SESSION_PATH)
            .filter(f => !ARQUIVOS_DE_CONTROLE.includes(f)).length;
    } catch (_) { return 0; }
}

// Diagnóstico de boot: responde objetivamente se a sessão sobreviveu ao restart.
function diagnosticarSessao() {
    try {
        // O log de eventos vive dentro da pasta e NÃO conta como sessão —
        // senão uma pasta recém-apagada pareceria ter sessão válida.
        const arquivos = temSessao();
        if (arquivos === 0) {
            console.warn('🔎 [SESSÃO] Nenhuma sessão encontrada no disco — este boot exigirá QR Code.');
            registrarEventoSessao('BOOT sessao=AUSENTE');
            return;
        }
        const st = fs.statSync(SESSION_PATH);
        console.log(`🔎 [SESSÃO] Sessão encontrada (${arquivos} item(ns), modificada em ${st.mtime.toISOString()}) — deve reconectar sem QR.`);
        registrarEventoSessao(`BOOT sessao=PRESENTE itens=${arquivos} mtime=${st.mtime.toISOString()}`);
    } catch (e) {
        console.warn('🔎 [SESSÃO] Falha ao diagnosticar a sessão:', e.message);
    }
}

// ─── POLÍTICA DE CONEXÃO (ANTI-BANIMENTO) ─────────────────────────────────────
// Cada inicialização abre o WhatsApp Web e restaura a sessão nos servidores do
// WhatsApp. Ciclos rápidos de conecta/desconecta são lidos pelo antiabuso como
// automação suspeita e levam à restrição do número (relatos de 48–72 h, que
// recomeçam a cada nova tentativa). Detalhes em docs/whatsapp-anti-banimento.md.
//  1. Espera crescente entre tentativas automáticas, com variação aleatória.
//  2. Teto de conexões por hora gravado no volume: vale também quando o
//     container reinicia em loop (crash não zera a contagem).
//  3. Disjuntor: após N falhas seguidas, no máximo uma tentativa a cada 30 min.
//  4. Bloqueio do número (TOS_BLOCK) e sessão aberta em outro lugar (CONFLICT)
//     NUNCA reconectam sozinhos — insistir aí é o que agrava a restrição.
//  5. Reinício manual passa por cima da espera, mas não do teto absoluto.
const ESPERAS_RECONEXAO_MS = [15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3];
const LIMITE_CONEXOES_HORA = 8;          // automáticas (inclui o boot)
const LIMITE_ABSOLUTO_HORA = 15;         // nem o reinício manual passa disso
const FALHAS_PARA_ABRIR_DISJUNTOR = 5;
const ESPERA_DISJUNTOR_MS = 30 * 60e3;
const INTERVALO_MIN_REINICIO_MANUAL_MS = 60e3;
const UMA_HORA_MS = 60 * 60e3;
// Conexão que cai logo depois de ficar pronta conta como falha: só zera a
// sequência quem ficou de pé esse tempo (senão cai-volta a cada 2 min nunca
// aumentaria a espera).
const CONEXAO_ESTAVEL_MS = 10 * 60e3;
const MOTIVOS_SEM_RECONEXAO = {
    TOS_BLOCK: 'o WhatsApp bloqueou este número (TOS_BLOCK)',
    SMB_TOS_BLOCK: 'o WhatsApp bloqueou este número Business (SMB_TOS_BLOCK)',
    CONFLICT: 'a mesma sessão foi aberta em outro lugar (CONFLICT) — confira se não há dois serviços usando este número',
};

let falhasSeguidas = 0;
let prontoDesde = null;
let pausa = null;               // { motivo, ate } — ate = null: só reinício manual
let proximaTentativaEm = null;
let ultimoReinicioManual = 0;

function lerConexoes() {
    try {
        const lista = JSON.parse(fs.readFileSync(CONEXOES_LOG, 'utf8'));
        const limite = Date.now() - UMA_HORA_MS;
        return Array.isArray(lista) ? lista.filter(t => Number.isFinite(t) && t > limite) : [];
    } catch (_) {
        return [];
    }
}

function registrarConexao() {
    const lista = [...lerConexoes(), Date.now()];
    try {
        fs.mkdirSync(SESSION_PATH, { recursive: true });
        fs.writeFileSync(CONEXOES_LOG, JSON.stringify(lista));
    } catch (_) { /* controle nunca pode derrubar o serviço */ }
    return lista.length;
}

// Quanto falta para liberar uma vaga no teto da última hora (0 = liberado).
function esperaPeloTeto(limite) {
    const lista = lerConexoes();
    if (lista.length < limite) return 0;
    const maisAntiga = Math.min(...lista.slice(-limite));
    return Math.max(0, maisAntiga + UMA_HORA_MS - Date.now()) + 30e3;
}

const comVariacao = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
const horaBR = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

function agendarInicializacao(espera) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    proximaTentativaEm = Date.now() + espera;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        proximaTentativaEm = null;
        console.log('🔄 [SISTEMA] Tentando reconectar automaticamente...');
        initClient();
    }, espera);
}

// Para de reconectar sozinho. `ate` = horário da próxima tentativa, ou null
// quando só um humano pode decidir (bloqueio, conflito).
function pausarReconexao(motivo, ate = null) {
    pausa = { motivo, ate };
    clientStatus = 'PAUSADO';
    qrRaw = null;
    registrarEventoSessao(`RECONEXAO_PAUSADA motivo=${motivo} ate=${ate ? new Date(ate).toISOString() : 'manual'}`);
    console.warn(`⛔ [CONEXÃO] Reconexão automática pausada: ${motivo}. ` +
        (ate ? `Próxima tentativa às ${horaBR(ate)}.` : 'Só volta com reinício manual pelo painel.'));
    if (ate) agendarInicializacao(ate - Date.now());
    else if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; proximaTentativaEm = null; }
}

// Única porta de entrada para reconexão automática: decide QUANDO (e se)
// tentar de novo segundo a política acima.
function agendarReconexao(motivo = 'falha') {
    if (pausa && pausa.ate === null) return; // aguardando decisão humana
    if (prontoDesde && Date.now() - prontoDesde >= CONEXAO_ESTAVEL_MS) falhasSeguidas = 0;
    prontoDesde = null;
    falhasSeguidas++;
    let espera = comVariacao(ESPERAS_RECONEXAO_MS[Math.min(falhasSeguidas - 1, ESPERAS_RECONEXAO_MS.length - 1)]);
    let motivoPausa = null;

    if (falhasSeguidas >= FALHAS_PARA_ABRIR_DISJUNTOR) {
        espera = Math.max(espera, comVariacao(ESPERA_DISJUNTOR_MS));
        motivoPausa = `${falhasSeguidas} falhas seguidas (última: ${motivo})`;
    }
    const peloTeto = esperaPeloTeto(LIMITE_CONEXOES_HORA);
    if (peloTeto > espera) {
        espera = peloTeto;
        motivoPausa = `limite de ${LIMITE_CONEXOES_HORA} conexões por hora atingido (última falha: ${motivo})`;
    }

    if (motivoPausa) {
        pausarReconexao(motivoPausa, Date.now() + espera);
        return;
    }
    clientStatus = 'DESCONECTADO';
    console.log(`⏱️ [CONEXÃO] ${motivo} — nova tentativa em ${Math.round(espera / 1000)} s (falha ${falhasSeguidas} seguida).`);
    agendarInicializacao(espera);
}

// Boot também é conexão: se o container está reiniciando em loop, o teto
// gravado no volume segura a próxima tentativa em vez de conectar de novo.
function iniciarNoBoot() {
    const espera = esperaPeloTeto(LIMITE_CONEXOES_HORA);
    if (espera > 0) {
        pausarReconexao(`o serviço já conectou ${lerConexoes().length} vezes na última hora (reinícios do container?)`, Date.now() + espera);
        return;
    }
    initClient();
}

// ─── ROTA PÚBLICA ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send('🟢 Microsserviço WhatsApp FrotasMAK operando de forma segura.');
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
async function initClient() {
    const geracao = ++geracaoCliente;
    const atual = () => geracao === geracaoCliente;
    // Um reconnect já agendado mataria esta instância no meio do initialize.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    inicializando = true;

    if (client) {
        console.log('🔄 [SISTEMA] Destruindo instância anterior do Chromium...');
        // O listener de 'framenavigated' da lib reinjeta o WWebJS a cada
        // navegação. Se o destroy fecha o Chromium com uma injeção em curso,
        // o evaluate cai em frame "detached" e derruba o processo.
        try { client.pupPage?.removeAllListeners('framenavigated'); } catch (_) {}
        try {
            await client.destroy();
        } catch (e) {
            console.log('⚠️ [SISTEMA] Aviso ao destruir Chromium:', e.message);
        }
    }
    // Outro initClient começou enquanto este esperava o destroy — ele assume.
    if (!atual()) return;

    clientStatus = 'DESCONECTADO';
    qrRaw = null;
    pausa = null;
    proximaTentativaEm = null;

    const conexoesNaHora = registrarConexao();
    console.log(`⏳ [WHATSAPP] Inicializando nova instância (#${geracao}) — conexão ${conexoesNaHora} de ${LIMITE_CONEXOES_HORA} permitidas na última hora...`);

    const puppeteerConfig = {
        args: PUPPETEER_ARGS,
        timeout: 120000,
        headless: true,
    };

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (execPath) puppeteerConfig.executablePath = execPath;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
        puppeteer: puppeteerConfig,
    });

    client.on('qr', (qr) => {
        if (!atual()) return; // instância já substituída
        console.log('💡 [WHATSAPP] Novo QR Code gerado. Aguardando escaneamento...');
        qrRaw = qr;
        clientStatus = 'QR_PRONTO';
    });

    client.on('loading_screen', (percent, message) => {
        if (!atual()) return; // instância já substituída
        console.log(`⏳ [WHATSAPP] Carregando: ${percent}% - ${message}`);
        clientStatus = 'AUTENTICANDO';
    });

    client.on('ready', () => {
        if (!atual()) return; // instância já substituída
        console.log('✅ [WHATSAPP] Cliente pronto e conectado!');
        clientStatus = 'PRONTO';
        qrRaw = null;
        prontoDesde = Date.now();
    });

    client.on('authenticated', () => {
        if (!atual()) return; // instância já substituída
        console.log('🔐 [WHATSAPP] Autenticado com sucesso! Baixando contatos e mensagens...');
        clientStatus = 'AUTENTICANDO';
        qrRaw = null;
        falhasAuthConsecutivas = 0;
        registrarEventoSessao('AUTHENTICATED');
    });

    client.on('auth_failure', (msg) => {
        if (!atual()) return; // instância já substituída
        console.error('❌ [WHATSAPP] Falha na autenticação:', msg);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        registrarEventoSessao(`AUTH_FAILURE msg=${String(msg).slice(0, 120)}`);

        // Antes apagava na PRIMEIRA falha. Falha de autenticação também ocorre
        // por motivo transitório (Chromium morto no meio do load, rede), e
        // apagar já na primeira transformava um soluço em "leia o QR de novo".
        falhasAuthConsecutivas++;
        if (falhasAuthConsecutivas >= MAX_FALHAS_AUTH) {
            limparPastaSessao(`auth_failure ${falhasAuthConsecutivas}x consecutivas`);
            falhasAuthConsecutivas = 0;
        } else {
            console.warn(`⚠️ [WHATSAPP] Sessão PRESERVADA (falha ${falhasAuthConsecutivas}/${MAX_FALHAS_AUTH}). Tentando reconectar com a sessão existente.`);
        }
        agendarReconexao('falha de autenticação');
    });

    client.on('disconnected', (reason) => {
        if (!atual()) return; // instância já substituída
        console.log('❌ [WHATSAPP] WhatsApp desconectado!', reason);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        registrarEventoSessao(`DISCONNECTED reason=${reason}`);

        // Bloqueio do número ou sessão aberta em outro lugar: reconectar sozinho
        // agrava a restrição (e no conflito vira cabo de guerra entre as duas
        // instâncias). Fica parado até alguém resolver e reiniciar pelo painel.
        const semReconexao = MOTIVOS_SEM_RECONEXAO[String(reason).toUpperCase()];
        if (semReconexao) {
            pausarReconexao(semReconexao);
            return;
        }

        // Só apagamos quando a sessão está de fato morta do lado do WhatsApp.
        // NAVIGATION é transitório — ocorre em reload/crash do Chromium e no
        // restart do container. Apagar aí destruía uma sessão perfeitamente
        // válida, e era isso que fazia o serviço voltar pedindo QR Code.
        // CONFLICT (outro aparelho assumiu) também não justifica apagar.
        const SESSAO_MORTA = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE'];
        if (SESSAO_MORTA.includes(String(reason).toUpperCase())) {
            limparPastaSessao(`disconnected reason=${reason}`);
        } else {
            console.warn(`⚠️ [WHATSAPP] Sessão PRESERVADA (motivo "${reason}" é transitório). Reconectando sem QR.`);
        }
        agendarReconexao(`desconectado (${reason})`);
    });

    // ─── HANDLER DE MENSAGENS RECEBIDAS ─────────────────────────────────────────
    client.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us') || msg.fromMe) return;

        const BACKEND_URL    = process.env.BACKEND_WEBHOOK_URL;
        const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
        if (!BACKEND_URL) return;

        try {
            // Passa o from original (incluindo @lid) — o backend usa para enviar a resposta
            const from = msg.from;

            // Resolve o número de telefone real do contato para identificação no banco
            let phoneNumber = null;
            if (from.endsWith('@lid')) {
                try {
                    const phoneWid = await client.pupPage.evaluate(async (lid) => {
                        const result = await window.WWebJS.enforceLidAndPnRetrieval(lid);
                        return result?.phone?._serialized || null;
                    }, from);
                    if (phoneWid) phoneNumber = phoneWid.replace(/@\S+$/, '');
                } catch (_) {}
            } else {
                phoneNumber = from.replace(/@\S+$/, '');
            }

            let mediaBase64 = null, mediaMimetype = null;

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media && media.mimetype?.startsWith('image/')) {
                        const MAX_BYTES = 2 * 1024 * 1024; // 2 MB após compressão
                        const original = Buffer.from(media.data, 'base64');
                        let finalBuffer = original;

                        if (original.length > MAX_BYTES) {
                            finalBuffer = await sharp(original)
                                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                                .jpeg({ quality: 80 })
                                .toBuffer();

                            // Se ainda acima do limite, reduz mais agressivamente
                            if (finalBuffer.length > MAX_BYTES) {
                                finalBuffer = await sharp(original)
                                    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                                    .jpeg({ quality: 65 })
                                    .toBuffer();
                            }

                            console.log(`[CHATBOT] Imagem comprimida: ${(original.length / 1024).toFixed(0)} KB → ${(finalBuffer.length / 1024).toFixed(0)} KB`);
                        }

                        mediaBase64 = finalBuffer.toString('base64');
                        mediaMimetype = 'image/jpeg';
                    } else if (media) {
                        mediaBase64 = media.data;
                        mediaMimetype = media.mimetype;
                    }
                } catch (_) {}
            }

            await fetch(`${BACKEND_URL}/api/whatsapp/webhook`, {
                method:  'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'x-webhook-secret': WEBHOOK_SECRET || '',
                },
                body: JSON.stringify({
                    from,
                    phoneNumber,
                    body:          msg.body || '',
                    hasMedia:      msg.hasMedia,
                    mediaBase64,
                    mediaMimetype,
                    timestamp:     msg.timestamp,
                }),
                timeout: 30000,
            });

            console.log(`📩 [CHATBOT] Mensagem de ${from} encaminhada ao backend.`);
        } catch (err) {
            console.error('[CHATBOT] Erro ao encaminhar mensagem:', err.message);
        }
    });

    try {
        await client.initialize();
    } catch (err) {
        // Esta instância foi destruída por um initClient mais novo: o erro é
        // consequência do destroy, não falha real — quem assumiu segue sozinho.
        if (!atual()) {
            console.log(`ℹ️ [SISTEMA] Inicialização #${geracao} interrompida pela instância #${geracaoCliente} — ignorando.`);
            return;
        }
        console.error('🚨 [CRÍTICO] Erro fatal ao iniciar o Puppeteer:', err);
        agendarReconexao('falha ao iniciar o WhatsApp Web');
    } finally {
        if (atual()) inicializando = false;
    }
}

// ─── ROTAS DA API PROTEGIDAS ──────────────────────────────────────────────────

app.get('/status', (req, res) => {
    // sessaoPersistida responde a pergunta que estava sem resposta: a sessão
    // sobreviveu ao último restart, ou o serviço voltou do zero?
    const sessaoPersistida = temSessao() > 0;
    res.json({
        status: clientStatus,
        qr: qrRaw,
        sessionPath: SESSION_PATH,
        sessaoPersistida,
        iniciadoEm: BOOT_TIME,
        patchMidia: PATCH_MIDIA,
        // Política anti-banimento — o painel mostra por que está parado e até quando.
        conexao: {
            pausado: !!pausa,
            motivo: pausa?.motivo || null,
            somenteManual: !!pausa && pausa.ate === null,
            proximaTentativaEm: proximaTentativaEm ? new Date(proximaTentativaEm).toISOString() : null,
            conexoesUltimaHora: lerConexoes().length,
            limiteHora: LIMITE_CONEXOES_HORA,
            falhasSeguidas,
        },
    });
});

// Histórico de eventos da sessão (boot, autenticação, quedas, apagamentos).
// Fica no volume, então mostra o que aconteceu ANTES do restart atual.
app.get('/session-events', (req, res) => {
    try {
        if (!fs.existsSync(EVENTS_LOG)) return res.json({ arquivo: EVENTS_LOG, eventos: [] });
        const linhas = fs.readFileSync(EVENTS_LOG, 'utf8').trim().split('\n');
        res.json({ arquivo: EVENTS_LOG, eventos: linhas.slice(-200) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── RITMO DE ENVIO (ANTI-BANIMENTO) ──────────────────────────────────────────
// Uma mensagem por vez, com intervalo mínimo e variação aleatória: várias ordens
// ou avisos do cron disparados juntos viram envios espaçados — rajada com
// intervalo fixo é um dos sinais que o antiabuso do WhatsApp usa. Os chamadores
// do backend enviam em sequência (await), então a fila fica curta e não estoura
// o timeout de 120 s do backend.
const INTERVALO_ENVIO_MS = 2500;
const VARIACAO_ENVIO_MS = 2000;
let filaEnvio = Promise.resolve();
let ultimoEnvio = 0;

function reservarVezDeEnvio() {
    let liberar;
    const minhaVez = new Promise(r => { liberar = r; });
    const anterior = filaEnvio;
    filaEnvio = anterior.then(() => minhaVez);
    return anterior.then(async () => {
        const espera = ultimoEnvio + INTERVALO_ENVIO_MS + Math.random() * VARIACAO_ENVIO_MS - Date.now();
        if (espera > 0) await new Promise(r => setTimeout(r, espera));
        return () => { ultimoEnvio = Date.now(); liberar(); };
    });
}

// Número → ID do WhatsApp. Cada getNumberId pergunta aos servidores do WhatsApp
// se o número tem conta; consultar números repetidamente é padrão de robô de
// disparo. Os destinatários (postos, RH, operadores) são quase sempre os mesmos.
const CACHE_NUMERO_MS = 24 * 60 * 60e3;
const CACHE_NUMERO_SEM_CONTA_MS = 60 * 60e3;
const cacheNumeros = new Map(); // número → { id: string|null, em }

function numeroEmCache(numero) {
    const c = cacheNumeros.get(numero);
    if (!c) return undefined;
    const validade = c.id ? CACHE_NUMERO_MS : CACHE_NUMERO_SEM_CONTA_MS;
    if (Date.now() - c.em > validade) { cacheNumeros.delete(numero); return undefined; }
    return c.id;
}

app.post('/send', async (req, res) => {
    if (clientStatus !== 'PRONTO') {
        return res.status(503).json({ error: `WhatsApp não está pronto. Status atual: ${clientStatus}` });
    }

    const { number, message, documentUrl, documentFilename, documentBase64, documentMimetype } = req.body;

    const liberarVez = await reservarVezDeEnvio();
    try {
        // Suporta @c.us — usa o sufixo original se já vier com @
        let chatId = number.includes('@') ? number : `${number}@c.us`;

        // Para @lid: usa enforceLidAndPnRetrieval para registrar o mapeamento localmente
        // e obter o WID do telefone, que o sendMessage consegue usar corretamente
        if (chatId.endsWith('@lid')) {
            try {
                const phoneWid = await client.pupPage.evaluate(async (lid) => {
                    const result = await window.WWebJS.enforceLidAndPnRetrieval(lid);
                    return result?.phone?._serialized || null;
                }, chatId);
                if (phoneWid) {
                    console.log(`[SEND] LID resolvido para telefone: ${chatId} → ${phoneWid}`);
                    chatId = phoneWid;
                } else {
                    console.warn(`[SEND] Não foi possível resolver LID ${chatId} para telefone — tentando enviar ao LID diretamente.`);
                }
            } catch (lidErr) {
                console.warn(`[SEND] Erro ao resolver LID ${chatId}:`, lidErr.message);
            }
        } else {
            try {
                const plainNumber = number.replace(/\D/g, '');
                let resolvedId = numeroEmCache(plainNumber);
                if (resolvedId === undefined) {
                    const resolved = await client.getNumberId(plainNumber);
                    resolvedId = resolved?._serialized || null;
                    cacheNumeros.set(plainNumber, { id: resolvedId, em: Date.now() });
                }
                if (resolvedId) {
                    chatId = resolvedId;
                    console.log(`[SEND] ID resolvido: ${plainNumber} → ${chatId}`);
                } else {
                    console.warn(`⚠️ Número ${plainNumber} não encontrado no WhatsApp.`);
                    return res.status(400).json({ error: `Número ${number} não possui conta no WhatsApp.` });
                }
            } catch (resolveErr) {
                console.warn('⚠️ Não foi possível resolver ID, tentando com @c.us:', resolveErr.message);
            }
        }

        const resp = await client.sendMessage(chatId, message);
        const messageId = resp?.id?._serialized || null;

        let pdfStatus = null;
        if (documentBase64 || documentUrl) {
            try {
                let media;
                if (documentBase64) {
                    // Caminho preferencial: PDF embutido no payload (sem depender de
                    // o container do WhatsApp conseguir baixar a URL pública).
                    console.log(`📎 Anexo recebido como base64 (${Math.round(documentBase64.length * 0.75 / 1024)} KB)`);
                    media = new MessageMedia(
                        documentMimetype || 'application/pdf',
                        documentBase64,
                        documentFilename || 'Ordem_Abastecimento_FrotasMAK.pdf'
                    );
                } else {
                    console.log(`📎 Baixando anexo de: ${documentUrl}`);
                    media = await MessageMedia.fromUrl(documentUrl, { unsafeMime: true });
                    const fromUrl = (() => {
                        try {
                            const tail = decodeURIComponent(documentUrl.split('?')[0].split('/').pop() || '');
                            return tail && tail.toLowerCase().endsWith('.pdf') ? tail : null;
                        } catch { return null; }
                    })();
                    media.filename = documentFilename || fromUrl || 'Ordem_Abastecimento_FrotasMAK.pdf';
                }
                await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
                pdfStatus = 'enviado';
            } catch (pdfErr) {
                console.warn(`⚠️ Falha ao enviar PDF para ${number}:`, pdfErr.message || pdfErr);
                pdfStatus = `falha: ${pdfErr.message || pdfErr}`;
                // Sem anexo o posto fica sem o documento. Se há URL pública, manda
                // o link como texto — a entrega segue PARCIAL (o anexo não foi),
                // mas quem recebe consegue abrir o PDF.
                if (documentUrl) {
                    try {
                        await client.sendMessage(chatId, `📎 PDF da ordem: ${documentUrl}`);
                        pdfStatus += ' — link do PDF enviado no lugar';
                    } catch (linkErr) {
                        console.warn(`⚠️ Falha ao enviar link do PDF para ${number}:`, linkErr.message || linkErr);
                    }
                }
            }
        }

        console.log(`✅ Mensagem enviada para -> ${number}`);
        res.json({ success: true, messageId, pdfStatus });

    } catch (err) {
        // whatsapp-web.js pode lançar valores não-padrão (strings minificadas como "t", "e", etc.)
        let errMsg;
        if (err instanceof Error) {
            errMsg = err.message;
        } else if (typeof err === 'string') {
            errMsg = err;
        } else {
            try { errMsg = JSON.stringify(err); } catch (_) { errMsg = String(err); }
        }

        // Se o erro é uma única letra, provavelmente é um erro minificado do WA Web
        if (errMsg && errMsg.length <= 2) {
            console.error(`❌ Erro ao enviar mensagem (código WA minificado "${errMsg}"):`, err);
            errMsg = `Erro interno do WhatsApp Web (código: "${errMsg}"). Verifique se o número existe e o cliente está estável.`;
        } else {
            console.error('❌ Erro ao enviar mensagem:', err);
        }

        res.status(500).json({ error: errMsg || 'Erro desconhecido ao enviar mensagem.' });
    } finally {
        liberarVez();
    }
});

// Reinício. Por padrão PRESERVA a sessão — só reinicializa o Chromium, o que
// costuma resolver travas do WA Web sem exigir novo QR Code.
// Envie { "hard": true } para apagar a sessão e forçar novo pareamento.
// O reinício manual passa por cima da espera e do disjuntor (é decisão humana),
// mas não da espera mínima entre cliques nem do teto absoluto por hora:
// reiniciar em sequência é justamente o padrão que leva ao bloqueio.
app.post('/restart', async (req, res) => {
    const hard = req.body?.hard === true;
    const agora = Date.now();
    const desdeUltimo = agora - ultimoReinicioManual;
    if (desdeUltimo < INTERVALO_MIN_REINICIO_MANUAL_MS) {
        const s = Math.ceil((INTERVALO_MIN_REINICIO_MANUAL_MS - desdeUltimo) / 1000);
        return res.status(429).json({ error: `Aguarde ${s} s para reiniciar de novo — reinícios em sequência podem levar ao bloqueio do número.` });
    }
    const peloTeto = esperaPeloTeto(LIMITE_ABSOLUTO_HORA);
    if (peloTeto > 0) {
        return res.status(429).json({
            error: `Limite de segurança: ${lerConexoes().length} conexões na última hora. Novo reinício liberado às ${horaBR(agora + peloTeto)}.`,
        });
    }
    ultimoReinicioManual = agora;

    console.log(`🔄 Reinício manual solicitado (${hard ? 'HARD — apaga sessão' : 'soft — preserva sessão'}).`);
    registrarEventoSessao(`REINICIO_MANUAL hard=${hard}${pausa ? ` (estava pausado: ${pausa.motivo})` : ''}`);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    falhasSeguidas = 0;
    pausa = null;
    proximaTentativaEm = null;

    if (hard) limparPastaSessao('reinício manual (hard) solicitado pelo admin');

    setTimeout(() => { initClient(); }, 1000);

    res.json({
        success: true,
        hard,
        message: hard
            ? 'Sessão apagada. Será necessário ler o QR Code novamente.'
            : 'Reiniciando sem apagar a sessão. Se não reconectar, use o reinício completo.',
    });
});

// ─── ERROS NÃO TRATADOS ───────────────────────────────────────────────────────
// O whatsapp-web.js registra `framenavigated` como listener async sem catch:
// quando o WA Web recarrega a página (troca de build, NAVIGATION) ou o Chromium
// é fechado no meio da reinjeção, o page.evaluate rejeita com "Attempted to use
// detached Frame" / "Target closed". No Node 18 rejeição não tratada MATA o
// processo — o container caía. Aqui o erro vira reconexão preservando a sessão.
const ERRO_CHROMIUM = /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|Navigating frame was detached/i;

// A página segue com o WWebJS injetado? Depois de um reload do WA Web a lib
// reinjeta sozinha na navegação seguinte — reconectar aí só derrubaria uma
// sessão que já se recuperou.
async function clienteSaudavel() {
    try {
        const page = client?.pupPage;
        if (!page || page.isClosed()) return false;
        return await page.evaluate('typeof window.WWebJS !== "undefined"');
    } catch (_) {
        return false;
    }
}

function tratarErroNaoCapturado(tipo, err) {
    const msg = err?.message || String(err);
    if (ERRO_CHROMIUM.test(msg)) {
        // Durante a inicialização quem trata a falha é o catch do initialize.
        // Agendar reconexão aqui matava a instância no meio do boot (loop).
        if (inicializando) {
            console.warn(`⚠️ [SISTEMA] ${tipo} do Chromium durante a inicialização (${msg}) — ignorado.`);
            return;
        }
        console.warn(`⚠️ [SISTEMA] ${tipo} do Chromium/WA Web (${msg}). Conferindo a página antes de reconectar.`);
        registrarEventoSessao(`CHROMIUM_ERRO ${msg.slice(0, 120)}`);
        const geracao = geracaoCliente;
        setTimeout(async () => {
            if (inicializando || geracao !== geracaoCliente) return;
            if (await clienteSaudavel()) {
                console.log('✅ [SISTEMA] Página do WhatsApp segue saudável — sem reconexão.');
                return;
            }
            agendarReconexao('página do WhatsApp perdeu o WWebJS');
        }, 5000);
        return;
    }
    console.error(`🚨 [SISTEMA] ${tipo}:`, err);
}
process.on('unhandledRejection', (err) => tratarErroNaoCapturado('Rejeição não tratada', err));
process.on('uncaughtException', (err) => tratarErroNaoCapturado('Exceção não capturada', err));

// ─── STARTUP ──────────────────────────────────────────────────────────────────
diagnosticarSessao();
iniciarNoBoot();

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log(`║  🟢 FrotaMAK WhatsApp Service          ║`);
    console.log(`║  📡 Porta: ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════╝');
});
