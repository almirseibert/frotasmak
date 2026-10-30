const db = require('../database');

// Anexa a cada solicitação o nº da ordem gerada (ordem_numero) e o posto em que
// ela foi emitida (ordem_posto_nome) — o gestor pode trocar o posto na liberação.
// Usado pelas duas listagens de GET /solicitacoes: a do operador e a do gestor
// (quem tem acesso ao abastecimento recebe a do gestor também no app).
//
// Consulta à parte (e não JOIN) para usar o índice idx_from_solicitacao: a
// coluna é VARCHAR e o id da solicitação não, e comparar tipos diferentes no
// JOIN descarta o índice. Ordens reservadas (is_hidden) ficam de fora.
const anexarOrdens = async (rows) => {
    if (!rows.length) return rows;
    const ids = rows.map((r) => String(r.id));
    const [ordens] = await db.query(
        `SELECT r.createdFromSolicitacaoId AS solicitacao_id, r.authNumber,
                COALESCE(NULLIF(TRIM(pr.nomeFantasia), ''), pr.razaoSocial, r.partnerName) AS posto_nome
         FROM refuelings r
         LEFT JOIN partners pr ON pr.id = r.partnerId
         WHERE r.createdFromSolicitacaoId IN (?) AND r.is_hidden = 0
         ORDER BY r.authNumber ASC`,
        [ids]
    );
    // ASC: se houver mais de uma ordem para a solicitação, a última vence.
    const porSolicitacao = new Map(ordens.map((o) => [String(o.solicitacao_id), o]));
    for (const row of rows) {
        const ordem = porSolicitacao.get(String(row.id));
        if (!ordem) continue;
        row.ordem_numero = ordem.authNumber;
        row.ordem_posto_nome = ordem.posto_nome || null;
    }
    return rows;
};

module.exports = { anexarOrdens };
