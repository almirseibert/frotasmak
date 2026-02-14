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
        // 1. Busca TODAS as obras
        const [allObras] = await db.query('SELECT * FROM obras');
        
        // 2. Busca contratos (Tabela nova do Supervisor - usa obra_id)
        let contracts = [];
        try {
            const [resContracts] = await db.query('SELECT * FROM obra_contracts');
            contracts = resContracts;
        } catch (e) {}

        // 3. Busca Financeiro (Tabela antiga - provável uso de obraId)
        let expensesMap = {};
        try {
            // Tenta primeiro com obraId (padrão legado)
            const [resExpenses] = await db.query('SELECT obraId, SUM(total_value) as total FROM expenses GROUP BY obraId');
            resExpenses.forEach(r => expensesMap[r.obraId] = r.total);
        } catch (e) {
            try {
                // Se falhar, tenta obra_id (padrão novo)
                const [resExpenses2] = await db.query('SELECT obra_id, SUM(total_value) as total FROM expenses GROUP BY obra_id');
                resExpenses2.forEach(r => expensesMap[r.obra_id] = r.total);
            } catch (e2) { console.warn('[Supervisor] Falha ao ler expenses:', e2.message); }
        }

        // 4. Busca Horas (Tabela antiga - provável uso de obraId)
        let hoursMap = {};
        try {
             // Tenta primeiro com obraId
            const [resHours] = await db.query('SELECT obraId, SUM(horas_trabalhadas) as total FROM daily_work_logs GROUP BY obraId');
            resHours.forEach(r => hoursMap[r.obraId] = r.total);
        } catch (e) {
            try {
                // Fallback para obra_id
                const [resHours2] = await db.query('SELECT obra_id, SUM(horas_trabalhadas) as total FROM daily_work_logs GROUP BY obra_id');
                resHours2.forEach(r => hoursMap[r.obra_id] = r.total);
            } catch (e2) { /* Ignora */ }
        }

        // 5. Montagem dos Dados
        const dashboardData = allObras.map(obra => {
            const obraIdStr = String(obra.id);
            const contract = contracts.find(c => String(c.obra_id) === obraIdStr) || {};
            
            // Valores
            const valorTotal = parseFloat(contract.total_value) || 0;
            const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
            // Busca no mapa usando o ID compatível
            const totalGasto = parseFloat(expensesMap[obraIdStr] || expensesMap[obra.id]) || 0;
            const horasRealizadas = parseFloat(hoursMap[obraIdStr] || hoursMap[obra.id]) || 0;

            // Cálculos Percentuais
            let percentualFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
            let percentualHoras = (horasTotais > 0) ? (horasRealizadas / horasTotais) * 100 : 0;
            const percentualConclusao = Math.max(percentualFinanceiro, percentualHoras);

            // Previsão Inteligente
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';
            const dataInicio = contract.start_date ? new Date(contract.start_date) : null;
            const dataFim = contract.expected_end_date ? new Date(contract.expected_end_date) : null;

            if (horasRealizadas > 0 && horasTotais > 0 && dataInicio) {
                const diffDays = Math.ceil(Math.abs(new Date() - dataInicio) / (86400000)) || 1;
                const horasPorDia = horasRealizadas / diffDays;
                
                if (horasPorDia > 0 && (horasTotais - horasRealizadas) > 0) {
                    const dias = Math.ceil((horasTotais - horasRealizadas) / horasPorDia);
                    previsaoTermino = addBusinessDays(new Date(), dias);
                }
            }
            if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

            return {
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

// 2. OBTER DETALHES (AGORA COM BUSCA CORRETA DE ALOCAÇÕES)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    
    try {
        const [obraInfo] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        if (!obraInfo || obraInfo.length === 0) return res.status(404).json({ message: 'Obra não encontrada.' });
        const obra = obraInfo[0];
        
        // --- CONTRATOS E KPIS (Mesma lógica robusta do dashboard) ---
        let contract = {};
        try {
            const [c] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
            if (c.length > 0) contract = c[0];
        } catch (e) {}

        let totalGasto = 0, horasRealizadas = 0;
        try {
            // Tenta obraId (CamelCase) primeiro
            const [exp] = await db.query('SELECT SUM(total_value) as total FROM expenses WHERE obraId = ?', [id]);
            totalGasto = parseFloat(exp[0].total) || 0;
        } catch (e) {
            try {
                // Fallback obra_id
                const [exp2] = await db.query('SELECT SUM(total_value) as total FROM expenses WHERE obra_id = ?', [id]);
                totalGasto = parseFloat(exp2[0].total) || 0;
            } catch (e2) {}
        }

        try {
            const [hrs] = await db.query('SELECT SUM(horas_trabalhadas) as total FROM daily_work_logs WHERE obraId = ?', [id]);
            horasRealizadas = parseFloat(hrs[0].total) || 0;
        } catch (e) {
            try {
                const [hrs2] = await db.query('SELECT SUM(horas_trabalhadas) as total FROM daily_work_logs WHERE obra_id = ?', [id]);
                horasRealizadas = parseFloat(hrs2[0].total) || 0;
            } catch (e2) {}
        }

        const valorTotal = parseFloat(contract.total_value) || 0;
        const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
        let percentualFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
        let percentualHoras = (horasTotais > 0) ? (horasRealizadas / horasTotais) * 100 : 0;
        const percentualConclusao = Math.max(percentualFinanceiro, percentualHoras);

        let previsaoTermino = null;
        let statusPrazo = 'indefinido';
        const dataInicio = contract.start_date ? new Date(contract.start_date) : null;
        const dataFim = contract.expected_end_date ? new Date(contract.expected_end_date) : null;

        if (horasRealizadas > 0 && horasTotais > 0 && dataInicio) {
            const diffDays = Math.ceil(Math.abs(new Date() - dataInicio) / (86400000)) || 1;
            const horasPorDia = horasRealizadas / diffDays;
            if (horasPorDia > 0) {
                const diasRest = Math.ceil((horasTotais - horasRealizadas) / horasPorDia);
                previsaoTermino = addBusinessDays(new Date(), diasRest);
            }
        }
        if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

        // --- VEÍCULOS E FUNCIONÁRIOS (Corrigido para usar vehicle_operational_assignment) ---
        let allocationData = [];
        try {
            // Busca na tabela de alocação operacional (Assignments)
            // Tenta usar obraId (CamelCase) e vehicleId/employeeId
            const [allocations] = await db.query(`
                SELECT 
                    voa.id, 
                    voa.startDate as data_inicio,
                    v.plate, v.model, v.type as tipo_veiculo,
                    e.name as nome_funcionario, e.role as cargo
                FROM vehicle_operational_assignment voa
                LEFT JOIN vehicles v ON voa.vehicleId = v.id
                LEFT JOIN employees e ON voa.employeeId = e.id
                WHERE voa.obraId = ? AND (voa.endDate IS NULL OR voa.endDate > NOW())
            `, [id]);
            allocationData = allocations;
        } catch (err) {
            console.warn('[Supervisor] Erro ao buscar allocations (tentando snake_case):', err.message);
            // Fallback: Tenta query com snake_case se a primeira falhar
            try {
                const [allocations2] = await db.query(`
                    SELECT 
                        voa.id, 
                        voa.start_date as data_inicio,
                        v.plate, v.model, v.type as tipo_veiculo,
                        e.name as nome_funcionario, e.role as cargo
                    FROM vehicle_operational_assignment voa
                    LEFT JOIN vehicles v ON voa.vehicle_id = v.id
                    LEFT JOIN employees e ON voa.employee_id = e.id
                    WHERE voa.obra_id = ? AND (voa.end_date IS NULL OR voa.end_date > NOW())
                `, [id]);
                allocationData = allocations2;
            } catch (err2) {
                 console.warn('[Supervisor] Falha total em allocations:', err2.message);
            }
        }

        // Separa veículos e funcionários para o frontend
        const vehicles = allocationData
            .filter(a => a.plate) // Tem placa? É veículo
            .map(a => ({ 
                id: a.id, 
                plate: a.plate, 
                model: a.model, 
                type: a.tipo_veiculo, 
                data_alocacao: a.data_inicio 
            }));

        const employees = allocationData
            .filter(a => a.nome_funcionario) // Tem nome? É funcionário
            .map(a => ({
                id: a.id, // ID da alocação ou do func
                nome: a.nome_funcionario,
                cargo: a.cargo,
                data_alocacao: a.data_inicio
            }));

        // CRM Logs
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
            employees: employees, // Novo campo
            crm_history: crmLogs
        });

    } catch (error) {
        console.error('============ ERRO DETALHE ============', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.', debug: error.message });
    }
};

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