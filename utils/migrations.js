// backend/utils/migrations.js
//
// Helpers para as migrações inline do server.js.
//
// POR QUE ISTO EXISTE:
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` é extensão do MariaDB. O MySQL 8
// (que é o que roda em produção) responde ER_PARSE_ERROR. Sem o fallback, a
// coluna simplesmente nunca é criada — e como o catch costuma só avisar no log,
// a falha passa despercebida até alguém notar o dado faltando.
//
// Estes helpers encapsulam o retry para que o padrão não precise ser lembrado
// (e reproduzido) em cada bloco de migração novo.

/**
 * Adiciona uma coluna se ela ainda não existir. Idempotente e tolerante tanto a
 * MySQL (sem IF NOT EXISTS) quanto a MariaDB (com).
 *
 * @param {object} db     pool mysql2/promise
 * @param {string} table
 * @param {string} column
 * @param {string} def    definição SQL, ex.: 'VARCHAR(36) DEFAULT NULL'
 * @param {string} [rotulo] prefixo do log de aviso
 * @returns {Promise<boolean>} true se a coluna existe ao final
 */
async function addColumnIfMissing(db, table, column, def, rotulo = 'migration') {
    try {
        await db.query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${column}\` ${def}`);
        return true;
    } catch (e) {
        if (e.code === 'ER_PARSE_ERROR') {
            // MySQL: não conhece IF NOT EXISTS em ADD COLUMN.
            try {
                await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
                return true;
            } catch (e2) {
                if (e2.code === 'ER_DUP_FIELDNAME') return true; // já existia
                console.warn(`[${rotulo}] ${table}.${column}:`, e2.message);
                return false;
            }
        }
        if (e.code === 'ER_DUP_FIELDNAME') return true; // já existia
        console.warn(`[${rotulo}] ${table}.${column}:`, e.message);
        return false;
    }
}

/**
 * Cria um índice se ainda não existir.
 *
 * @param {object} db
 * @param {string} table
 * @param {string} indexName
 * @param {string} colunas  lista já formatada, ex.: '`is_hidden`, `reveal_at`'
 * @param {string} [rotulo]
 * @returns {Promise<boolean>}
 */
async function addIndexIfMissing(db, table, indexName, colunas, rotulo = 'migration') {
    try {
        await db.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${colunas})`);
        return true;
    } catch (e) {
        if (e.code === 'ER_DUP_KEYNAME') return true; // já existia
        console.warn(`[${rotulo}] índice ${table}.${indexName}:`, e.message);
        return false;
    }
}

module.exports = { addColumnIfMissing, addIndexIfMissing };
