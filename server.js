require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const http = require('http'); 
const { Server } = require("socket.io"); 
const multer = require('multer');

// --- CONFIGURAÇÃO DE CORS SEGURO ---
// Defina as origens permitidas no ficheiro .env. Ex: ALLOWED_ORIGINS=https://frotamak.com,http://localhost:3000
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(url => url.trim().replace(/\/$/, '')) 
    : [
        'http://localhost:3000', 
        'http://localhost:3001', 
        'https://frotamak.com', 
        'https://www.frotamak.com',
        'https://frotasmak-frotas-backend.oehpg2.easypanel.host'
      ]; // Domínios de produção adicionados como segurança

const corsOptions = {
    origin: function (origin, callback) {
        // Limpa espaços extras e barras no final da string de origem, se houver
        const cleanOrigin = origin ? origin.trim().replace(/\/$/, '') : null;

        if (!cleanOrigin || allowedOrigins.includes(cleanOrigin)) {
            callback(null, true);
        } else {
            console.error(`[CORS AVISO] Acesso bloqueado. Origem não permitida: '${origin}'`);
            callback(new Error('Acesso bloqueado pelo CORS. Origem não permitida.'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
};

// INICIALIZAÇÃO DO APP E MIDDLEWARES GLOBAIS (Declarado apenas uma vez)
const app = express();
app.use(cors(corsOptions)); 
app.use(express.json()); 

// --- CORREÇÃO DE SEGURANÇA: FILE FILTER GLOBAL ---
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const cleanOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, uniqueSuffix + '-' + cleanOriginalName);
    }
});

const fileFilterGlobal = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não permitido! Apenas imagens (JPEG/PNG/WEBP) e PDFs são aceitos.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilterGlobal,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ====================================================================
// IMPORTAÇÃO DE MIDDLEWARES E ROTAS EXISTENTES
// ====================================================================
const authMiddleware = require('./middlewares/authMiddleware');

const authRoutes = require('./routes/authRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const obraRoutes = require('./routes/obraRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const checklistRoutes = require('./routes/checklistRoutes');
const partnerRoutes = require('./routes/partnerRoutes');
const revisionRoutes = require('./routes/revisionRoutes');
const fineRoutes = require('./routes/fineRoutes');
const refuelingRoutes = require('./routes/refuelingRoutes');
const comboioTransactionRoutes = require('./routes/comboioTransactionRoutes');
const agendaRoutes = require('./routes/agendaRoutes');
const diarioDeBordoRoutes = require('./routes/diarioDeBordoRoutes');
const orderRoutes = require('./routes/orderRoutes');
const counterRoutes = require('./routes/counterRoutes');
const inactivityAlertRoutes = require('./routes/inactivityAlertRoutes');
const registrationRequestRoutes = require('./routes/registrationRequestRoutes');
const adminRoutes = require('./routes/adminRoutes');
const expensesRoutes = require('./routes/expenseRoutes');
const userRoutes = require('./routes/userRoutes');
const updateRoutes = require('./routes/updateRoutes');
const tireRoutes = require('./routes/tireRoutes');
const obraSupervisorRoutes = require('./routes/obraSupervisorRoutes');

// --- NOVAS ROTAS ---
const solicitacaoRoutes = require('./routes/solicitacaoRoutes');
const billingRoutes = require('./routes/billingRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const washingRoutes = require('./routes/washingRoutes');

const port = process.env.PORT || 3001;
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins, 
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        credentials: true
    }
});
global.io = io;

// Configuração para permitir acesso público aos uploads de imagens e PDFs
app.use('/uploads', express.static(uploadDir));

// Middleware para disponibilizar o 'io' em todas as requisições (req.io)
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

// ====================================================================
// MIDDLEWARE DE AUTENTICAÇÃO (Tudo abaixo disso requer token)
// ====================================================================
apiRouter.use(authMiddleware);

// --- ROTA DE UPLOAD GENÉRICA (GARANTIDA E EMBUTIDA NO SERVER.JS) ---
// Responde ao 'POST /api/upload'
apiRouter.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
        }
        
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        
        res.status(200).json({
            message: 'Upload realizado com sucesso.',
            url: fileUrl,
            filename: req.file.filename
        });
    } catch (error) {
        console.error('Erro no upload genérico:', error);
        res.status(500).json({ error: 'Falha interna ao processar o upload do arquivo.' });
    }
});

// --- ROTAS PROTEGIDAS DO SISTEMA ---
apiRouter.use('/vehicles', vehicleRoutes);
apiRouter.use('/obras', obraRoutes);
apiRouter.use('/employees', employeeRoutes);
apiRouter.use('/checklists', checklistRoutes);
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
apiRouter.use('/supervisor', obraSupervisorRoutes);
apiRouter.use('/billing', billingRoutes);
apiRouter.use('/solicitacoes', solicitacaoRoutes);

// Integração das Novas Funcionalidades
apiRouter.use('/maintenances', maintenanceRoutes);
apiRouter.use('/washings', washingRoutes);
apiRouter.use('/agenda', agendaRoutes);

app.use('/api', apiRouter);

// (Opcional) Log de conexões Socket para Debug
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

// ==========================================
// IMPORTAR E INICIAR SERVIÇOS EM SEGUNDO PLANO
// ==========================================
require('./services/cronService'); 

// IMPORTANTE: server.listen (inicia a API)
server.listen(port, () => {
    console.log(`🚀 Servidor rodando (HTTP + Socket.io) na porta ${port}`);
    console.log(`- Rotas de Upload Genérico registradas em /api/upload`);
    console.log(`- Rotas de Billing registradas em /api/billing`);
    console.log(`- Rotas de Solicitações registradas em /api/solicitacoes`);
    console.log(`- Rotas de Manutenções registradas em /api/maintenances`);
    console.log(`- Rotas de Lavagens registradas em /api/washings`);
});