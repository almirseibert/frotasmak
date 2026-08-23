// routes/comboioTransactionRoutes.js
const express = require('express');
const router = express.Router();
const comboioController = require('../controllers/comboioTransactionController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePage, requireAnyPage } = require('../utils/permissions');

router.use(authMiddleware);

// A distribuição (saída) é feita tanto no desktop (página 'comboio') quanto no
// app do operador do comboio (ComboioMobilePage → 'admin_solicitacoes_app').
const podeDistribuir = requireAnyPage(['comboio', 'admin_solicitacoes_app']);
// Entrada, drenagem, edição e exclusão são exclusivas do desktop.
const podeGerenciar = requirePage('comboio');

// Rotas CRUD padrão
router.get('/', comboioController.getAllComboioTransactions);
router.get('/:id', comboioController.getComboioTransactionById);
router.delete('/:id', podeGerenciar, comboioController.deleteTransaction);
// Nova rota de atualização
router.put('/:id', podeGerenciar, comboioController.updateTransaction);

// Novas rotas para transações do comboio
router.post('/entrada', podeGerenciar, comboioController.createEntradaTransaction);
// /saida aceita multipart (fotos da distribuição do operador). O multer ignora
// requisições JSON, então a distribuição feita pelo desktop continua funcionando.
router.post('/saida', podeDistribuir, comboioController.uploadSaidaFotos, comboioController.createSaidaTransaction);
router.post('/drenagem', podeGerenciar, comboioController.createDrenagemTransaction);

module.exports = router;
