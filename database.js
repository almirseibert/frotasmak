const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// Local: .env.local carregado primeiro com override (banco de teste)
// Easypanel: arquivos .env não existem no container, process.env já vem
//            com as variáveis de produção injetadas nativamente
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
}
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
}

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 30000,
    timezone: '-03:00',
});

// Fixa o fuso de sessão em TODA conexão nova do pool. Antes o SET rodava uma
// única vez numa conexão que era devolvida ao pool, então as demais conexões
// usavam o time_zone padrão do servidor MySQL. Como `refuelings.data` (e outras)
// são TIMESTAMP (normalizado em UTC pelo servidor conforme o time_zone da
// sessão), gravar/ler em conexões com fuso divergente deslocava o horário —
// podendo virar o dia. Garantir -03:00 por conexão elimina essa assimetria.
db.on('connection', (conn) => {
    conn.query("SET time_zone = '-03:00'");
});

(async () => {
    try {
        const conn = await db.getConnection();
        await conn.query("SET time_zone = '-03:00'");
        conn.release();
        const [[{ bancoConectado }]] = await db.query('SELECT DATABASE() AS bancoConectado');
        console.log(`✅ Banco de dados conectado: ${bancoConectado} (${process.env.DB_HOST}) | timezone: -03:00`);
    } catch (err) {
        console.error('❌ Erro ao verificar conexão com o banco:', err.message);
    }
})();

module.exports = db;
