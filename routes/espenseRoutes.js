// routes/expenseRoutes.js (Exemplo)
const express = require('express');
const router = express.Router();
const { listExpenses } = require('../controllers/expenseController'); // Função que você precisa criar

// Endpoint para listar todas as despesas (Endpoint de GET que está falhando)
router.get('/', listExpenses); 

module.exports = router;