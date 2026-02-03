const express = require('express');
const router = express.Router();

// Importação dos DOIS controladores separados
const solicitacaoAppController = require('../controllers/solicitacaoAppController');
const solicitacaoAdminController = require('../controllers/solicitacaoAdminController');

const authMiddleware = require('../middlewares/authMiddleware');

// Multer do App (para fotos de painel e cupom)
const uploadApp = solicitacaoAppController.upload;
// Multer do Admin (para PDFs gerados)
const uploadAdmin = solicitacaoAdminController.uploadPdf;

router.use(authMiddleware);

// --- ROTAS DE LISTAGEM (ROTEAMENTO INTELIGENTE) ---
router.get('/', (req, res, next) => {
    const userRole = req.user.role;
    // Definição de quem é gestor
    const isGestor = userRole === 'admin' || userRole === 'gestor' || req.user.canAccessRefueling;

    if (isGestor) {
        // Se for gestor, usa o controller de Admin (vê tudo)
        return solicitacaoAdminController.listarTodasSolicitacoes(req, res, next);
    } else {
        // Se for usuário comum, usa o controller do App (vê apenas as suas)
        return solicitacaoAppController.listarMinhasSolicitacoes(req, res, next);
    }
});

// --- ROTAS DO APP (MOTORISTA) ---
router.post('/', uploadApp.single('foto_painel'), solicitacaoAppController.criarSolicitacao);
router.put('/:id/comprovante', uploadApp.single('foto_cupom'), solicitacaoAppController.enviarComprovante);
router.get('/meus-status', solicitacaoAppController.verificarStatusUsuario);

// --- ROTAS DO ADMIN (GESTOR) ---
router.put('/:id/avaliar', solicitacaoAdminController.avaliarSolicitacao);
router.put('/:id/confirmar-baixa', solicitacaoAdminController.confirmarBaixa);
router.put('/:id/rejeitar-comprovante', solicitacaoAdminController.rejeitarComprovante);

// NOVA ROTA: Upload de PDF Gerado (Ordem)
router.post('/upload-pdf-generated', uploadAdmin.single('file'), solicitacaoAdminController.uploadPdfGerado);

module.exports = router;