// routes/refuelingRoutes.js
const express = require('express');
const router = express.Router();
const refuelingController = require('../controllers/refuelingController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAnyPage } = require('../utils/permissions');

router.use(authMiddleware);

// Emitir, editar, dar baixa e liberar ordem exige a área de abastecimento.
// Aceita 'admin_solicitacoes' junto de 'refueling' porque a tela de Solicitações
// (App) emite a ordem e dá a baixa pelos mesmos endpoints, e há usuários com
// page_permissions individual contendo só uma das duas páginas.
// As leituras (GET) seguem abertas a qualquer autenticado: já passam pelo
// filtro de ordens reservadas (HIDDEN_VISIBILITY_CLAUSE) e alimentam o
// DataContext de várias telas.
const podeOperar = requireAnyPage(['refueling', 'admin_solicitacoes']);

// --- ROTA DE UPLOAD (MUITO IMPORTANTE: DEVE VIR ANTES DE /:id) ---
// Se ficar depois, o sistema acha que "upload-pdf" é um ID de abastecimento
router.post('/upload-pdf', podeOperar, refuelingController.upload.single('file'), refuelingController.uploadOrderPdf);

// --- NOVA ROTA: Envio de Email ---
router.post('/send-email', podeOperar, refuelingController.sendOrderEmail);

// Rotas CRUD padrão
router.get('/', refuelingController.getAllRefuelings);
// Agregação de consumo por obra (soma no banco) — DEVE vir antes de /:id
router.get('/aggregates/by-obra', refuelingController.getAggregatesByObra);
// Checagem de NF duplicada (posto + número) — DEVE vir antes de /:id
router.get('/check-invoice', refuelingController.checkInvoiceDuplicate);
// Agregações do dashboard — DEVEM vir antes de /:id
router.get('/aggregates/last-by-vehicle-obra', refuelingController.getLastRefuelByVehicleObra);
router.get('/aggregates/efficiency-by-vehicle', refuelingController.getEfficiencyByVehicle);
router.get('/aggregates/averages-by-vehicle', refuelingController.getAveragesByVehicle);
// Abastecimentos de um conjunto de veículos (terceirizados) — antes de /:id
router.get('/by-vehicles', refuelingController.getRefuelingsByVehicles);
// Regras pontuais — DEVEM vir antes de /:id, senão viram um id de abastecimento
router.get('/open', refuelingController.getOpenRefuelingByVehicle);
router.get('/obra-status/:obraId', refuelingController.getObraFuelStatus);
// Abastecimentos de um veículo — DEVE vir antes de /:id (senão "vehicle" vira um id)
router.get('/vehicle/:vehicleId', refuelingController.getRefuelingsByVehicle);
router.get('/:id', refuelingController.getRefuelingById);
router.post('/', podeOperar, refuelingController.createRefuelingOrder);
router.put('/:id', podeOperar, refuelingController.updateRefuelingOrder);
router.delete('/:id', podeOperar, refuelingController.deleteRefuelingOrder);

// Rota para confirmar um abastecimento em aberto
router.put('/:id/confirm', podeOperar, refuelingController.confirmRefuelingOrder);

// Rota para liberar ordem bloqueada (admin)
router.put('/:id/liberar', podeOperar, refuelingController.liberarOrdemBloqueada);

// Rota para negar (excluir) ordem bloqueada (admin)
router.delete('/:id/negar', podeOperar, refuelingController.negarOrdemBloqueada);

// Rota para liberar/reagendar ordem reservada (só o emissor)
router.put('/:id/revelar', podeOperar, refuelingController.revelarOrdemOculta);

module.exports = router;
