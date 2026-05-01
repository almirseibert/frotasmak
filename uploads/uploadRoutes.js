const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Verifica se o diretório do volume persistente existe, se não, cria
const uploadDir = '/usr/src/app/public/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer para salvar os arquivos no disco
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Gera um nome único para o arquivo (ex: 168923984123-arquivo.pdf)
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Remove espaços e caracteres especiais do nome original para evitar bugs em URLs
        const cleanOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, uniqueSuffix + '-' + cleanOriginalName);
    }
});

const upload = multer({ storage: storage });

// --- ROTA GENÉRICA DE UPLOAD ---
// Endpoint: POST /api/upload
router.post('/', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
        }

        // Constrói a URL pública baseada no host atual
        // Importante: Seu server.js precisa estar servindo a pasta public/uploads estaticamente
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

module.exports = router;