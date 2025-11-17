// routes/vehicleRoutes.js
const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicleController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');
const fs = require('fs'); // <-- 1. Importar o File System
const path = require('path'); // <-- 2. Importar o Path

// --- Configuração do Multer para Upload de Imagens ---

// 3. Definir o diretório de upload
const uploadDir = 'public/uploads';

// 4. Resolver o caminho absoluto e criar o diretório se ele não existir
// path.resolve() garante que estamos no caminho certo a partir da raiz do projeto
const absoluteUploadDir = path.resolve(uploadDir);
if (!fs.existsSync(absoluteUploadDir)) {
    fs.mkdirSync(absoluteUploadDir, { recursive: true });
    console.log(`[Multer] Diretório de upload criado em: ${absoluteUploadDir}`);
}

// Define onde salvar os arquivos e como nomeá-los
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Agora o diretório garantidamente existe
        cb(null, uploadDir); // <-- 5. Usar a variável
    },
    filename: function (req, file, cb) {
        // Cria um nome de arquivo único (ex: vehicle-1731592800000.jpg)
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = file.mimetype.split('/')[1] || 'jpg';
        cb(null, `vehicle-${uniqueSuffix}.${extension}`);
    }
});

// Filtro para aceitar apenas imagens
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não suportado! Apenas imagens são permitidas.'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // Limite de 5MB

// --- Rotas ---
router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', vehicleController.getAllVehicles);
router.get('/:id', vehicleController.getVehicleById);
router.post('/', vehicleController.createVehicle);
router.put('/:id', vehicleController.updateVehicle);
router.delete('/:id', vehicleController.deleteVehicle);

// --- Rota de Upload de Imagem ---
// O frontend chamará esta rota *após* criar/salvar o veículo
router.post(
    '/:id/upload-image', 
    upload.single('fotoFile'), // 'fotoFile' deve ser o nome do campo no FormData
    vehicleController.uploadVehicleImage
);


// --- Rotas de Alocação (sem mudança) ---
router.post('/:id/allocate-obra', vehicleController.allocateToObra);
router.post('/:id/deallocate-obra', vehicleController.deallocateFromObra);
router.post('/:id/assign-operational', vehicleController.assignToOperational);
router.post('/:id/unassign-operational', vehicleController.unassignFromOperational);
router.post('/:id/start-maintenance', vehicleController.startMaintenance);
router.post('/:id/end-maintenance', vehicleController.endMaintenance);


module.exports = router;