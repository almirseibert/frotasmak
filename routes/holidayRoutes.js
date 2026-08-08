// routes/holidayRoutes.js
//
// Leitura pública (autenticada) dos feriados. O CRUD continua em
// /api/admin/holidays, restrito a admin.
//
// Existe porque o cálculo de prazos em dias úteis (relatos de ocorrência,
// ordens de abastecimento) roda também no frontend, para papéis que não são
// admin — gestor de frota (`oficina`), editor, supervisor. Sem esta rota eles
// receberiam 403 e cairiam num calendário sem feriados.
const express = require('express');
const router = express.Router();
const db = require('../database');
const { listHolidays } = require('../utils/businessDays');

router.get('/', async (req, res) => {
    try {
        res.json(await listHolidays(db));
    } catch (error) {
        console.error('❌ Erro ao listar feriados:', error);
        res.status(500).json({ error: 'Erro ao listar feriados.' });
    }
});

module.exports = router;
