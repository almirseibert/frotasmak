// server.js (Backend)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const http = require('http'); // <--- 1. Importar módulo HTTP nativo
const { Server } = require("socket.io"); // <--- 2. Importar Socket.io

// Importa o multer
const multer = require('multer');

// Middlewares
const authMiddleware = require('./middlewares/authMiddleware');

// Rotas Existentes
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
const uploadRoutes = require('./routes/uploadRoutes');
const tireRoutes = require('./routes/tireRoutes');

// --- NOVA ROTA DE FATURAMENTO ---
const billingRoutes = require('./routes/billingRoutes');

const app = express();
const port = process.env.PORT || 3001;

// <--- 3. Criar o servidor HTTP explicitamente usando o app do Express
const server = http.createServer(app);

// <--- 4. Configurar o Socket.io com CORS (Permite conexão do Frontend)
const io = new Server(server, {
    cors: {
        origin: "*", // Aceita conexões de qualquer origem (ideal para dev/fases iniciais)
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

app.use(cors());
app.use(express.json()); 

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// <--- 5. Middleware para disponibilizar o 'io' em todas as requisições (req.io)
app.use((req, res, next) => {
    req.io = io;
    next();
});

// --- ROTAS DA API ---
const apiRouter = express.Router();

apiRouter.get('/', (req, res) => {
    res.send('API Frotas MAK está no ar!');
});

// Rotas Públicas
apiRouter.use('/auth', authRoutes);
apiRouter.use('/registrationRequests', registrationRequestRoutes);

// Middleware de Autenticação
apiRouter.use(authMiddleware);

// Rota de Upload
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
apiRouter.use('/tires', tireRoutes);

// --- REGISTRO DA ROTA DE FATURAMENTO ---
apiRouter.use('/billing', billingRoutes);

app.use('/api', apiRouter);

// <--- 6. (Opcional) Log de conexões Socket para Debug
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado via Socket:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado:', socket.id);
    });
});

// Inicialização do Banco de Dados (Verificação de Conexão Apenas)
db.getConnection()
    .then(connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

// <--- 7. IMPORTANTE: Mude app.listen para server.listen
server.listen(port, () => {
    console.log(`🚀 Servidor rodando (HTTP + Socket.io) na porta ${port}`);
});