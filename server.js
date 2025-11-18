// server.js (Backend)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

// Importa o multer
const multer = require('multer');

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
const updateRoutes = require('./routes/updateRoutes');

// Importa as novas rotas de upload
const uploadRoutes = require('./routes/uploadRoutes');


const app = express();
const port = process.env.PORT || 3001;

// --- CORREÇÃO CRÍTICA DE MIDDLEWARE ---
// Estas linhas DEVEM vir antes de QUALQUER rota para garantir que o req.body seja lido.
app.use(cors());
app.use(express.json()); 
// --- FIM CORREÇÃO CRÍTICA ---


// O caminho deve corresponder ao local onde o multer salva (public/uploads)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));


// --- ROTAS DA API ---
const apiRouter = express.Router();

// Rota de teste
apiRouter.get('/', (req, res) => {
    res.send('API Frotas MAK está no ar!');
});

// Rotas Públicas (não exigem token)
apiRouter.use('/auth', authRoutes);
apiRouter.use('/registrationRequests', registrationRequestRoutes);

// Aplica o middleware de autenticação para as rotas protegidas
apiRouter.use(authMiddleware);

// Rota de Upload (Protegida)
apiRouter.use('/upload', uploadRoutes);

// Rotas Protegidas
apiRouter.use('/vehicles', vehicleRoutes);
apiRouter.use('/obras', obraRoutes);
apiRouter.use('/employees', employeeRoutes);
apiRouter.use('/partners', partnerRoutes);
apiRouter.use('/revisions', revisionRoutes);
apiRouter.use('/fines', fineRoutes);
apiRouter.use('/refuelings', refuelingRoutes);
apiRouter.use('/comboioTransactions', comboioTransactionRoutes);
apiRouter.use('/diarioDeBordo', diarioDeBordoRoutes);
apiRouter.use('/orders', orderRoutes);
apiRouter.use('/counters', counterRoutes);
apiRouter.use('/inactivityAlerts', inactivityAlertRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/expenses', expensesRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/updates', updateRoutes);

// Usa o roteador da API com o prefixo /api
app.use('/api', apiRouter);


// Verifica a conexão com o banco de dados ao iniciar
db.getConnection()
    .then(connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

// Inicia o servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});