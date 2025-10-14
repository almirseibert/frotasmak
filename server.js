// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./database');

// Middlewares
const authMiddleware = require('./middlewares/authMiddleware');

// Rotas
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
const expensesRoutes = require('./routes/expenseRoutes');
const userRoutes = require('./routes/userRoutes');

// --- NOVA ROTA IMPORTADA ---
const updateRoutes = require('./routes/updateRoutes');


const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// Rota de teste
app.get('/api', (req, res) => {
    res.send('API Frotas MAK está no ar!');
});

// Verifica a conexão com o banco de dados ao iniciar
db.getConnection()
    .then(connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

// --- ROTAS PÚBLICAS (NÃO EXIGEM TOKEN JWT) ---
app.use('/api/auth', authRoutes); 
app.use('/api/registrationRequests', registrationRequestRoutes); 

// --- APLICA O MIDDLEWARE JWT A PARTIR DAQUI ---
app.use(authMiddleware); 

// --- ROTAS PROTEGIDAS ---
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
app.use('/api/expenses', expensesRoutes);
app.use('/api/users', userRoutes);

// --- NOVA ROTA REGISTRADA ---
app.use('/api/updates', updateRoutes);


// Inicia o servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
