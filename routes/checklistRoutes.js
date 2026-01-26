const express = require('express');
const router = express.Router();
const checklistController = require('../controllers/checklistController');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuração do Multer específica para Checklists (PDFs)
// Usa process.cwd() para garantir compatibilidade com Docker/Easypanel
const uploadDir = path.resolve(process.cwd(), 'public/uploads/checklists');

// Cria a pasta se não existir
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Nome único: timestamp-checklist.pdf
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.pdf';
        cb(null, `checklist-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 } // Limite 15MB
});

// --- ROTAS ---

// POST /api/checklists -> Recebe o PDF e salva
router.post('/', upload.single('file'), checklistController.uploadChecklist);

// GET /api/checklists/vehicle/:vehicleId -> Lista histórico
router.get('/vehicle/:vehicleId', checklistController.getChecklistsByVehicle);

module.exports = router;