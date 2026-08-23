// backend/utils/conexaoAlvo.js
//
// Seletor de banco para SCRIPTS de manutenção.
//
// POR QUE EXISTE:
// database.js carrega `.env.local` com override:true e só depois `.env` com
// override:false. Isso é ótimo para o dia a dia — localmente tudo cai no banco
// de teste sem ninguém precisar lembrar — mas significa que definir
// DB_DATABASE=frotasmak no shell NÃO funciona: o .env.local sobrescreve.
//
// Como as senhas de teste e produção são diferentes, alcançar produção exige ler
// o `.env` diretamente. Este helper faz isso apenas quando `--producao` é passado
// explicitamente, e imprime em qual banco vai operar antes de qualquer coisa.
//
// Nenhum script deve chamar produção por padrão.

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

/** Lê um .env sem mexer em process.env. */
const lerEnv = (arquivo) => {
    const valores = {};
    if (!fs.existsSync(arquivo)) return valores;
    for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
        const limpa = linha.trim();
        if (!limpa || limpa.startsWith('#')) continue;
        const i = limpa.indexOf('=');
        if (i === -1) continue;
        valores[limpa.slice(0, i).trim()] = limpa.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    return valores;
};

/**
 * Devolve { db, rotulo, ehProducao, encerrar }.
 *
 * Sem --producao: usa o pool normal da aplicação (banco de teste localmente).
 * Com --producao: pool dedicado com as credenciais do `.env`.
 */
const obterConexao = async (args = process.argv.slice(2)) => {
    const ehProducao = args.includes('--producao');

    if (!ehProducao) {
        const db = require('../database');
        const [[info]] = await db.query('SELECT DATABASE() AS nome');
        return {
            db,
            rotulo: info.nome,
            ehProducao: false,
            // O pool da aplicação é compartilhado; quem o abriu é quem encerra.
            encerrar: async () => {},
        };
    }

    const env = lerEnv(path.resolve(process.cwd(), '.env'));
    if (!env.DB_HOST || !env.DB_DATABASE) {
        throw new Error('.env não tem DB_HOST/DB_DATABASE — não há como alcançar produção.');
    }

    const pool = mysql.createPool({
        host: env.DB_HOST,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_DATABASE,
        port: env.DB_PORT || 3306,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
        connectTimeout: 30000,
        timezone: '-03:00',
    });

    const [[info]] = await pool.query('SELECT DATABASE() AS nome');
    return {
        db: pool,
        rotulo: info.nome,
        ehProducao: true,
        encerrar: async () => { await pool.end(); },
    };
};

/** Banner obrigatório: ninguém deve descobrir depois em que banco escreveu. */
const anunciar = (conexao) => {
    const linha = '─'.repeat(60);
    console.log(linha);
    console.log(conexao.ehProducao
        ? `  ⚠  BANCO DE PRODUÇÃO: ${conexao.rotulo}`
        : `  banco: ${conexao.rotulo}`);
    console.log(linha);
};

module.exports = { obterConexao, anunciar, lerEnv };
