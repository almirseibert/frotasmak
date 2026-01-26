// server.js (Backend)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const http = require('http'); 
const { Server } = require("socket.io");

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

// Rota de Faturamento
const billingRoutes = require('./routes/billingRoutes');

// --- NOVA ROTA DE CHECKLISTS (CRUCIAL PARA O APP) ---
const checklistRoutes = require('./routes/checklistRoutes');

const app = express();
const port = process.env.PORT || 3001;

// Criar o servidor HTTP
const server = http.createServer(app);

// Configurar o Socket.io
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

app.use(cors());
app.use(express.json()); 

// Configuração correta para servir arquivos estáticos (PDFs e Imagens)
app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads')));

// Middleware para disponibilizar o 'io'
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

// Middleware de Autenticação (Protege tudo abaixo)
apiRouter.use(authMiddleware);

// Rota de Upload Genérica
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
apiRouter.use('/billing', billingRoutes);

// --- REGISTRO DA ROTA DE CHECKLISTS ---
// Isso cria a URL /api/checklists que o app está tentando acessar
apiRouter.use('/checklists', checklistRoutes); 

app.use('/api', apiRouter);

// Log Socket
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado via Socket:', socket.id);
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado:', socket.id);
    });
});

// DB Check
db.getConnection()
    .then(connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

server.listen(port, () => {
    console.log(`🚀 Servidor rodando (HTTP + Socket.io) na porta ${port}`);
    console.log(`🔗 API Checklists acessível em /api/checklists`);
});