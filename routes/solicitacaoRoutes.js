// routes/solicitacaoRoutes.js
const express = require('express');
const router = express.Router();
const solicitacaoController = require('../controllers/solicitacaoController');
const authMiddleware = require('../middlewares/authMiddleware');

// Configuração do Multer (Upload de Imagens) via Controller
// Usamos fields para aceitar 'foto_painel' e 'foto_cupom'
const upload = solicitacaoController.upload;

router.use(authMiddleware);

// 1. Criar Solicitação (Operador) - Recebe dados + Foto do Painel
router.post('/', upload.single('foto_painel'), solicitacaoController.criarSolicitacao);

// 2. Listar Solicitações (Operador vê as suas, Admin vê todas ou filtra)
router.get('/', solicitacaoController.listarSolicitacoes);

// 3. Avaliar Solicitação (Gestor) - Aprovar (Gera Ordem) ou Negar
router.put('/:id/avaliar', solicitacaoController.avaliarSolicitacao);

// 4. Enviar Comprovante/Cupom (Operador) - Após abastecer
router.put('/:id/comprovante', upload.single('foto_cupom'), solicitacaoController.enviarComprovante);

// 5. Confirmar Baixa (Gestor) - Valida o cupom e finaliza
router.put('/:id/confirmar-baixa', solicitacaoController.confirmarBaixa);

// 6. Rejeitar Comprovante (Gestor) - Pede nova foto
router.put('/:id/rejeitar-comprovante', solicitacaoController.rejeitarComprovante);

// 7. Endpoint auxiliar para verificar status de bloqueio do usuário
router.get('/meus-status', solicitacaoController.verificarStatusUsuario);

module.exports = router;