// Normalização de placa para consultas ao SigaSul.
//
// O formato da placa diverge entre as fontes: `vehicles.placa` costuma ter
// traço ("ABC-1234") enquanto `sigasul_positions.pos_placa` nem sempre tem
// ("ABC1234"). A solução anterior normalizava dentro do SQL:
//
//     WHERE REPLACE(REPLACE(UPPER(pos_placa),'-',''),' ','') = REPLACE(...)
//
// Isso funcionava, mas envolvia a coluna indexada numa função — e o MySQL não
// usa índice em coluna dentro de função. O índice `idx_placa_data` era
// ignorado e cada consulta varria as ~6 milhões de linhas da tabela.
//
// Normalizando aqui e comparando com `pos_placa IN (...)`, a comparação volta
// a ser direta sobre a coluna e o índice é usado. Preferimos isso a uma coluna
// gerada com índice porque um ALTER TABLE numa tabela de 750 MB é uma migração
// cara, e esta alternativa não exige mudança de schema.

/** Remove traços, espaços e caixa: "abc-1234" → "ABC1234". */
const normalizarPlaca = (placa) =>
    String(placa || '').toUpperCase().replace(/[-\s]/g, '');

/**
 * Variantes de escrita de uma placa, para casar com qualquer formato gravado
 * na origem sem precisar normalizar a coluna no SQL.
 *
 * Cobre os dois formatos em uso: sem separador ("ABC1234") e com traço após
 * os três primeiros caracteres ("ABC-1234"), que vale tanto para a placa
 * antiga (ABC-1234) quanto para o padrão Mercosul (ABC-1D23).
 *
 * @param {string} placa
 * @returns {string[]} variantes únicas, prontas para um `IN (?)`
 */
const variantesPlaca = (placa) => {
    const limpa = normalizarPlaca(placa);
    if (!limpa) return [];
    const variantes = new Set([limpa]);
    if (limpa.length > 3) {
        variantes.add(`${limpa.slice(0, 3)}-${limpa.slice(3)}`);
    }
    return [...variantes];
};

module.exports = { normalizarPlaca, variantesPlaca };
