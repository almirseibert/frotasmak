-- =============================================================================
-- Subgrupo em vários grupos (vínculo N:N)
--
-- Versão avulsa da migração que está inline em server.js. Serve para rodar
-- ANTES do deploy do código novo — a ordem segura, porque as migrações inline
-- são async e não bloqueiam o app.listen: código novo no ar sem a tabela
-- criada devolve 500 na taxonomia e no Panorama de Capacidade.
--
-- RETROCOMPATÍVEL: só adiciona. `vehicle_sub_types.type_id` continua populado,
-- então o código que está em produção hoje segue funcionando normalmente.
--
-- Rodar como: mysql -h <host> -P <porta> -u <user> -p frotasmak < subgrupo_n_para_n.sql
-- Idempotente: rodar duas vezes não causa dano (os ALTER dão erro e podem ser
-- ignorados na segunda vez — ver a conferência no fim).
-- =============================================================================

-- 1. Conferência PRÉVIA — precisa devolver 0. Com resultado > 0, PARE:
--    há nome de subgrupo repetido e a unificação é decisão de gente, não de SQL.
SELECT COUNT(*) AS nomes_repetidos FROM (
    SELECT nome FROM vehicle_sub_types GROUP BY nome HAVING COUNT(*) > 1
) x;

-- 2. Tabela de vínculo.
CREATE TABLE IF NOT EXISTS vehicle_type_sub_types (
    type_id      VARCHAR(36) NOT NULL,
    sub_type_id  VARCHAR(36) NOT NULL,
    created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (type_id, sub_type_id),
    KEY idx_vtst_sub (sub_type_id),
    CONSTRAINT fk_vtst_type FOREIGN KEY (type_id)
        REFERENCES vehicle_types(id) ON DELETE CASCADE,
    CONSTRAINT fk_vtst_sub FOREIGN KEY (sub_type_id)
        REFERENCES vehicle_sub_types(id) ON DELETE CASCADE
);

-- 3. Backfill dos vínculos que já existem.
INSERT IGNORE INTO vehicle_type_sub_types (type_id, sub_type_id)
SELECT type_id, id FROM vehicle_sub_types WHERE type_id IS NOT NULL;

-- 4. Nome do subgrupo passa a ser único GLOBAL (era único por tipo).
--    A FK fk_vst_type usava uk_type_nome(type_id, nome) como índice dela: sem
--    dar um índice próprio à FK antes, o DROP falha com ER_DROP_INDEX_FK.
--    Na segunda execução estes três dão erro — pode ignorar.
ALTER TABLE vehicle_sub_types ADD KEY idx_vst_type (type_id);
ALTER TABLE vehicle_sub_types DROP INDEX uk_type_nome;
ALTER TABLE vehicle_sub_types ADD UNIQUE KEY uk_sub_nome (nome);

-- 5. type_id vira opcional. NÃO remover a coluna: é a rede de reversão.
--    Remover só numa limpeza posterior, com a tela nova já estável.
ALTER TABLE vehicle_sub_types MODIFY type_id VARCHAR(36) NULL;

-- 6. Conferência FINAL — vinculos deve ser igual a subgrupos (18 na data da
--    escrita) e orfaos deve ser 0.
SELECT
    (SELECT COUNT(*) FROM vehicle_type_sub_types) AS vinculos,
    (SELECT COUNT(*) FROM vehicle_sub_types)      AS subgrupos,
    (SELECT COUNT(*) FROM vehicle_sub_types s
      WHERE NOT EXISTS (SELECT 1 FROM vehicle_type_sub_types v
                         WHERE v.sub_type_id = s.id))  AS orfaos;
