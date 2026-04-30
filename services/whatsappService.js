const axios = require('axios');

const WPP_API_URL = 'https://evo.frotamak.com';
const WPP_INSTANCE_NAME = 'FrotaMAK'; 
const WPP_API_KEY = process.env.WPP_API_KEY; 

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
  async enviarMensagem(numeroDestino, mensagem) {
    const numeroFormatado = formatarNumero(numeroDestino);

    try {
      // 🚀 FORMATO ATUALIZADO PARA A EVOLUTION API V2
      const data = {
        number: numeroFormatado,
        text: mensagem, // <-- Muito mais simples!
        delay: 1200
      };

      const response = await axios.post(
        `${WPP_API_URL}/message/sendText/${WPP_INSTANCE_NAME}`,
        data,
        { headers: { 'apikey': WPP_API_KEY } }
      );
      
      console.log(`✅ Mensagem enviada para ${numeroFormatado}`);
      return response.data;
    } catch (error) {
      // Melhoramos a captura do erro para ver o que tem dentro do tal [Array] se falhar de novo
      const erroReal = error.response?.data?.message || error.response?.data || error.message;
      console.error('❌ Erro no WhatsApp:', erroReal);
      throw new Error(JSON.stringify(erroReal)); 
    }
  }
};

module.exports = whatsappService;