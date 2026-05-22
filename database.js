const mysql = require('mysql2/promise');
require('dotenv').config();

// ====================================================================
// CONFIGURAÇÃO DE BANCO DE DADOS LIMPA (Ideal para Easypanel)
// Como o Easypanel injeta variáveis de ambiente de forma nativa, 
// o pool de conexão abaixo puxará corretamente de process.env.
// ====================================================================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

module.exports = db;