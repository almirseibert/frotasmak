// routes/comboioTransactionRoutes.js
const express = require('express');
const router = express.Router();
const comboioController = require('../controllers/comboioTransactionController');
const refuelingController = require('../controllers/refuelingController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePage, requireAnyPage } = require('../utils/permissions');
const db = require('../database');

router.use(authMiddleware);

// A distribuição (saída) é feita tanto no desktop (página 'comboio') quanto no
// app do operador do comboio (ComboioMobilePage → 'admin_solicitacoes_app').
const podeDistribuir = requireAnyPage(['comboio', 'admin_solicitacoes_app']);
// Entrada, drenagem, edição e exclusão são exclusivas do desktop.
const podeGerenciar = requirePage('comboio');
// Leitura: a própria tela, o app do operador e os módulos que consomem o
// histórico do comboio (terceirizados/análise). Antes qualquer usuário logado
// baixava a tabela inteira.
const podeConsultar = requireAnyPage(['comboio', 'admin_solicitacoes_app', 'terceirizados', 'analise_gerencial']);

// As rotas /entrada/:id* reaproveitam os handlers de ordem de abastecimento.
// Esta trava garante que a permissão 'comboio' só alcance ordens de ENTRADA de
// comboio — nunca ordens normais de abastecimento.
const assertComboioEntrada = async (req, res, next) => {
    try {
        const [[ordem]] = await db.execute('SELECT comboioEntrada FROM refuelings WHERE id = ?', [req.params.id]);
        if (!ordem || Number(ordem.comboioEntrada) !== 1) {
            return res.status(404).json({ error: 'Ordem de entrada de comboio não encontrada.' });
        }
        next();
    } catch (error) {
        console.error('❌ assertComboioEntrada:', error.message);
        res.status(500).json({ error: 'Erro ao validar a ordem de entrada.' });
    }
};

// Listagens (as fixas antes de '/:id')
router.get('/', podeConsultar, comboioController.getAllComboioTransactions);
router.get('/pendencias', podeGerenciar, comboioController.getComboioPendencias);
router.get('/resumo', podeGerenciar, comboioController.getComboioResumo);

// Entrada = ordem ao posto + baixa (mesmo pipeline do Abastecimento)
router.post('/entrada/ordem', podeGerenciar, refuelingController.createComboioEntradaOrder);
router.put('/entrada/:id', podeGerenciar, assertComboioEntrada, refuelingController.updateRefuelingOrder);
router.put('/entrada/:id/baixa', podeGerenciar, assertComboioEntrada, refuelingController.confirmRefuelingOrder);
router.delete('/entrada/:id', podeGerenciar, assertComboioEntrada, refuelingController.deleteRefuelingOrder);
// Lançamento direto de entrada já abastecida (compatibilidade).
router.post('/entrada', podeGerenciar, comboioController.createEntradaTransaction);

// /saida aceita multipart (fotos da distribuição do operador). O multer ignora
// requisições JSON, então a distribuição feita pelo desktop continua funcionando.
router.post('/saida', podeDistribuir, comboioController.uploadSaidaFotos, comboioController.createSaidaTransaction);
router.post('/drenagem', podeGerenciar, comboioController.createDrenagemTransaction);

router.get('/:id', podeConsultar, comboioController.getComboioTransactionById);
router.put('/:id/liberar', podeGerenciar, comboioController.liberarSaida);
router.put('/:id', podeGerenciar, comboioController.updateTransaction);
router.delete('/:id', podeGerenciar, comboioController.deleteTransaction);

module.exports = router;
