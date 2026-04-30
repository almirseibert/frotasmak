const axios = require('axios');

// Sua URL da Evolution API
const WPP_API_URL = 'https://evo.frotamak.com';
const WPP_INSTANCE_NAME = 'FrotaMAK'; // Coloque o nome da instância que você criou na Evolution
const WPP_API_KEY = process.env.WPP_API_KEY; // A Global API Key da sua Evolution

function formatarNumero(numero) {
    if (!numero) return null;
    let limpo = String(numero).replace(/\D/g, '');
    
    if (limpo.length === 8 || limpo.length === 9) {
        return '5551' + limpo; // Adiciona Brasil + DDD (Ajuste o 51 se necessário)
    } else if (limpo.length === 10 || limpo.length === 11) {
        return '55' + limpo;
    }
    return limpo;
}

const whatsappService = {
  async enviarMensagem(numeroDestino, mensagem) {
    const numeroFormatado = formatarNumero(numeroDestino);

    try {
      const data = {
        number: numeroFormatado,
        options: { delay: 1200, presence: 'composing' },
        textMessage: { text: mensagem }
      };

      const response = await axios.post(
        `${WPP_API_URL}/message/sendText/${WPP_INSTANCE_NAME}`,
        data,
        { headers: { 'apikey': WPP_API_KEY } }
      );
      
      console.log(`✅ Mensagem enviada para ${numeroFormatado}`);
      return response.data;
    } catch (error) {
      console.error('❌ Erro no WhatsApp:', error.response?.data || error.message);
    }
  }
};

module.exports = whatsappService;