// Backup lógico do banco (schema + dados) sem depender de mysqldump instalado.
//
// Uso:
//   node scripts/backupBanco.js --saida /f/caminho/backup.sql
//   node scripts/backupBanco.js --saida ... --tabelas vehicles,refuelings
//   node scripts/backupBanco.js --saida ... --somente-schema
//   node scripts/backupBanco.js --saida ... --producao      # banco de produção
//
// Gera um .sql restaurável: CREATE TABLE (via SHOW CREATE TABLE) + INSERTs em
// lote. Escreve em streaming, então tabelas grandes não estouram a memória.
//
// O arquivo sai com SET FOREIGN_KEY_CHECKS=0 no topo e =1 no fim, para que a
// ordem das tabelas não importe na restauração.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { obterConexao, anunciar } = require('../utils/conexaoAlvo');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valor = (f, padrao) => {
    const i = args.indexOf(f);
    return (i === -1 || i === args.length - 1) ? padrao : args[i + 1];
};

const SAIDA = valor('--saida', null);
const SOMENTE_SCHEMA = flag('--somente-schema');
const TABELAS_FILTRO = valor('--tabelas', null);
const LOTE = 2000;

if (!SAIDA) {
    console.error('Informe --saida <arquivo.sql>');
    process.exit(1);
}

// Escapa um valor para literal SQL. Buffers viram hex (BLOB), datas viram
// string ISO em horário local do pool (o pool já está em -03:00).
const escapar = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return 'NULL';
        const p = (n) => String(n).padStart(2, '0');
        return `'${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} `
            + `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}'`;
    }
    if (typeof v === 'object') return escapar(JSON.stringify(v)); // colunas JSON
    return "'" + String(v)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\x1a/g, '\\Z') + "'";
};

// Escapa um campo sabendo se a COLUNA é do tipo JSON.
//
// O mysql2 faz JSON.parse no que vem de coluna JSON. Objeto e array voltam como
// objeto e o escapar() genérico os re-serializa certo, mas JSON escalar — uma
// string, um número, um booleano — volta como primitivo JS e perde a marcação de
// JSON: a string viraria texto solto no INSERT e o MySQL recusaria com
// ERROR 3140 (Invalid JSON text), abortando a restauração no meio.
// Re-serializar sempre que a coluna for JSON cobre os dois casos.
const escaparCampo = (v, ehJson) => {
    if (v === null || v === undefined) return 'NULL';
    return ehJson ? escapar(JSON.stringify(v)) : escapar(v);
};

(async () => {
    const conexao = await obterConexao();
    anunciar(conexao);
    const db = conexao.db;

    fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
    const saida = fs.createWriteStream(SAIDA, { encoding: 'utf8' });
    const escrever = (txt) => new Promise((resolve) => {
        if (!saida.write(txt)) saida.once('drain', resolve);
        else resolve();
    });

    const [[info]] = await db.query('SELECT DATABASE() AS db, VERSION() AS versao, NOW() AS agora');
    console.log(`Banco: ${info.db} (MySQL ${info.versao})`);

    await escrever(`-- Backup lógico de ${info.db}\n`);
    await escrever(`-- Gerado em ${new Date().toISOString()} por scripts/backupBanco.js\n`);
    await escrever(`-- MySQL ${info.versao}\n\n`);
    await escrever('SET FOREIGN_KEY_CHECKS=0;\n');
    await escrever('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";\n');
    await escrever("SET NAMES utf8mb4;\n\n");

    const [tabelasRaw] = await db.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
    const campoNome = Object.keys(tabelasRaw[0])[0];
    let tabelas = tabelasRaw.map((t) => t[campoNome]);

    if (TABELAS_FILTRO) {
        const desejadas = TABELAS_FILTRO.split(',').map((t) => t.trim());
        tabelas = tabelas.filter((t) => desejadas.includes(t));
    }

    console.log(`${tabelas.length} tabela(s) a exportar${SOMENTE_SCHEMA ? ' (só schema)' : ''}.`);

    let totalLinhas = 0;
    for (const tabela of tabelas) {
        const [[criacao]] = await db.query(`SHOW CREATE TABLE \`${tabela}\``);
        const ddl = criacao['Create Table'];

        await escrever(`\n-- ─── ${tabela} ───\n`);
        await escrever(`DROP TABLE IF EXISTS \`${tabela}\`;\n`);
        await escrever(ddl + ';\n\n');

        if (SOMENTE_SCHEMA) { console.log(`  ${tabela} (schema)`); continue; }

        const [[cont]] = await db.query(`SELECT COUNT(*) AS n FROM \`${tabela}\``);
        const n = Number(cont.n);
        if (n === 0) { console.log(`  ${tabela}: vazia`); continue; }

        const [colunasRaw] = await db.query(`SHOW COLUMNS FROM \`${tabela}\``);

        // Colunas GENERATED (STORED/VIRTUAL) não entram no INSERT: o MySQL as
        // calcula sozinho e recusa valor explícito com ERROR 3105, abortando a
        // restauração inteira. Atenção ao filtro: `Extra` também traz
        // DEFAULT_GENERATED para colunas com DEFAULT CURRENT_TIMESTAMP, e
        // essas são colunas normais — excluí-las perderia os horários
        // originais, substituindo-os pelo instante da restauração.
        const colunas = colunasRaw.filter((c) => !/(VIRTUAL|STORED) GENERATED/.test(c.Extra || ''));
        const nomes = colunas.map((c) => '`' + c.Field + '`').join(', ');

        // PAGINAÇÃO POR CHAVE, não por OFFSET.
        //
        // `LIMIT 500 OFFSET 900000` faz o MySQL varrer as 900 mil linhas
        // anteriores só para descartá-las. Numa tabela de 1,27 milhão de linhas
        // (sigasul_positions) isso vira O(n²) — a primeira versão deste script
        // travou exatamente ali, meia hora sem terminar uma única tabela.
        //
        // Com chave primária de coluna única, `WHERE pk > ultimo ORDER BY pk`
        // usa o índice e todo lote custa o mesmo. Sem PK simples não há keyset
        // seguro, então cai no OFFSET com aviso — nenhuma tabela grande do
        // sistema está nesse caso.
        const [chaves] = await db.query(
            `SHOW KEYS FROM \`${tabela}\` WHERE Key_name = 'PRIMARY'`
        );
        const pk = chaves.length === 1 ? chaves[0].Column_name : null;

        const emitir = async (linhas) => {
            const valores = linhas
                .map((l) => '(' + colunas.map((c) => escaparCampo(l[c.Field], c.Type === 'json')).join(', ') + ')')
                .join(',\n');
            await escrever(`INSERT INTO \`${tabela}\` (${nomes}) VALUES\n${valores};\n`);
        };

        if (pk) {
            let ultimo = null;
            for (;;) {
                const [linhas] = ultimo === null
                    ? await db.query(`SELECT * FROM \`${tabela}\` ORDER BY \`${pk}\` LIMIT ${LOTE}`)
                    : await db.query(
                        `SELECT * FROM \`${tabela}\` WHERE \`${pk}\` > ? ORDER BY \`${pk}\` LIMIT ${LOTE}`,
                        [ultimo]
                    );
                if (linhas.length === 0) break;
                await emitir(linhas);
                ultimo = linhas[linhas.length - 1][pk];
                if (linhas.length < LOTE) break;
            }
        } else {
            console.warn(`  ! ${tabela} sem PK de coluna única — usando OFFSET (mais lento).`);
            for (let offset = 0; offset < n; offset += LOTE) {
                const [linhas] = await db.query(
                    `SELECT * FROM \`${tabela}\` LIMIT ${LOTE} OFFSET ${offset}`
                );
                if (linhas.length === 0) break;
                await emitir(linhas);
            }
        }

        totalLinhas += n;
        console.log(`  ${tabela}: ${n} linha(s)${pk ? '' : ' (offset)'}`);
    }

    // ─── VIEWS E TRIGGERS ───
    //
    // SHOW FULL TABLES filtra por BASE TABLE, então views nunca entram no laço
    // acima; e SHOW CREATE TABLE não traz triggers. Ambos ficam para o fim: as
    // views porque dependem das tabelas já existirem, os triggers idem.
    //
    // O DEFINER é removido do DDL. Ele grava o usuário@host de quem criou o
    // objeto; restaurar num servidor onde esse usuário não existe faz o MySQL
    // recusar o CREATE. Sem DEFINER, o objeto passa a pertencer a quem restaura.
    const semDefiner = (ddl) => ddl.replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '');

    const [viewsRaw] = await db.query(
        'SELECT table_name AS nome FROM information_schema.views WHERE table_schema = DATABASE()'
    );
    // Uma view cuja tabela-base ficou de fora (caso de --tabelas) quebraria a
    // restauração com ERROR 1146, então só entram as views cujas dependências
    // estão todas no backup.
    const [depsRaw] = await db.query(
        'SELECT view_name AS view, table_name AS tabela FROM information_schema.view_table_usage '
        + 'WHERE view_schema = DATABASE()'
    );
    const dependencias = new Map();
    for (const d of depsRaw) {
        const v = d.view || d.VIEW_NAME;
        const t = d.tabela || d.TABLE_NAME;
        if (!dependencias.has(v)) dependencias.set(v, []);
        dependencias.get(v).push(t);
    }

    const views = viewsRaw
        .map((v) => v.nome || v.TABLE_NAME)
        .filter((v) => (dependencias.get(v) || []).every((t) => tabelas.includes(t)));

    if (views.length) {
        await escrever('\n-- ═══ VIEWS ═══\n');
        for (const view of views) {
            const [[criacao]] = await db.query(`SHOW CREATE VIEW \`${view}\``);
            await escrever(`\nDROP VIEW IF EXISTS \`${view}\`;\n`);
            await escrever(semDefiner(criacao['Create View']) + ';\n');
            console.log(`  view ${view}`);
        }
    }

    // Só exporta trigger cuja tabela entrou no backup — com --tabelas, um trigger
    // órfão apontando para tabela ausente faria a restauração falhar.
    const [triggersRaw] = await db.query(
        'SELECT trigger_name AS nome, event_object_table AS tabela '
        + 'FROM information_schema.triggers WHERE trigger_schema = DATABASE()'
    );
    const triggers = triggersRaw
        .map((t) => ({ nome: t.nome || t.TRIGGER_NAME, tabela: t.tabela || t.EVENT_OBJECT_TABLE }))
        .filter((t) => tabelas.includes(t.tabela));

    if (triggers.length) {
        await escrever('\n-- ═══ TRIGGERS ═══\n');
        // O corpo de um trigger tem ';' interno, então o cliente precisa de um
        // delimitador diferente para não cortar o CREATE no meio.
        await escrever('\nDELIMITER $$\n');
        for (const trigger of triggers) {
            const [[criacao]] = await db.query(`SHOW CREATE TRIGGER \`${trigger.nome}\``);
            await escrever(`\nDROP TRIGGER IF EXISTS \`${trigger.nome}\`$$\n`);
            await escrever(semDefiner(criacao['SQL Original Statement']) + '$$\n');
            console.log(`  trigger ${trigger.nome} (${trigger.tabela})`);
        }
        await escrever('\nDELIMITER ;\n');
    }

    await escrever('\nSET FOREIGN_KEY_CHECKS=1;\n');
    await new Promise((resolve) => saida.end(resolve));

    const tamanho = fs.statSync(SAIDA).size;
    console.log('');
    console.log(`Arquivo: ${SAIDA}`);
    console.log(`${tabelas.length} tabela(s), ${views.length} view(s), `
        + `${triggers.length} trigger(s), ${totalLinhas} linha(s), `
        + `${(tamanho / 1024 / 1024).toFixed(1)} MB`);
    process.exit(0);
})().catch((e) => {
    console.error('Falha:', e.message);
    console.error(e.stack);
    process.exit(1);
});
