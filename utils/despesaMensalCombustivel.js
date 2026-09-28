// utils/despesaMensalCombustivel.js
//
// Despesa mensal de combustível por posto: "Combustível: dieselS10 - POSTO X
// (setembro de 2026)". É DERIVADA dos abastecimentos concluídos — recalculada
// do zero a cada baixa, edição ou exclusão de ordem.
//
// Até set/2026 a linha era localizada pela DESCRIÇÃO, que carrega o nome do
// posto. Renomeou o posto, a busca não achava a linha antiga, criava outra, e o
// mês passava a contar duas vezes (Ubiretama: VASLDIR → VALDIR). Agora a linha é
// localizada por `chaveMensal` = obra + ID do posto + combustível + mês, que não
// muda quando o cadastro do posto muda. O nome na descrição é só rótulo e é
// atualizado no próximo recálculo.

const crypto = require('crypto');

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
    'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Mês de competência em Brasília. `getMonth()` usa o fuso do processo, e o
// container roda em UTC: um abastecimento às 22h do último dia caía no mês
// seguinte.
const mesBRT = (dateInput) => {
    if (!dateInput) return null;
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return null;
    const [ano, mes] = d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-');
    return { ano: Number(ano), mes: Number(mes) };
};

const chaveMensal = (obraId, partnerId, fuelType, { ano, mes }) =>
    `${obraId || 'estoque'}|${partnerId}|${fuelType}|${ano}-${String(mes).padStart(2, '0')}`;

/**
 * Recalcula a despesa do mês para (obra, posto, combustível). obraId nulo =
 * "Estoque Comboio" (diesel comprado para o tanque do comboio; o custo da obra
 * entra na saída).
 */
const sincronizarDespesaMensal = async (conn, { obraId, partnerId, fuelType, dateInput }) => {
    if (!partnerId || !fuelType) return;
    const competencia = mesBRT(dateInput);
    if (!competencia) return;

    if (obraId) {
        const [obraCheck] = await conn.execute('SELECT id FROM obras WHERE id = ?', [obraId]);
        if (obraCheck.length === 0) return;
    }

    const { ano, mes } = competencia;
    const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const fim = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, '0')}-01`;

    // Strings de data são interpretadas no fuso do pool (-03:00): janela exata
    // do mês em Brasília.
    const [rows] = await conn.execute(`
        SELECT SUM(
            COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0) +
            COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0) +
            COALESCE(outrosValor, 0)
        ) AS total
          FROM refuelings
         WHERE partnerId = ?
           AND fuelType = ?
           AND status IN ('Concluída', 'Concluida')
           AND data >= ? AND data < ?
           AND ${obraId ? 'obraId = ?' : 'obraId IS NULL'}
    `, [partnerId, fuelType, inicio, fim, ...(obraId ? [obraId] : [])]);
    const total = parseFloat(rows[0]?.total) || 0;

    const [partners] = await conn.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';
    const description = `Combustível: ${fuelType} - ${partnerName} (${MESES[mes - 1]} de ${ano})`;
    const chave = chaveMensal(obraId, partnerId, fuelType, competencia);

    // 1º pela chave; 2º, para linhas anteriores à chave, pela descrição com o
    // nome atual — a linha achada é carimbada e deixa de depender do nome.
    let [existing] = await conn.execute('SELECT id FROM expenses WHERE chaveMensal = ?', [chave]);
    if (existing.length === 0) {
        [existing] = await conn.execute(
            `SELECT id FROM expenses
              WHERE description = ? AND chaveMensal IS NULL
                AND ${obraId ? 'obraId = ?' : 'obraId IS NULL'}`,
            [description, ...(obraId ? [obraId] : [])]
        );
    }

    if (total > 0) {
        if (existing.length > 0) {
            await conn.execute(
                `UPDATE expenses
                    SET amount = ?, description = ?, partnerName = ?, fuelType = ?,
                        weekStartDate = ?, chaveMensal = ?
                  WHERE id = ?`,
                [total, description, partnerName, fuelType, inicio, chave, existing[0].id]
            );
        } else {
            await conn.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, partnerName, fuelType, chaveMensal)
                 VALUES (?, ?, ?, ?, 'Combustível', NOW(), ?, ?, ?, ?)`,
                [crypto.randomUUID(), obraId || null, description, total, inicio, partnerName, fuelType, chave]
            );
        }
    } else if (existing.length > 0) {
        await conn.execute('DELETE FROM expenses WHERE id = ?', [existing[0].id]);
    }
};

/**
 * Carimba `chaveMensal` nas despesas mensais que já existiam antes da coluna,
 * enquanto o nome na descrição ainda é o nome atual do posto — depois de uma
 * renomeação isso não teria mais como ser feito. Idempotente: só toca linhas
 * sem chave, e só quando o nome aponta para UM posto e a chave está livre.
 * Linhas com nome antigo (já órfãs) ficam como estão, de propósito.
 */
const carimbarChavesExistentes = async (db) => {
    const [linhas] = await db.query(`
        SELECT id, obraId, fuelType, partnerName, description
          FROM expenses
         WHERE chaveMensal IS NULL
           AND category = 'Combustível'
           AND fuelType IS NOT NULL
           AND description LIKE 'Combustível: %'
           AND description REGEXP ' de [0-9]{4}[)]$'
           AND description NOT LIKE '%#Comboio%'
    `);
    if (!linhas.length) return 0;

    const [postos] = await db.query('SELECT id, razaoSocial FROM partners WHERE razaoSocial IS NOT NULL');
    const porNome = new Map();
    postos.forEach(p => porNome.set(p.razaoSocial, (porNome.get(p.razaoSocial) || []).concat(p.id)));

    let carimbadas = 0;
    for (const l of linhas) {
        const m = /\(([a-zç]+) de (\d{4})\)$/.exec(l.description);
        const mes = m ? MESES.indexOf(m[1]) + 1 : 0;
        const ids = porNome.get(l.partnerName) || [];
        if (!mes || ids.length !== 1) continue;
        // A descrição tem que ser a que o recálculo geraria hoje para esse posto.
        if (l.description !== `Combustível: ${l.fuelType} - ${l.partnerName} (${m[1]} de ${m[2]})`) continue;
        const chave = chaveMensal(l.obraId, ids[0], l.fuelType, { ano: Number(m[2]), mes });
        const [r] = await db.query(
            `UPDATE expenses SET chaveMensal = ?
              WHERE id = ? AND chaveMensal IS NULL
                AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM expenses WHERE chaveMensal = ?) x)`,
            [chave, l.id, chave]
        );
        carimbadas += r.affectedRows || 0;
    }
    return carimbadas;
};

module.exports = { sincronizarDespesaMensal, carimbarChavesExistentes, chaveMensal, mesBRT, MESES };
