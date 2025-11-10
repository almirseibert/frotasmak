// routes/uploadRoutes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// Configuração do Multer para salvar imagens de veículos
const vehicleStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../uploads/vehicles');
        
        // Cria o diretório se não existir
        fs.mkdirSync(uploadPath, { recursive: true });
        
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Cria um nome de arquivo único para evitar conflitos
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// Filtro de arquivo para aceitar apenas imagens
const imageFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não suportado! Apenas imagens são permitidas.'), false);
    }
};

const uploadVehicle = multer({ storage: vehicleStorage, fileFilter: imageFilter, limits: { fileSize: 1024 * 1024 * 5 } }); // Limite de 5MB

/**
 * Rota para upload de imagem de veículo
 * POST /api/upload/vehicle-image
 * 'vehicleImage' deve ser o nome do campo no FormData
 */
router.post('/vehicle-image', uploadVehicle.single('vehicleImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    }

    // Retorna o caminho público para salvar no banco de dados
    // O 'server.js' está servindo a pasta 'uploads'
    const fotoURL = `/uploads/vehicles/${req.file.filename}`;
    
    res.status(200).json({ 
        message: 'Upload bem-sucedido!',
        fotoURL: fotoURL // ex: /uploads/vehicles/vehicleImage-123456.png
    });
}, (error, req, res, next) => {
    // Tratamento de erro do Multer
    res.status(400).json({ message: error.message });
});

module.exports = router;