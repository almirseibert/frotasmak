const axios = require('axios');
const db = require('../database');

const WA_URL = process.env.WHATSAPP_SERVICE_URL; // ex: http://frotasmak-whatsapp:3002
const WA_KEY = process.env.WHATSAPP_SERVICE_KEY;

const CONTATOS_INTERNOS = {
    ALMIR:     '555199111090',
    LEANDRO:   '555192481722',
    PLINIO:    '555180348479',
    AMANDA:    '555198196762',
    MARLISE:   '555196588016',
    RH:        '555181598177',
    SAULO:     '555197120502',
    ALEXANDRO: '555181708680'
};

function formatarNumero(numero) {
    if (!numero) return null;
    let limpo = String(numero).replace(/\D/g, '');
    if (limpo.length === 8 || limpo.length === 9) return '5551' + limpo;
    if (limpo.length === 10 || limpo.length === 11) return '55' + limpo;
    return limpo;
}

function waHeaders() {
    return { apikey: WA_KEY };
}

const whatsappService = {
    async getStatus() {
        if (!WA_URL) return { status: 'NAO_CONFIGURADO', qr: null };
        try {
            const { data } = await axios.get(`${WA_URL}/status`, { headers: waHeaders(), timeout: 5000 });
            return data;
        } catch (err) {
            return { status: 'DESCONECTADO', qr: null };
        }
    },

    async reiniciar() {
        if (!WA_URL) throw new Error('WHATSAPP_SERVICE_URL não configurado.');
        await axios.post(`${WA_URL}/restart`, {}, { headers: waHeaders(), timeout: 5000 });
    },

    async enviarMensagem(numeroDestino, nomeDestinatario, motivo, mensagem, anexoUrl = null) {
        if (!WA_URL) throw new Error('WHATSAPP_SERVICE_URL não configurado no backend.');

        const numeroFormatado = formatarNumero(numeroDestino);
        if (!numeroFormatado) {
            console.error('❌ Número inválido para envio:', numeroDestino);
            return;
        }

        try {
            const payload = { number: numeroFormatado, message: mensagem };
            if (anexoUrl) payload.documentUrl = anexoUrl.replace('http://', 'https://');

            const { data } = await axios.post(
                `${WA_URL}/send`,
                payload,
                { headers: waHeaders(), timeout: 15000 }
            );

            const messageId = data.messageId || null;

            await db.query(
                `INSERT INTO whatsapp_logs
                 (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, message_id_api, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, messageId, 'ENVIADO']
            );

            console.log(`✅ Mensagem enviada para ${nomeDestinatario} (${numeroFormatado})`);
            return data;

        } catch (error) {
            const erroReal = error.response?.data?.error || error.message;
            console.error('❌ Erro no envio WhatsApp:', erroReal);

            try {
                await db.query(
                    `INSERT INTO whatsapp_logs
                     (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, status)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, 'FALHA']
                );
            } catch (_) {}

            throw new Error(JSON.stringify(erroReal));
        }
    },

    CONTATOS_INTERNOS
};

module.exports = whatsappService;