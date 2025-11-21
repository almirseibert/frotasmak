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

// --- NOVA ROTA DE PNEUS ---
const tireRoutes = require('./routes/tireRoutes');

const app = express();
const port = process.env.PORT || 3001;

// --- CORREÇÃO CRÍTICA DE MIDDLEWARE ---
app.use(cors());
app.use(express.json()); 
// --- FIM CORREÇÃO CRÍTICA ---

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

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

// --- REGISTRO DA ROTA DE PNEUS ---
apiRouter.use('/tires', tireRoutes);

app.use('/api', apiRouter);

// --- INICIALIZAÇÃO DO BANCO DE DADOS ---
const initTireTables = async (connection) => {
    console.log('Verificando tabelas de pneus...');
    try {
        // Tabela de Pneus
        await connection.query(`
            CREATE TABLE IF NOT EXISTS tires (
                id VARCHAR(36) PRIMARY KEY,
                fireNumber VARCHAR(50) NOT NULL UNIQUE,
                brand VARCHAR(50) NOT NULL,
                model VARCHAR(50),
                size VARCHAR(20) NOT NULL,
                status ENUM('Estoque', 'Em Uso', 'Sucata', 'Recapagem') DEFAULT 'Estoque',
                tireCondition ENUM('Novo', 'Usado', 'Recapado') DEFAULT 'Novo',
                purchaseDate DATE,
                price DECIMAL(10, 2),
                location VARCHAR(100) DEFAULT 'Almoxarifado',
                currentVehicleId VARCHAR(36),
                position VARCHAR(50),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_fireNumber (fireNumber),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        
        // Tabela de Transações
        await connection.query(`
            CREATE TABLE IF NOT EXISTS tire_transactions (
                id VARCHAR(36) PRIMARY KEY,
                tireId VARCHAR(36) NOT NULL,
                vehicleId VARCHAR(36) NOT NULL,
                type ENUM('install', 'remove') NOT NULL,
                position VARCHAR(50),
                date DATE NOT NULL,
                odometer DECIMAL(10, 1),
                horimeter DECIMAL(10, 1),
                observation TEXT,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_transaction_tire FOREIGN KEY (tireId) REFERENCES tires(id) ON DELETE CASCADE,
                INDEX idx_tireId (tireId),
                INDEX idx_vehicleId (vehicleId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('Tabelas de Pneus (tires, tire_transactions) verificadas/criadas com sucesso.');
    } catch (error) {
        console.error('ERRO CRÍTICO ao inicializar tabelas de pneus:', error);
    }
};

db.getConnection()
    .then(async connection => {
        console.log('Conexão com o banco de dados estabelecida com sucesso!');
        
        // Executa a criação das tabelas automaticamente
        await initTireTables(connection);
        
        connection.release();
    })
    .catch(err => {
        console.error('Erro ao conectar ao banco de dados:', err.stack);
    });

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});