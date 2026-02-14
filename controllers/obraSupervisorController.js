const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

const addBusinessDays = (startDate, daysToAdd) => {
    if (!startDate) return new Date();
    let count = 0;
    let currentDate = new Date(startDate);
    while (count < daysToAdd) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) count++;
    }
    return currentDate;
};

// ==================================================================================
// CONTROLADORES
// ==================================================================================

// 1. OBTER DADOS DO DASHBOARD (MACRO)
exports.getDashboardData = async (req, res) => {
    try {
        console.log('[Supervisor] Carregando Dashboard...');

        // 1. Busca TODAS as obras sem filtro de status (traz o que tiver no banco)
        const [allObras] = await db.query('SELECT * FROM obras');
        console.log(`[Supervisor] Obras encontradas: ${allObras.length}`);

        // 2. Busca tabelas auxiliares com tratamento de erro (caso não existam no dump novo)
        let contracts = [];
        try {
            const [resContracts] = await db.query('SELECT * FROM obra_contracts');
            contracts = resContracts;
        } catch (e) { 
            // Se der erro, tenta criar a tabela dinamicamente (Auto-Fix)
            console.warn('[Supervisor] Tabela contratos ausente, retornando array vazio.'); 
        }

        let expensesMap = {};
        try {
            const [resExpenses] = await db.query('SELECT obra_id, SUM(total_value) as total FROM expenses GROUP BY obra_id');
            resExpenses.forEach(r => expensesMap[r.obra_id] = r.total);
        } catch (e) { /* Ignora */ }

        let hoursMap = {};
        try {
            const [resHours] = await db.query('SELECT obra_id, SUM(horas_trabalhadas) as total FROM daily_work_logs GROUP BY obra_id');
            resHours.forEach(r => hoursMap[r.obra_id] = r.total);
        } catch (e) { /* Ignora */ }

        // 3. Monta o objeto final
        const dashboardData = allObras.map(obra => {
            const obraIdStr = String(obra.id);
            const contract = contracts.find(c => String(c.obra_id) === obraIdStr) || {};
            
            const valorTotal = parseFloat(contract.total_value) || 0;
            const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
            const totalGasto = parseFloat(expensesMap[obraIdStr] || expensesMap[obra.id]) || 0;
            const horasRealizadas = parseFloat(hoursMap[obraIdStr] || hoursMap[obra.id]) || 0;

            let percentualFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
            let percentualHoras = (horasTotais > 0) ? (horasRealizadas / horasTotais) * 100 : 0;
            const percentualConclusao = Math.max(percentualFinanceiro, percentualHoras);

            // Previsão Inteligente
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';
            const dataInicio = contract.start_date ? new Date(contract.start_date) : null;
            const dataFim = contract.expected_end_date ? new Date(contract.expected_end_date) : null;

            if (horasRealizadas > 0 && horasTotais > 0 && dataInicio) {
                const hoje = new Date();
                const diffTime = Math.abs(hoje - dataInicio);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
                const horasPorDia = horasRealizadas / diffDays;
                
                if (horasPorDia > 0 && (horasTotais - horasRealizadas) > 0) {
                    const dias = Math.ceil((horasTotais - horasRealizadas) / horasPorDia);
                    previsaoTermino = addBusinessDays(new Date(), dias);
                }
            }
            if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

            return {
                id: String(obra.id),
                nome: obra.nome || 'Obra sem nome',
                status: obra.status || 'Desconhecido',
                responsavel: contract.fiscal_nome || 'Não Definido', 
                fiscal_nome: contract.fiscal_nome,
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasTotais,
                    horas_realizadas: horasRealizadas,
                    saldo_financeiro: valorTotal - totalGasto,
                    saldo_horas: horasTotais - horasRealizadas,
                    percentual_conclusao: parseFloat(percentualConclusao.toFixed(1)),
                    alertas_assinatura: 0
                },
                previsao: {
                    data_termino_estimada: previsaoTermino,
                    status: statusPrazo
                },
                data_inicio_contratual: contract.start_date,
                data_fim_contratual: contract.expected_end_date
            };
        });

        res.json(dashboardData);

    } catch (error) {
        console.error('============ ERRO DASHBOARD ============', error);
        res.status(500).json({ message: 'Erro interno.', debug: error.message });
    }
};

// 2. OBTER DETALHES (COM BUSCA DE VEÍCULOS POR ATIVIDADE)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    
    try {
        const [obraInfo] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        
        if (!obraInfo || obraInfo.length === 0) {
            return res.status(404).json({ message: 'Obra não encontrada.' });
        }
        
        const obra = obraInfo[0];
        
        // Contratos e KPIs (Mesma lógica do dashboard)
        let contract = {};
        try {
            const [c] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
            if (c.length > 0) contract = c[0];
        } catch (e) {}

        let totalGasto = 0, horasRealizadas = 0;
        try {
            const [exp] = await db.query('SELECT SUM(total_value) as total FROM expenses WHERE obra_id = ?', [id]);
            totalGasto = parseFloat(exp[0].total) || 0;
            const [hrs] = await db.query('SELECT SUM(horas_trabalhadas) as total FROM daily_work_logs WHERE obra_id = ?', [id]);
            horasRealizadas = parseFloat(hrs[0].total) || 0;
        } catch (e) {}

        const valorTotal = parseFloat(contract.total_value) || 0;
        const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
        let percentualFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
        let percentualHoras = (horasTotais > 0) ? (horasRealizadas / horasTotais) * 100 : 0;
        const percentualConclusao = Math.max(percentualFinanceiro, percentualHoras);

        // Previsão
        let previsaoTermino = null;
        let statusPrazo = 'indefinido';
        const dataInicio = contract.start_date ? new Date(contract.start_date) : null;
        const dataFim = contract.expected_end_date ? new Date(contract.expected_end_date) : null;

        if (horasRealizadas > 0 && horasTotais > 0 && dataInicio) {
            const diffDays = Math.ceil(Math.abs(new Date() - dataInicio) / (86400000)) || 1;
            const horasPorDia = horasRealizadas / diffDays;
            if (horasPorDia > 0) {
                const diasRest = Math.ceil((horasTotais - horasRealizadas) / horasPorDia);
                if (diasRest > 0) previsaoTermino = addBusinessDays(new Date(), diasRest);
            }
        }
        if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

        // ======================================================================
        // ESTRATÉGIA DE VEÍCULOS: BUSCA POR ATIVIDADE RECENTE (30 DIAS)
        // ======================================================================
        // Como não temos coluna 'location' fixa, assumimos que quem trabalhou na obra
        // recentemente está alocado lá.
        let vehicles = [];
        try {
            const [activeVehicles] = await db.query(`
                SELECT DISTINCT v.id, v.plate, v.model, v.type 
                FROM vehicles v
                JOIN daily_work_logs d ON v.id = d.vehicle_id
                WHERE d.obra_id = ? 
                AND d.work_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                ORDER BY d.work_date DESC
            `, [id]);
            vehicles = activeVehicles;
            console.log(`[Supervisor] Veículos ativos encontrados na obra ${id}: ${vehicles.length}`);
        } catch (vErr) {
            console.warn('[Supervisor] Erro ao buscar veículos por atividade:', vErr.message);
        }

        let crmLogs = [];
        try {
            const [logs] = await db.query('SELECT * FROM obra_crm_logs WHERE obra_id = ? ORDER BY created_at DESC LIMIT 50', [id]);
            crmLogs = logs;
        } catch (crmErr) {}

        res.json({
            obra: {
                id: String(obra.id),
                nome: obra.nome,
                status: obra.status,
                responsavel: contract.fiscal_nome || 'Não Definido', 
                fiscal_nome: contract.fiscal_nome,
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasTotais,
                    horas_realizadas: horasRealizadas,
                    percentual_conclusao: parseFloat(percentualConclusao.toFixed(1)),
                },
                previsao: { data_termino_estimada: previsaoTermino, status: statusPrazo },
                data_inicio_contratual: contract.start_date,
                data_fim_contratual: contract.expected_end_date
            },
            vehicles: vehicles,
            crm_history: crmLogs
        });

    } catch (error) {
        console.error('============ ERRO DETALHE ============', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.', debug: error.message });
    }
};

// ... Resto dos métodos (addCrmLog, upsertContract) permanecem iguais ...
exports.addCrmLog = async (req, res) => {
    const { obra_id, tipo_interacao, resumo_conversa, data_proximo_contato } = req.body;
    const supervisor_id = req.user?.userId || null;
    const supervisor_name = req.user?.username || 'Supervisor'; 
    try {
        await db.query(`INSERT INTO obra_crm_logs (obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato) VALUES (?, ?, ?, ?, ?, ?)`, [obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato]);
        res.status(201).json({ message: 'Salvo.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar.' }); }
};

exports.upsertContract = async (req, res) => {
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome } = req.body;
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;
    if (!fiscal_nome) fiscal_nome = null;
    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);
        if (existing.length > 0) {
            await db.query(`UPDATE obra_contracts SET total_value = ?, total_hours_contracted = ?, start_date = ?, expected_end_date = ?, fiscal_nome = ? WHERE obra_id = ?`, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, obra_id]);
        } else {
            await db.query(`INSERT INTO obra_contracts (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome) VALUES (?, ?, ?, ?, ?, ?)`, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome]);
        }
        res.json({ message: 'Salvo.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar.' }); }
};