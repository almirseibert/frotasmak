// routes/partCatalogRoutes.js
// Guia de Peças e Reposição — catálogo de referência por modelo de equipamento.
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/partCatalogController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePage, requireAnyPage } = require('../utils/permissions');

router.use(authMiddleware);

// A ficha do veículo (aba "Peças & Reposição") também consome a resolução, então
// quem enxerga a página de veículos pode ler — mesmo sem a chave do guia.
const podeVer = requireAnyPage(['guia_pecas', 'vehicles']);
// Gerenciar o catálogo (criar/editar/excluir) exige a chave do guia.
const podeGerenciar = requirePage('guia_pecas');

// --- Resolução por veículo (leitura ampla) ---
router.get('/for-vehicle/:vehicleId', podeVer, ctrl.getForVehicle);

// --- Modelos ---
router.get('/models', podeVer, ctrl.getModels);
router.get('/models/:id', podeVer, ctrl.getModelById);
router.post('/models', podeGerenciar, ctrl.createModel);
router.put('/models/:id', podeGerenciar, ctrl.updateModel);
router.delete('/models/:id', podeGerenciar, ctrl.deleteModel);

// --- Itens ---
router.post('/items', podeGerenciar, ctrl.createItem);
router.put('/items/:id', podeGerenciar, ctrl.updateItem);
router.delete('/items/:id', podeGerenciar, ctrl.deleteItem);

module.exports = router;
