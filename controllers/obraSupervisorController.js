const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES MATEMÁTICAS
// ==================================================================================

const sumLegacyHours = (jsonInput) => {
    if (!jsonInput) return 0;
    try {
        const data = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
        if (typeof data !== 'object' || data === null) return 0;
        return Object.values(data).reduce((acc, curr) => acc + (parseFloat(curr) || 0), 0);
    } catch (e) { return 0; }
};

const addBusinessDays = (startDate, daysToAdd) => {
    let currentDate = new Date(startDate);
    // Proteção de loop
    if (daysToAdd > 5000) daysToAdd = 5000; 
    
    let count = 0;
    while (count < daysToAdd) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        // 0 = Domingo, 6 = Sábado
        if (dayOfWeek !== 0 && dayOfWeek !== 6) count++;
    }
    return currentDate;
};

// ==================================================================================
// CONTROLADORES
// ==================================================================================

// 1. DASHBOARD MACRO (Visão Geral)
exports.getDashboardData = async (req, res) => {
    try {
        // Busca apenas obras ativas
        const [allObras] = await db.query('SELECT * FROM obras WHERE status = "ativa"');
        
        // Buscas Auxiliares
        let contracts = [];
        try { const [r] = await db.query('SELECT * FROM obra_contracts'); contracts = r || []; } catch (e) {}
        
        // Mapeamento de contratos
        const contractMap = {}; contracts.forEach(c => contractMap[c.obra_id] = c);

        // Agregação de dados para o dashboard (simplificado para performance)
        const dashboardData = await Promise.all(allObras.map(async (obra) => {
            const obraId = String(obra.id);
            const contract = contractMap[obra.id] || {};

            // 1. Definição de Totais (Prioridade: Contrato > Legado > 0)
            let horasContratadas = parseFloat(contract.total_hours_contracted) || sumLegacyHours(obra.horasContratadasPorTipo);
            let valorTotal = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
            
            // 2. Executado (Total Geral)
            const [logs] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [obraId]);
            const horasExecutadas = parseFloat(logs[0]?.total) || 0;
            
            const [expenses] = await db.query('SELECT SUM(amount) as total FROM expenses WHERE obraId = ?', [obraId]);
            const totalGasto = parseFloat(expenses[0]?.total) || 0;

            // 3. CÁLCULO INTELIGENTE DE PREVISÃO (Janela de 10 dias)
            // Busca produtividade dos últimos 10 dias de registro
            const [recentLogs] = await db.query(`
                SELECT vehicleId, date, SUM(totalHours) as daily_hours
                FROM daily_work_logs 
                WHERE obraId = ? 
                AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY) 
                GROUP BY vehicleId, date
            `, [obraId]);

            // Calcula média diária POR MÁQUINA ativa
            const vehicleAverages = {};
            recentLogs.forEach(log => {
                if (!vehicleAverages[log.vehicleId]) vehicleAverages[log.vehicleId] = [];
                vehicleAverages[log.vehicleId].push(log.daily_hours);
            });

            let capacidadeDiariaCanteiro = 0;
            Object.values(vehicleAverages).forEach(days => {
                const sum = days.reduce((a, b) => a + b, 0);
                const avg = sum / (days.length || 1);
                capacidadeDiariaCanteiro += avg;
            });

            // Fallback: Se não tiver dados recentes, usa regra de bolso (8h * num_maquinas)
            if (capacidadeDiariaCanteiro === 0) {
                const [veiculosAtivos] = await db.query(`SELECT COUNT(id) as qtd FROM vehicles WHERE obraAtualId = ?`, [obraId]);
                capacidadeDiariaCanteiro = (veiculosAtivos[0]?.qtd || 1) * 8; 
            }

            // 4. Previsão Final
            const saldoHoras = horasContratadas - horasExecutadas;
            let diasRestantes = 0;
            let previsaoTermino = new Date();

            if (saldoHoras > 0 && capacidadeDiariaCanteiro > 0) {
                diasRestantes = Math.ceil(saldoHoras / capacidadeDiariaCanteiro);
                previsaoTermino = addBusinessDays(new Date(), diasRestantes);
            }

            const percConclusao = horasContratadas > 0 ? (horasExecutadas / horasContratadas) * 100 : 0;

            return {
                id: obraId,
                nome: obra.nome,
                responsavel: contract.responsavel_nome || obra.responsavel || 'A Definir',
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasContratadas,
                    horas_executadas: horasExecutadas,
                    percentual_conclusao: parseFloat(percConclusao.toFixed(1)),
                    dias_restantes_estimados: diasRestantes,
                    capacidade_diaria_atual: capacidadeDiariaCanteiro, // O ritmo atual
                    status_cor: getStatusColor(percConclusao)
                },
                previsao: {
                    data_termino_estimada: previsaoTermino
                }
            };
        }));

        dashboardData.sort((a, b) => new Date(a.previsao.data_termino_estimada) - new Date(b.previsao.data_termino_estimada));
        res.json(dashboardData);

    } catch (error) {
        console.error('Erro Dashboard Supervisor:', error);
        res.status(500).json({ message: 'Erro interno.', debug: error.message });
    }
};

// 2. DETALHES COMPLETOS (Financeiro + Previsão + Desmobilização)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        // --- DADOS BÁSICOS ---
        const [obraRes] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        if (!obraRes.length) return res.status(404).json({message: 'Obra não encontrada'});
        const obra = obraRes[0];

        const [contractRes] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
        let contract = contractRes[0] || {};

        // Unificação de Dados (Contrato vs Legado)
        contract.total_value = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
        contract.total_hours_contracted = parseFloat(contract.total_hours_contracted) || sumLegacyHours(obra.horasContratadasPorTipo);
        contract.start_date = contract.start_date || obra.dataInicio;

        // --- FINANCEIRO AVANÇADO ---
        // Despesas por Categoria
        const [expensesCategory] = await db.query(`
            SELECT category, SUM(amount) as total 
            FROM expenses 
            WHERE obraId = ? 
            GROUP BY category
        `, [id]);
        
        const totalDespesas = expensesCategory.reduce((acc, curr) => acc + parseFloat(curr.total), 0);

        // --- CÉREBRO MATEMÁTICO (Capacidade Produtiva) ---
        // 1. Média dos últimos 10 dias
        const [recentActivity] = await db.query(`
            SELECT date, SUM(totalHours) as total_dia
            FROM daily_work_logs 
            WHERE obraId = ? 
            AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
            GROUP BY date
            ORDER BY date ASC
        `, [id]);

        // Média Móvel Simples
        let mediaDiariaObra = 0;
        if (recentActivity.length > 0) {
            const somaTotalRecente = recentActivity.reduce((acc, cur) => acc + parseFloat(cur.total_dia), 0);
            mediaDiariaObra = somaTotalRecente / recentActivity.length;
        }

        // --- LOGICA DE DESMOBILIZAÇÃO POR MÁQUINA ---
        // Buscar veículos e calcular quando CADA UM deve sair baseado na média individual
        const [vehicles] = await db.query(`
            SELECT v.id, v.placa, v.modelo, v.tipo, v.operationalAssignment
            FROM vehicles v 
            WHERE v.obraAtualId = ?
        `, [id]);

        const machinePredictions = await Promise.all(vehicles.map(async (v) => {
            // Média individual desta máquina
            const [myLogs] = await db.query(`
                SELECT SUM(totalHours) / COUNT(DISTINCT date) as media_individual
                FROM daily_work_logs
                WHERE vehicleId = ? AND obraId = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
            `, [v.id, id]);
            
            const mediaIndividual = parseFloat(myLogs[0]?.media_individual) || 0;
            
            // Lógica Simplificada de Saída:
            // Assumimos que todas as máquinas trabalham até o fim do "Saldo de Horas" global da obra
            // Ou, se houver alocação específica, usaríamos isso. Aqui usaremos a data final da obra.
            
            // Ler JSON de próxima alocação (se existir)
            let nextAllocation = {};
            try {
                if (v.operationalAssignment && typeof v.operationalAssignment === 'object') {
                    nextAllocation = v.operationalAssignment.next_mission || {};
                }
            } catch (e) {}

            return {
                ...v,
                media_diaria: mediaIndividual,
                proximo_destino: nextAllocation.location || '',
                data_liberacao_manual: nextAllocation.release_date || null
            };
        }));

        // --- KPI FINAL ---
        const [totalHoursRes] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [id]);
        const horasExecutadas = parseFloat(totalHoursRes[0]?.total) || 0;
        
        // Status de Faturamento
        // Valor Produzido (Medição Física) = % Executado * Valor Contrato
        const percExecucaoFisica = contract.total_hours_contracted > 0 ? (horasExecutadas / contract.total_hours_contracted) : 0;
        const valorProduzidoEstimado = percExecucaoFisica * contract.total_value;
        const valorPendenteFaturamento = Math.max(0, valorProduzidoEstimado - totalDespesas); // Assumindo despesa como pago, ajuste conforme necessidade real

        res.json({
            obra,
            contract,
            financeiro: {
                total_contrato: contract.total_value,
                total_despesas: totalDespesas,
                categorias: expensesCategory,
                valor_produzido: valorProduzidoEstimado,
                pendente_faturamento: valorPendenteFaturamento
            },
            producao: {
                media_diaria_atual: mediaDiariaObra, // Média do canteiro (ritmo)
                dias_analisados: recentActivity.length,
                saldo_horas: contract.total_hours_contracted - horasExecutadas
            },
            veiculos: machinePredictions,
            burnup: recentActivity // Para gráfico
        });

    } catch (error) {
        console.error('Erro Detalhes Supervisor:', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.' });
    }
};

// 3. ATUALIZAR PRÓXIMA ALOCAÇÃO (Desmobilização)
exports.updateVehicleNextMission = async (req, res) => {
    const { vehicle_id, next_location, release_date } = req.body;
    try {
        // Buscar assignment atual para não perder dados
        const [v] = await db.query('SELECT operationalAssignment FROM vehicles WHERE id = ?', [vehicle_id]);
        let currentAssignment = v[0]?.operationalAssignment || {};
        
        if (typeof currentAssignment === 'string') currentAssignment = JSON.parse(currentAssignment);
        if (!currentAssignment) currentAssignment = {};

        // Atualiza a chave next_mission
        currentAssignment.next_mission = {
            location: next_location,
            release_date: release_date,
            updated_at: new Date()
        };

        await db.query('UPDATE vehicles SET operationalAssignment = ? WHERE id = ?', [JSON.stringify(currentAssignment), vehicle_id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// Rotas auxiliares (mantidas do original)
exports.addCrmLog = async (req, res) => {
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.userId || null;
    try {
        await db.query(`INSERT INTO obra_crm_logs (obra_id, user_id, interaction_type, notes, agreed_action) VALUES (?, ?, ?, ?, ?)`, [obra_id, user_id, interaction_type, notes, agreed_action]);
        res.json({success: true});
    } catch (e) { res.status(500).json({error: e.message}); }
};

exports.upsertContract = async (req, res) => {
    // Mesma lógica do seu arquivo original para salvar configurações
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome } = req.body;
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;

    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);
        if (existing.length > 0) {
            await db.query(`UPDATE obra_contracts SET total_value = ?, total_hours_contracted = ?, start_date = ?, expected_end_date = ?, fiscal_nome = ?, responsavel_nome = ? WHERE obra_id = ?`, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome, obra_id]);
        } else {
            await db.query(`INSERT INTO obra_contracts (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome, responsavel_nome) VALUES (?, ?, ?, ?, ?, ?, ?)`, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome]);
        }
        res.json({ message: 'Contrato salvo.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
};

function getStatusColor(perc) {
    if (perc >= 90) return 'red';
    if (perc >= 70) return 'violet';
    if (perc >= 30) return 'yellow';
    return 'green';
}