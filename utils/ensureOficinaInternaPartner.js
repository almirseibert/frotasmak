// utils/ensureOficinaInternaPartner.js
//
// Partner-espelho fixo que representa a oficina própria da MAK como "executor"
// de serviços vindos de um relato de ocorrência (FRM-MAN-001).
//
// Por que um partner e não `executorPartnerId = NULL`: todo o pipeline de
// `orders` assume supplierId/supplier preenchidos — geração do PDF
// (resolveOrderPartnerName), lançamento da despesa e notificação. Com o
// espelho, serviço executado internamente percorre exatamente o mesmo caminho
// de um fornecedor externo, sem nenhum branch especial.
//
// Fica com tipo_parceiro='fornecedor' de propósito: o SearchableSupplierSelect
// da OrdersPage filtra por esse valor, então mudar o tipo tiraria a oficina da
// lista. O que a distingue são as flags is_oficina/is_interno.
//
// envia_por_whatsapp/envia_por_email ficam em 0 e não há telefone nem e-mail —
// assim `_notifyOrderCS` sai cedo sozinho e nunca tenta notificar a si mesma.
//
// Modelado em utils/ensureComboioPartner.js.

const OFICINA_INTERNA_PARTNER_ID = 'mak-oficina-interna';
const OFICINA_INTERNA_RAZAO_SOCIAL = 'MAK SERVIÇOS - OFICINA PRÓPRIA';
const OFICINA_INTERNA_NOME_FANTASIA = 'Oficina MAK (interna)';

// UPSERT idempotente — seguro rodar a cada boot.
// Aceita um db client (pool ou connection); dentro de transação, passe a
// `connection` para participar do mesmo commit/rollback.
const ensureOficinaInternaPartner = async (dbClient) => {
    await dbClient.query(
        `INSERT INTO partners
            (id, razaoSocial, nomeFantasia, tipo_parceiro, is_oficina, is_interno,
             status_operacional, envia_por_whatsapp, envia_por_email, tipoPessoa)
         VALUES (?, ?, ?, 'fornecedor', 1, 1, 'ATIVO', 0, 0, 'juridica')
         ON DUPLICATE KEY UPDATE
            razaoSocial        = VALUES(razaoSocial),
            nomeFantasia       = VALUES(nomeFantasia),
            tipo_parceiro      = 'fornecedor',
            is_oficina         = 1,
            is_interno         = 1,
            status_operacional = 'ATIVO',
            envia_por_whatsapp = 0,
            envia_por_email    = 0`,
        [OFICINA_INTERNA_PARTNER_ID, OFICINA_INTERNA_RAZAO_SOCIAL, OFICINA_INTERNA_NOME_FANTASIA]
    );

    return {
        id: OFICINA_INTERNA_PARTNER_ID,
        razaoSocial: OFICINA_INTERNA_RAZAO_SOCIAL,
        nomeFantasia: OFICINA_INTERNA_NOME_FANTASIA,
        tipo_parceiro: 'fornecedor',
        is_oficina: 1,
        is_interno: 1,
    };
};

/**
 * Resolve o executor de um item para um partnerId sempre preenchido.
 * 'interno' (ou executorPartnerId ausente com tipo interno) → oficina da MAK.
 */
const resolveExecutorPartnerId = (executorTipo, executorPartnerId) => {
    if (executorTipo === 'interno') return OFICINA_INTERNA_PARTNER_ID;
    return executorPartnerId || null;
};

module.exports = {
    OFICINA_INTERNA_PARTNER_ID,
    OFICINA_INTERNA_RAZAO_SOCIAL,
    OFICINA_INTERNA_NOME_FANTASIA,
    ensureOficinaInternaPartner,
    resolveExecutorPartnerId,
};
