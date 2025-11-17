// server.js (Backend)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path'); // Importa o módulo 'path'
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

app.use(express.json());
app.use(cors());

// --- CORREÇÃO DE BUG ---
// O caminho deve corresponder ao local onde o multer salva (public/uploads)
// Isso torna as imagens acessíveis publicamente (ex: http://sua-api.com/uploads/imagem.png)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
// --- FIM DA CORREÇÃO ---


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
// ATENÇÃO: A rota /api/upload (esta linha) pode estar em conflito com /api/vehicles/:id/upload-image
// Se o upload de veículos parar de funcionar, comente a linha abaixo.
apiRouter.use('/upload', uploadRoutes);

// Rotas Protegidas
apiRouter.use('/vehicles', vehicleRoutes); // Esta rota já lida com upload de veículos
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