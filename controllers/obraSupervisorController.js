const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

const addBusinessDays = (startDate, daysToAdd) => {
    if (!startDate) return new Date();
    let count = 0;
    let currentDate = new Date(startDate);
    // Proteção contra loop infinito
    if (daysToAdd > 2000) daysToAdd = 2000; 
    
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
        console.log('[Supervisor] Calculando Dashboard Inteligente...');

        // 1. Dados Básicos
        const [allObras] = await db.query('SELECT * FROM obras WHERE status = "ativa"');
        const [contracts] = await db.query('SELECT * FROM obra_contracts');
        
        // 2. Agregações Financeiras e de Horas (Faturamento)
        const [expenses] = await db.query(`
            SELECT obraId, SUM(totalValue) as total 
            FROM expenses 
            GROUP BY obraId
        `); // Ajuste conforme nome real da coluna na sua tabela expenses (totalValue ou amount)

        const [hoursLogs] = await db.query(`
            SELECT obraId, SUM(totalHours) as total 
            FROM daily_work_logs 
            GROUP BY obraId
        `);

        // 3. Contagem de Máquinas Ativas (Para o cálculo de previsão)
        // Consideramos "Pesados" para o cálculo: Caminhão, Escavadeira, Motoniveladora, Retroescavadeira, Rolo, Trator
        const [activeMachines] = await db.query(`
            SELECT 
                voa.obraId, 
                COUNT(DISTINCT voa.vehicleId) as qtd_maquinas
            FROM vehicle_operational_assignment voa
            LEFT JOIN vehicles v ON voa.vehicleId = v.id
            WHERE (voa.endDate IS NULL OR voa.endDate > NOW())
            AND v.tipo IN ('Caminhão', 'Escavadeira', 'Motoniveladora', 'Retroescavadeira', 'Rolo', 'Trator', 'Pá Carregadeira')
            GROUP BY voa.obraId
        `);

        // Mapeamento para acesso rápido
        const contractMap = {}; contracts.forEach(c => contractMap[c.obra_id] = c);
        const expenseMap = {}; expenses.forEach(e => expenseMap[e.obraId] = e.total);
        const hoursMap = {}; hoursLogs.forEach(h => hoursMap[h.obraId] = h.total);
        const machinesMap = {}; activeMachines.forEach(m => machinesMap[m.obraId] = m.qtd_maquinas);

        const dashboardData = allObras.map(obra => {
            const obraId = String(obra.id);
            const contract = contractMap[obra.id] || {};
            
            // Valores
            const valorTotal = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
            const horasContratadas = parseFloat(contract.total_hours_contracted) || 0;
            const totalGasto = parseFloat(expenseMap[obraId]) || 0;
            const horasExecutadas = parseFloat(hoursMap[obraId]) || 0;

            // Percentuais
            let percFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
            let percHoras = (horasContratadas > 0) ? (horasExecutadas / horasContratadas) * 100 : 0;
            const percConclusao = Math.max(percFinanceiro, percHoras);

            // === LÓGICA DE PREVISÃO INTELIGENTE ===
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';
            let diasRestantes = 0;

            if (horasContratadas > 0) {
                const horasSaldo = horasContratadas - horasExecutadas;
                const maquinasAtivas = machinesMap[obraId] || 0;
                
                // Média de produção diária (8h por máquina dia útil é o padrão da indústria/solicitado)
                // Se não tiver máquina, assume 1 para não dividir por zero e dar erro
                const capacidadeDiaria = (maquinasAtivas > 0 ? maquinasAtivas : 1) * 8; 

                if (horasSaldo > 0) {
                    diasRestantes = Math.ceil(horasSaldo / capacidadeDiaria);
                    previsaoTermino = addBusinessDays(new Date(), diasRestantes);
                } else {
                    diasRestantes = 0;
                    previsaoTermino = new Date(); // Obra teoricamente acabou
                }

                // Verifica atraso
                const dataFimContrato = contract.expected_end_date ? new Date(contract.expected_end_date) : null;
                if (dataFimContrato && previsaoTermino > dataFimContrato) {
                    statusPrazo = 'atrasado';
                } else {
                    statusPrazo = 'no_prazo';
                }
            }

            // Alertas CRM
            // Aqui você pode fazer uma query extra para saber se tem logs pendentes, 
            // mas por performance no dashboard macro, deixamos simplificado.
            
            return {
                id: obraId,
                nome: obra.nome,
                status: obra.status,
                responsavel: contract.fiscal_nome || obra.responsavel || 'A Definir', // Prioriza contrato, fallback obra
                fiscal_nome: contract.fiscal_nome || obra.fiscal || 'A Definir',
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasContratadas,
                    horas_executadas: horasExecutadas, // Info vinda do Faturamento (daily_work_logs)
                    percentual_conclusao: parseFloat(percConclusao.toFixed(1)),
                    dias_restantes_estimados: diasRestantes,
                    maquinas_ativas: machinesMap[obraId] || 0,
                    status_cor: getStatusColor(percConclusao)
                },
                previsao: {
                    data_termino_estimada: previsaoTermino,
                    status: statusPrazo
                },
                data_inicio: contract.start_date || obra.dataInicio,
                data_fim_contratual: contract.expected_end_date
            };
        });

        // Ordenação Inteligente: Quem termina antes (data estimada) vem primeiro
        dashboardData.sort((a, b) => {
            if (!a.previsao.data_termino_estimada) return 1;
            if (!b.previsao.data_termino_estimada) return -1;
            return new Date(a.previsao.data_termino_estimada) - new Date(b.previsao.data_termino_estimada);
        });

        res.json(dashboardData);

    } catch (error) {
        console.error('Erro Dashboard:', error);
        res.status(500).json({ message: 'Erro interno.' });
    }
};

// Helper de cor
function getStatusColor(perc) {
    if (perc >= 90) return 'red';
    if (perc >= 70) return 'violet';
    if (perc >= 30) return 'yellow';
    return 'green';
}

// 2. DETALHES DA OBRA (COCKPIT)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const [obra] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        if (!obra.length) return res.status(404).json({message: 'Obra não encontrada'});

        // Reuse a lógica do dashboard para pegar os KPIs atualizados
        // (Em produção idealmente refatorar para função compartilhada)
        const [contract] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
        const contractData = contract[0] || {};

        // Burnup Chart Data (Agrupado por semana ou mês)
        const [burnupData] = await db.query(`
            SELECT 
                DATE(date) as data, 
                SUM(totalHours) as horas_dia 
            FROM daily_work_logs 
            WHERE obraId = ? 
            GROUP BY DATE(date) 
            ORDER BY date ASC
        `, [id]);

        // Veículos Alocados + Fator de Substituição
        const [vehicles] = await db.query(`
            SELECT 
                v.id, v.placa, v.modelo, v.tipo, 
                voa.startDate as data_alocacao,
                e.name as operador_nome,
                ces.fator_conversao,
                ces.grupo_contratado
            FROM vehicle_operational_assignment voa
            JOIN vehicles v ON voa.vehicleId = v.id
            LEFT JOIN employees e ON voa.employeeId = e.id
            LEFT JOIN contract_equipment_substitutions ces ON ces.veiculo_real_id = v.id AND ces.obra_contract_id = ?
            WHERE voa.obraId = ? 
            AND (voa.endDate IS NULL OR voa.endDate > NOW())
        `, [contractData.id || 0, id]);

        // Histórico CRM
        const [crmLogs] = await db.query(`
            SELECT * FROM obra_crm_logs 
            WHERE obra_id = ? 
            ORDER BY created_at DESC
        `, [id]);

        // Calcular KPIs finais para envio
        // ... (Mesma lógica do dashboard para calcular previsão e saldos)
        
        res.json({
            obra: obra[0],
            contract: contractData,
            burnup: burnupData, // Array para o gráfico
            vehicles: vehicles,
            crm: crmLogs
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({message: 'Erro ao carregar detalhes'});
    }
};

// 3. REGISTRAR CRM
exports.addCrmLog = async (req, res) => {
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.userId; // Do middleware de auth

    try {
        await db.query(`
            INSERT INTO obra_crm_logs 
            (obra_id, user_id, interaction_type, notes, agreed_action)
            VALUES (?, ?, ?, ?, ?)
        `, [obra_id, user_id, interaction_type, notes, agreed_action]);
        
        res.json({success: true});
    } catch (e) {
        res.status(500).json({error: e.message});
    }
};