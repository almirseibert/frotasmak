// Formatação de dinheiro no backend — WhatsApp, e-mail e PDF.
//
// Mesma regra do frontend (`frontend/src/utils/currency.js`): todo valor
// monetário sai com máscara de moeda brasileira e DUAS casas decimais.
// Aqui pesa mais: estas strings saem da empresa. `R$ 1234.56` num aviso de
// multa ou numa ordem de compra é erro visível para o cliente.

const FORMATADOR = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/** "R$ 1.234,56". Trata null/undefined/NaN como zero. */
const fmtBRL = (valor) => FORMATADOR.format(Number(valor) || 0);

/** Devolve travessão quando não há valor, em vez de fingir R$ 0,00. */
const fmtBRLouTraco = (valor, traco = '—') =>
    valor === null || valor === undefined || valor === ''
        || Number.isNaN(Number(valor))
        ? traco
        : FORMATADOR.format(Number(valor));

/** Preço por litro: três casas, convenção do setor de combustível. */
const fmtBRLLitro = (valor) =>
    (Number(valor) || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
    });

module.exports = { fmtBRL, fmtBRLouTraco, fmtBRLLitro };
