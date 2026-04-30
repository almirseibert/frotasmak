const axios = require('axios');
const db = require('../database'); // Conexão com o banco de dados do Frotas MAK

const WPP_API_URL = 'https://evo.frotamak.com';
const WPP_INSTANCE_NAME = 'FrotaMAK'; 
const WPP_API_KEY = process.env.WPP_API_KEY; 

// Lista de contatos internos padronizada
const CONTATOS_INTERNOS = {
    ALMIR: '555199111090',  // Responsável por oficina da frota leve, rastreamento, tecnologia, inovação, suporte técnico e sistema de gestão de frotas
    LEANDRO: '555192481722',  // Responsável por compras, fornecedores e contratos
    PLINIO: '555180348479',  // Responsável por logística e transporte
    AMANDA: '555198196762',  // Responsável por abastecimento
    MARLISE: '555196588016', // Responsável por refeições e hospedagem
    RH: '555181598177', // Responsável por recursos humanos e questões administrativas
    SAULO: '555197120502', // Responsável por oficina de caminhões e máquinas, manutenção preventiva e corretiva
    ALEXANDRO: '555181708680' // Responsável por contratos, licitações, cobranças e questões jurídicas relacionadas às obras
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
  // Agora exigimos mais informações para ter um log perfeito
  async enviarMensagem(numeroDestino, nomeDestinatario, motivo, mensagem, anexoUrl = null) {
    const numeroFormatado = formatarNumero(numeroDestino);

    if (!numeroFormatado) {
        console.error('❌ Número inválido para envio.');
        return;
    }

    try {
      const data = {
        number: numeroFormatado,
        text: mensagem,
        delay: 1200
      };

      // Dispara para a Evolution API
      const response = await axios.post(
        `${WPP_API_URL}/message/sendText/${WPP_INSTANCE_NAME}`,
        data,
        { headers: { 'apikey': WPP_API_KEY } }
      );
      
      const messageId = response.data?.key?.id || null;

      // Grava o histórico no Banco de Dados
      const query = `
        INSERT INTO whatsapp_logs 
        (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, message_id_api, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      const values = [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, messageId, 'ENVIADO'];
      
      await db.query(query, values);

      console.log(`✅ Mensagem enviada e salva no log para ${nomeDestinatario} (${numeroFormatado})`);
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
  
  // Exportamos os contatos para usar nos Controllers
  CONTATOS_INTERNOS 
};

module.exports = whatsappService;