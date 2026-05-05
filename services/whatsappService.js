const axios = require('axios');
const db = require('../database'); // Conexão com o banco de dados do Frotas MAK

const WPP_API_URL = 'https://evo.frotamak.com';
const WPP_INSTANCE_NAME = 'FrotaMAK'; 
const WPP_API_KEY = process.env.WPP_API_KEY; 

// Lista de contatos internos padronizada
const CONTATOS_INTERNOS = {
    ALMIR: '555199111090',
    LEANDRO: '555192481722',
    PLINIO: '555180348479',
    AMANDA: '555198196762',
    MARLISE: '555196588016',
    RH: '555199111090',
    SAULO: '555197120502',
    ALEXANDRO: '555181708680'
};

function formatarNumero(numero) {
    if (!numero) return null;
    let limpo = String(numero).replace(/\D/g, '');
    
    if (limpo.length === 8 || limpo.length === 9) {
        return '5551' + limpo; 
    } else if (limpo.length === 10 || limpo.length === 11) {
        return '55' + limpo;
    }
    return limpo;
}

const whatsappService = {
  async enviarMensagem(numeroDestino, nomeDestinatario, motivo, mensagem, anexoUrl = null) {
    const numeroFormatado = formatarNumero(numeroDestino);

    if (!numeroFormatado) {
        console.error('❌ Número inválido para envio.');
        return;
    }

    try {
      // 1. DISPARA A MENSAGEM DE TEXTO (Evolution API)
      const dataText = {
        number: numeroFormatado,
        text: mensagem,
        delay: 1200
      };

      const response = await axios.post(
        `${WPP_API_URL}/message/sendText/${WPP_INSTANCE_NAME}`,
        dataText,
        { headers: { 'apikey': WPP_API_KEY } }
      );
      
      const messageId = response.data?.key?.id || null;

      // 2. SE TIVER ANEXO (PDF), DISPARA O DOCUMENTO EM SEGUIDA
      if (anexoUrl) {
          // Garante que links HTTP passem para HTTPS se for o caso do Easypanel
          const secureUrl = anexoUrl.replace('http://', 'https://');
          
          const dataMedia = {
              number: numeroFormatado,
              mediatype: 'document',
              mimetype: 'application/pdf',
              fileName: 'Termo_Notificacao_FrotasMAK.pdf',
              media: secureUrl,
              delay: 1500
          };

          await axios.post(
            `${WPP_API_URL}/message/sendMedia/${WPP_INSTANCE_NAME}`,
            dataMedia,
            { headers: { 'apikey': WPP_API_KEY } }
          );
          console.log(`📎 Anexo enviado com sucesso para ${nomeDestinatario}`);
      }

      // 3. Grava o histórico no Banco de Dados
      const query = `
        INSERT INTO whatsapp_logs 
        (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, message_id_api, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      const values = [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, messageId, 'ENVIADO'];
      
      await db.query(query, values);

      console.log(`✅ Mensagem e log salvos para ${nomeDestinatario} (${numeroFormatado})`);
      return response.data;

    } catch (error) {
      const erroReal = error.response?.data?.message || error.response?.data || error.message;
      console.error('❌ Erro no envio de WhatsApp:', erroReal);

      // Grava o erro no Banco de Dados para auditoria
      try {
        const queryErro = `
          INSERT INTO whatsapp_logs 
          (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, status) 
          VALUES (?, ?, ?, ?, ?, ?)
        `;
        await db.query(queryErro, [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, 'FALHA']);
      } catch (dbError) {
        console.error('❌ Erro ao salvar falha no log do banco:', dbError.message);
      }

      throw new Error(JSON.stringify(erroReal)); 
    }
  },
  
  CONTATOS_INTERNOS 
};

module.exports = whatsappService;