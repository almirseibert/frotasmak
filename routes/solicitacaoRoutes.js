const express = require('express');
const router = express.Router();

// Importação dos DOIS controladores separados
const solicitacaoAppController = require('../controllers/solicitacaoAppController');
const solicitacaoAdminController = require('../controllers/solicitacaoAdminController');

const authMiddleware = require('../middlewares/authMiddleware');

// Configuração do Multer (Vem do Controller do App, pois é lá que ocorre o upload)
const upload = solicitacaoAppController.upload;

router.use(authMiddleware);

// --- ROTAS DE LISTAGEM (ROTEAMENTO INTELIGENTE) ---
// O frontend chama a mesma URL '/solicitacoes', mas o backend decide qual controller usar
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
// Criar solicitação e Uploads
router.post('/', upload.single('foto_painel'), solicitacaoAppController.criarSolicitacao);
router.put('/:id/comprovante', upload.single('foto_cupom'), solicitacaoAppController.enviarComprovante);
router.get('/meus-status', solicitacaoAppController.verificarStatusUsuario);

// --- ROTAS DO ADMIN (GESTOR) ---
// Avaliação e Baixas
router.put('/:id/avaliar', solicitacaoAdminController.avaliarSolicitacao);
router.put('/:id/confirmar-baixa', solicitacaoAdminController.confirmarBaixa);
router.put('/:id/rejeitar-comprovante', solicitacaoAdminController.rejeitarComprovante);

module.exports = router;