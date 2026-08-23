const express = require('express');
const router = express.Router();

// Importação dos DOIS controladores separados
const solicitacaoAppController = require('../controllers/solicitacaoAppController');
const solicitacaoAdminController = require('../controllers/solicitacaoAdminController');

const authMiddleware = require('../middlewares/authMiddleware');
const { canUserAccessPage, requireAnyPage } = require('../utils/permissions');

// Multer do App (para fotos de painel e cupom)
const uploadApp = solicitacaoAppController.upload;
// Multer do Admin (para PDFs gerados) - Agora usa o corrigido
const uploadAdmin = solicitacaoAdminController.uploadPdf;

router.use(authMiddleware);

// --- QUEM É GESTOR ---
// Mesma condição já usada no GET '/' abaixo, extraída para poder proteger as
// ações administrativas. Antes destas travas QUALQUER usuário autenticado —
// inclusive o operador que abriu a solicitação — conseguia chamar /avaliar e
// aprovar o próprio pedido, porque o authMiddleware só barra URLs /supervisor.
const ehGestor = (req) =>
    req.user.role === 'admin' ||
    req.user.role === 'gestor' ||
    req.user.canAccessRefueling === true ||
    canUserAccessPage(req.user, 'admin_solicitacoes');

const requireGestor = (req, res, next) => {
    if (ehGestor(req)) return next();
    return res.status(403).json({ error: 'Acesso negado: ação restrita ao setor de abastecimento.' });
};

// O app do operador e o desktop do gestor compartilham as rotas de criação.
const requireApp = requireAnyPage(['admin_solicitacoes_app', 'admin_solicitacoes']);

// --- ROTAS DE LISTAGEM ---
router.get('/', (req, res, next) => {
    if (ehGestor(req)) {
        return solicitacaoAdminController.listarTodasSolicitacoes(req, res, next);
    }
    return solicitacaoAppController.listarMinhasSolicitacoes(req, res, next);
});

// NOVA ROTA: Upload de PDF Gerado (usando o controller Admin atualizado)
// A rota permanece a mesma, mas agora o controller para onde ela aponta está corrigido
router.post('/upload-pdf', requireGestor, uploadAdmin.single('file'), solicitacaoAdminController.uploadPdfGerado);

// --- ROTAS DO APP (MOTORISTA) ---
router.post('/', requireApp, uploadApp.single('foto_painel'), solicitacaoAppController.criarSolicitacao);
router.put('/:id/comprovante', requireApp, uploadApp.single('foto_cupom'), solicitacaoAppController.enviarComprovante);
router.get('/meus-status', solicitacaoAppController.verificarStatusUsuario);

// --- ROTAS DO ADMIN (GESTOR) ---
router.put('/:id/avaliar', requireGestor, solicitacaoAdminController.avaliarSolicitacao);
router.put('/:id/confirmar-baixa', requireGestor, solicitacaoAdminController.confirmarBaixa);
router.put('/:id/rejeitar-comprovante', requireGestor, solicitacaoAdminController.rejeitarComprovante);

module.exports = router;
