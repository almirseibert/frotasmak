const db = require('../database');
const { toComboioTankKey } = require('../utils/fuelTypes');

// Relatório de entradas e saídas de volume de combustível de um comboio.
// Filtros: comboioVehicleId (obrigatório), from, to (datas), fuelType (opcional),
// obraId (opcional — filtra o detalhamento de saídas por obra abastecida).
//
// Regra de saldo (nível tanque físico do comboio):
//   saldoInicial = Σ entradas + Σ drenagens devolvidas ao tanque − Σ saídas ANTES de `from`
//   saldoFinal   = saldoInicial + entradas(período) + drenagens(período) − saídas(período)
// Drenagem para o comboio devolve diesel ao tanque; antes era ignorada e o saldo
// do relatório nunca batia com o nível físico. Saídas bloqueadas (aguardando
// admin) entram no saldo porque o diesel já saiu do tanque.
// O filtro fuelType, quando informado, se aplica a todo o cálculo (comboio pode
// carregar mais de um combustível). O filtro obraId afeta apenas o detalhamento
// por obra (o tanque é físico e não pertence a uma obra).
const DRENAGEM_TANQUE = "type = 'drenagem' AND COALESCE(destino, 'comboio') = 'comboio'";

const getReport = async (req, res) => {
    try {
        const { comboioVehicleId, from, to, fuelType, obraId } = req.query;
        if (!comboioVehicleId) return res.status(400).json({ error: 'comboioVehicleId é obrigatório.' });
        if (!from || !to) return res.status(400).json({ error: 'Datas inicial e final são obrigatórias.' });

        // O filtro chegava com o rótulo ('Diesel S10') e o banco guarda a chave do
        // tanque ('dieselS10'): qualquer filtro de combustível devolvia zero.
        const tankKey = fuelType ? (toComboioTankKey(fuelType) || fuelType) : null;
        const fuelCond = tankKey ? ' AND fuelType = ?' : '';
        const fuelParam = tankKey ? [tankKey] : [];

        const somas = `
                COALESCE(SUM(CASE WHEN type = 'entrada' AND status = 'Concluída' THEN liters ELSE 0 END), 0) AS entradas,
                COALESCE(SUM(CASE WHEN type = 'saida' THEN liters ELSE 0 END), 0) AS saidas,
                COALESCE(SUM(CASE WHEN ${DRENAGEM_TANQUE} THEN liters ELSE 0 END), 0) AS drenagens`;

        // 1) Saldo inicial (tudo antes de `from`)
        const [ini] = await db.query(
            `SELECT ${somas}
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date < ?${fuelCond}`,
            [comboioVehicleId, from, ...fuelParam]
        );
        const saldoInicial = Number(ini[0].entradas) + Number(ini[0].drenagens) - Number(ini[0].saidas);

        // 2) Totais do período
        const [per] = await db.query(
            `SELECT ${somas}
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date >= ? AND date <= ?${fuelCond}`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam]
        );
        const totalEntradas = Number(per[0].entradas);
        const totalSaidas = Number(per[0].saidas);
        const totalDrenagens = Number(per[0].drenagens);
        const saldoFinal = saldoInicial + totalEntradas + totalDrenagens - totalSaidas;

        // 3) Detalhamento de saídas por obra no período
        const obraCond = obraId ? ' AND obraId = ?' : '';
        const obraParam = obraId ? [obraId] : [];
        const [porObra] = await db.query(
            `SELECT obraId, MAX(obraName) AS obraName, COALESCE(SUM(liters), 0) AS litros, COUNT(*) AS qtd
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND type = 'saida' AND date >= ? AND date <= ?${fuelCond}${obraCond}
             GROUP BY obraId
             ORDER BY litros DESC`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam, ...obraParam]
        );

        // 4) Transações do período (listagem)
        const [transacoes] = await db.query(
            `SELECT id, type, status, destino, authNumber, date, liters, fuelType, obraId, obraName,
                    receivingVehicleName, drainingVehicleName, partnerName, invoiceNumber
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date >= ? AND date <= ?${fuelCond}${obraCond}
             ORDER BY date ASC`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam, ...obraParam]
        );

        res.json({
            comboioVehicleId,
            from, to, fuelType: tankKey || null, obraId: obraId || null,
            saldoInicial,
            totalEntradas,
            totalSaidas,
            totalDrenagens,
            saldoFinal,
            porObra: porObra.map(o => ({ ...o, litros: Number(o.litros), qtd: Number(o.qtd) })),
            transacoes,
        });
    } catch (error) {
        console.error('❌ Erro no relatório de comboio:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao gerar relatório de comboio.' });
    }
};

module.exports = { getReport };
