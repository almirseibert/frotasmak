const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

// Soma as horas do JSON legado (ex: {"Rolo": 300, "Caminhao": 200} => 500)
const sumLegacyHours = (jsonInput) => {
    if (!jsonInput) return 0;
    try {
        const data = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
        if (typeof data !== 'object' || data === null) return 0;
        
        // Soma os valores numéricos do objeto
        return Object.values(data).reduce((acc, curr) => {
            const val = parseFloat(curr);
            return acc + (isNaN(val) ? 0 : val);
        }, 0);
    } catch (e) {
        return 0;
    }
};

const addBusinessDays = (startDate, daysToAdd) => {
    // Se não tiver data de referência, usa hoje
    let currentDate = startDate ? new Date(startDate) : new Date();
    
    // Proteção contra loop infinito
    if (daysToAdd > 3000) daysToAdd = 3000; 
    
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

// 1. OBTER DADOS DO DASHBOARD (MACRO)
exports.getDashboardData = async (req, res) => {
    try {
        console.log('[Supervisor] Calculando Dashboard Inteligente (v2)...');

        // 1. Dados Básicos (Obras Ativas)
        const [allObras] = await db.query('SELECT * FROM obras WHERE status = "ativa"');
        
        // 2. Buscas Auxiliares
        let contracts = [];
        try {
            const [resContracts] = await db.query('SELECT * FROM obra_contracts');
            contracts = resContracts || [];
        } catch (e) { console.warn('Aviso: Tabela obra_contracts vazia ou inexistente.'); }
        
        let expenses = [];
        try {
            const [resExpenses] = await db.query(`SELECT obraId, SUM(amount) as total FROM expenses GROUP BY obraId`);
            expenses = resExpenses || [];
        } catch (e) { console.warn('Aviso: Erro ao somar expenses.'); }

        let hoursLogs = [];
        try {
            const [resHours] = await db.query(`SELECT obraId, SUM(totalHours) as total FROM daily_work_logs GROUP BY obraId`);
            hoursLogs = resHours || [];
        } catch (e) { console.warn('Aviso: Erro ao somar daily_work_logs.'); }

        let activeMachines = [];
        try {
            const [resMachines] = await db.query(`
                SELECT 
                    obraAtualId as obraId, 
                    COUNT(id) as qtd_maquinas
                FROM vehicles
                WHERE obraAtualId IS NOT NULL
                AND tipo IN ('Caminhão', 'Escavadeira', 'Motoniveladora', 'Retroescavadeira', 'Rolo', 'Trator', 'Pá Carregadeira')
                GROUP BY obraAtualId
            `);
            activeMachines = resMachines || [];
        } catch (e) { console.warn('Aviso: Erro ao contar máquinas.'); }

        // Mapeamento
        const contractMap = {}; contracts.forEach(c => contractMap[c.obra_id] = c);
        const expenseMap = {}; expenses.forEach(e => expenseMap[e.obraId] = e.total);
        const hoursMap = {}; hoursLogs.forEach(h => hoursMap[h.obraId] = h.total);
        const machinesMap = {}; activeMachines.forEach(m => machinesMap[m.obraId] = m.qtd_maquinas);

        const dashboardData = allObras.map(obra => {
            const obraId = String(obra.id);
            const contract = contractMap[obra.id] || {};
            
            // --- CÁLCULO DE HORAS (CORREÇÃO) ---
            // 1. Tenta pegar do contrato novo
            let horasContratadas = parseFloat(contract.total_hours_contracted) || 0;
            
            // 2. Se zerado, tenta somar do JSON legado (tabela obras)
            if (horasContratadas === 0) {
                horasContratadas = sumLegacyHours(obra.horasContratadasPorTipo);
            }

            const valorTotal = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
            const totalGasto = parseFloat(expenseMap[obraId]) || 0;
            const horasExecutadas = parseFloat(hoursMap[obraId]) || 0;

            // Percentuais
            let percFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
            let percHoras = (horasContratadas > 0) ? (horasExecutadas / horasContratadas) * 100 : 0;
            const percConclusao = Math.max(percFinanceiro, percHoras);

            // --- CÁLCULO DE PREVISÃO ---
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';
            let diasRestantes = 0;

            if (horasContratadas > 0) {
                const horasSaldo = horasContratadas - horasExecutadas;
                const maquinasAtivas = machinesMap[obraId] || 0;
                // Se não houver máquinas ativas, assume 1 para evitar divisão por zero (mas reflete lentidão)
                const capacidadeDiaria = (maquinasAtivas > 0 ? maquinasAtivas : 1) * 8; 

                if (horasSaldo > 0) {
                    diasRestantes = Math.ceil(horasSaldo / capacidadeDiaria);
                    // Previsão de fim é a partir de HOJE + Dias Restantes
                    previsaoTermino = addBusinessDays(new Date(), diasRestantes);
                } else {
                    diasRestantes = 0;
                    previsaoTermino = new Date(); // Obra teoricamente acabou
                }

                const dataFimContrato = contract.expected_end_date ? new Date(contract.expected_end_date) : null;
                if (dataFimContrato && previsaoTermino > dataFimContrato) {
                    statusPrazo = 'atrasado';
                } else {
                    statusPrazo = 'no_prazo';
                }
            }

            // --- CORREÇÃO DATA INÍCIO ---
            // Prioriza contrato, fallback para obra.dataInicio
            const dataInicioReal = contract.start_date || obra.dataInicio;

            return {
                id: obraId,
                nome: obra.nome,
                status: obra.status,
                responsavel: contract.responsavel_nome || obra.responsavel || 'A Definir', 
                fiscal_nome: contract.fiscal_nome || obra.fiscal || 'A Definir',
                
                legacy_data: {
                    valor_total: obra.valorTotalContrato,
                    horas_json: obra.horasContratadasPorTipo,
                    data_inicio: obra.dataInicio,
                    responsavel: obra.responsavel,
                    fiscal: obra.fiscal
                },

                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasContratadas, // Agora deve vir preenchido
                    horas_executadas: horasExecutadas,
                    percentual_conclusao: parseFloat(percConclusao.toFixed(1)),
                    dias_restantes_estimados: diasRestantes,
                    maquinas_ativas: machinesMap[obraId] || 0,
                    status_cor: getStatusColor(percConclusao)
                },
                previsao: {
                    data_termino_estimada: previsaoTermino,
                    status: statusPrazo
                },
                data_inicio: dataInicioReal, // Corrigido
                data_fim_contratual: contract.expected_end_date
            };
        });

        // Ordenação
        dashboardData.sort((a, b) => {
            if (!a.previsao.data_termino_estimada) return 1;
            if (!b.previsao.data_termino_estimada) return -1;
            return new Date(a.previsao.data_termino_estimada) - new Date(b.previsao.data_termino_estimada);
        });

        res.json(dashboardData);

    } catch (error) {
        console.error('Erro Dashboard:', error);
        res.status(500).json({ message: 'Erro interno no dashboard.', debug: error.message });
    }
};

function getStatusColor(perc) {
    if (perc >= 90) return 'red';
    if (perc >= 70) return 'violet';
    if (perc >= 30) return 'yellow';
    return 'green';
}

// 2. DETALHES DA OBRA (COCKPIT)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    
    if (!id) return res.status(400).json({message: 'ID da obra inválido.'});

    try {
        // 1. Obra Básica
        let obra = [];
        try {
            const [resObra] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
            obra = resObra || [];
        } catch (e) {
            return res.status(404).json({message: 'Erro ao buscar obra.', debug: e.message});
        }

        if (!obra.length) return res.status(404).json({message: 'Obra não encontrada'});

        // 2. Contrato
        let contractData = {};
        try {
            const [contract] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
            contractData = contract[0] || {};
        } catch (e) { console.warn('Contrato warning:', e.message); }

        // **CÁLCULO TOTAL HORAS CONTRATADAS (CORREÇÃO)**
        // Se não tem no contrato, soma do legado
        if (!contractData.total_hours_contracted) {
            contractData.total_hours_contracted = sumLegacyHours(obra[0].horasContratadasPorTipo);
            // Injeta valor total também se faltar
            if (!contractData.total_value) {
                contractData.total_value = parseFloat(obra[0].valorTotalContrato) || 0;
            }
        }

        // 3. Burnup
        let burnupData = [];
        try {
            const [resBurnup] = await db.query(`
                SELECT DATE(date) as data, SUM(totalHours) as horas_dia 
                FROM daily_work_logs WHERE obraId = ? GROUP BY DATE(date) ORDER BY date ASC
            `, [id]);
            burnupData = resBurnup || [];
        } catch (e) { console.warn('Burnup warning:', e.message); }

        // 4. Veículos Alocados (CORREÇÃO DE SUMIÇO)
        // Simplifiquei a query para confiar mais no `obraAtualId` da tabela vehicles,
        // que é atualizada quando o veículo é alocado. O LEFT JOIN com `vehicle_operational_assignment`
        // agora é usado apenas para tentar pegar metadados (operador, data), mas não filtra o veículo.
        let vehicles = [];
        try {
            const [resVehicles] = await db.query(`
                SELECT 
                    v.id, 
                    v.placa, 
                    v.modelo, 
                    v.tipo, 
                    -- Tenta pegar data de alocação do histórico ativo, senão usa data atual ou nula
                    COALESCE(voa.startDate, NOW()) as data_alocacao,
                    -- Tenta pegar operador, senão ---
                    COALESCE(e.name, '---') as operador_nome,
                    -- Substituição
                    COALESCE(ces.fator_conversao, 1.00) as fator_conversao,
                    ces.grupo_contratado
                FROM vehicles v
                -- Join flexível para pegar dados operacionais APENAS se existirem e estiverem ativos
                LEFT JOIN vehicle_operational_assignment voa 
                    ON v.id = voa.vehicleId 
                    AND voa.obraId = ? 
                    AND (voa.endDate IS NULL OR voa.endDate > NOW())
                LEFT JOIN employees e ON voa.employeeId = e.id
                LEFT JOIN contract_equipment_substitutions ces 
                    ON ces.veiculo_real_id = v.id 
                    AND ces.obra_contract_id = ?
                WHERE v.obraAtualId = ?
            `, [id, contractData.id || 0, id]);
            vehicles = resVehicles || [];
        } catch (e) {
            console.warn('Erro SQL Veiculos:', e.message);
            // Fallback extremo: Pega só da tabela vehicles
            try {
                const [vSimple] = await db.query(`SELECT id, placa, modelo, tipo FROM vehicles WHERE obraAtualId = ?`, [id]);
                vehicles = vSimple ? vSimple.map(v => ({...v, operador_nome: '---', data_alocacao: new Date(), fator_conversao: 1.0})) : [];
            } catch (err2) { vehicles = []; }
        }

        // 5. CRM
        let crmLogs = [];
        try {
            const [resCrm] = await db.query(`
                SELECT l.*, u.username as supervisor_name 
                FROM obra_crm_logs l
                LEFT JOIN users u ON l.user_id = u.id
                WHERE l.obra_id = ? ORDER BY l.created_at DESC
            `, [id]);
            crmLogs = resCrm || [];
        } catch (e) { crmLogs = []; }

        // 6. KPI
        let kpi = { horas_executadas: 0, total_gasto: 0 };
        try {
            const [expenses] = await db.query('SELECT SUM(amount) as total FROM expenses WHERE obraId = ?', [id]);
            const [hours] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [id]);
            
            kpi = {
                horas_executadas: parseFloat(hours[0]?.total) || 0,
                total_gasto: parseFloat(expenses[0]?.total) || 0,
                // Passa também o contratado calculado para o frontend usar no cálculo de saldo
                horas_contratadas: contractData.total_hours_contracted || 0
            };
        } catch (e) { }

        res.json({
            obra: { ...obra[0], kpi }, 
            contract: contractData, 
            burnup: burnupData || [], 
            vehicles: vehicles || [], 
            crm_history: crmLogs || [], 
            employees: []
        });

    } catch (error) {
        console.error('Erro Critical Detalhes:', error);
        res.status(500).json({message: 'Erro crítico ao carregar detalhes.', debug: error.message});
    }
};

exports.addCrmLog = async (req, res) => {
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.userId || null;
    try {
        await db.query(`INSERT INTO obra_crm_logs (obra_id, user_id, interaction_type, notes, agreed_action) VALUES (?, ?, ?, ?, ?)`, [obra_id, user_id, interaction_type, notes, agreed_action]);
        res.json({success: true});
    } catch (e) { 
        res.status(500).json({error: e.message}); 
    }
};

exports.upsertContract = async (req, res) => {
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome } = req.body;
    
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;
    if (!fiscal_nome) fiscal_nome = null;
    if (!responsavel_nome) responsavel_nome = null;

    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);
        
        if (existing.length > 0) {
            await db.query(`
                UPDATE obra_contracts 
                SET total_value = ?, total_hours_contracted = ?, start_date = ?, expected_end_date = ?, fiscal_nome = ?, responsavel_nome = ? 
                WHERE obra_id = ?
            `, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome, obra_id]);
        } else {
            await db.query(`
                INSERT INTO obra_contracts 
                (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome, responsavel_nome) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome]);
        }
        res.json({ message: 'Contrato salvo com sucesso.' });
    } catch (error) {
        console.error("Erro ao salvar contrato:", error);
        res.status(500).json({ message: `Erro ao salvar contrato: ${error.message}` });
    }
};