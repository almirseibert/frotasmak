// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
// Middleware de autenticação JWT - Você precisa criar e configurar este arquivo
const authMiddleware = require('./middlewares/authMiddleware'); // ASSUMIR QUE EXISTE

const authRoutes = require('./routes/authRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const obraRoutes = require('./routes/obraRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const partnerRoutes = require('./routes/partnerRoutes');
const revisionRoutes = require('./routes/revisionRoutes');
const fineRoutes = require('./routes/fineRoutes');
const refuelingRoutes = require('./routes/refuelingRoutes');
const comboioTransactionRoutes = require('./routes/comboioTransactionRoutes');
const diarioDeBordoRoutes = require('./routes/diarioDeBordoRoutes');
const orderRoutes = require('./routes/orderRoutes');
const counterRoutes = require('./routes/counterRoutes');
const inactivityAlertRoutes = require('./routes/inactivityAlertRoutes');
const registrationRequestRoutes = require('./routes/registrationRequestRoutes');
const adminRoutes = require('./routes/adminRoutes'); 
// NOVO: Importar a nova rota de despesas (Você deve criar o expenseRoutes.js)
const expensesRoutes = require('./routes/expenseRoutes'); 

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// Rota de teste para o caminho raiz
app.get('/', (req, res) => {
  res.status(200).send('API está funcionando!');
});

// Conexão com o banco de dados
const db = require('./database');

// Testar a conexão com o banco de dados
db.getConnection()
    .then(connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

// --- ROTAS PÚBLICAS (NÃO EXIGEM TOKEN JWT) ---
// Login, Logout e Solicitação de Cadastro
app.use('/api/auth', authRoutes); 
app.use('/api/registrationRequests', registrationRequestRoutes); 

// --- APLICA O MIDDLEWARE JWT A PARTIR DAQUI ---
// Todas as rotas abaixo desta linha exigirão um token válido no cabeçalho
app.use(authMiddleware); 

// --- ROTAS DE DADOS (PROTEGIDAS) ---
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/obras', obraRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/partners', partnerRoutes);
app.use('/api/revisions', revisionRoutes);
app.use('/api/fines', fineRoutes);
app.use('/api/refuelings', refuelingRoutes);
app.use('/api/comboioTransactions', comboioTransactionRoutes);
app.use('/api/diarioDeBordo', diarioDeBordoRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/counters', counterRoutes);
app.use('/api/inactivityAlerts', inactivityAlertRoutes);
app.use('/api/admin', adminRoutes); 
// NOVO: Adiciona a rota de despesas que estava faltando (resolve 404/expenses)
app.use('/api/expenses', expensesRoutes); 

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});