// Utilitários de data no fuso oficial do sistema: America/Sao_Paulo (GMT-3).
//
// Motivo: `new Date().toISOString().slice(0, 10)` devolve a data em UTC, não em
// Brasília. Para qualquer valor a partir das 21h BRT o dia UTC já é o seguinte,
// o que causava agrupamentos/relatórios com a data trocada. Estas funções usam
// Intl (independente do tzdata do SO) para formatar sempre em BRT.

const TZ = 'America/Sao_Paulo';

// Retorna 'YYYY-MM-DD' no fuso de Brasília para um Date | timestamp | string.
// en-CA já formata como YYYY-MM-DD. Retorna null para entradas inválidas.
const ymdBRT = (input = new Date()) => {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-CA', { timeZone: TZ });
};

// Data de hoje ('YYYY-MM-DD') em Brasília.
const todayBRT = () => ymdBRT(new Date());

module.exports = { TZ, ymdBRT, todayBRT };
