const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

const addBusinessDays = (startDate, daysToAdd) => {
    if (!startDate) return new Date();
    let count = 0;
    let currentDate = new Date(startDate);
    // Proteção contra loop infinito
    if (daysToAdd > 3000) daysToAdd = 3000; 
    
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
            
            // Valores (Prioridade: Contrato > Obra Legado > 0)
            const valorTotal = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
            const horasContratadas = parseFloat(contract.total_hours_contracted) || 0; // Nota: Se não tiver contrato, será calculado no front ou deve ser somado aqui?
            // O Front fará a lógica de preenchimento inicial, aqui enviamos o que temos oficializado.
            
            const totalGasto = parseFloat(expenseMap[obraId]) || 0;
            const horasExecutadas = parseFloat(hoursMap[obraId]) || 0;

            // Percentuais
            let percFinanceiro = (valorTotal > 0) ? (totalGasto / valorTotal) * 100 : 0;
            let percHoras = (horasContratadas > 0) ? (horasExecutadas / horasContratadas) * 100 : 0;
            const percConclusao = Math.max(percFinanceiro, percHoras);

            // Previsão
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';
            let diasRestantes = 0;

            if (horasContratadas > 0) {
                const horasSaldo = horasContratadas - horasExecutadas;
                const maquinasAtivas = machinesMap[obraId] || 0;
                const capacidadeDiaria = (maquinasAtivas > 0 ? maquinasAtivas : 1) * 8; 

                if (horasSaldo > 0) {
                    diasRestantes = Math.ceil(horasSaldo / capacidadeDiaria);
                    previsaoTermino = addBusinessDays(new Date(), diasRestantes);
                } else {
                    diasRestantes = 0;
                    previsaoTermino = new Date(); 
                }

                const dataFimContrato = contract.expected_end_date ? new Date(contract.expected_end_date) : null;
                if (dataFimContrato && previsaoTermino > dataFimContrato) {
                    statusPrazo = 'atrasado';
                } else {
                    statusPrazo = 'no_prazo';
                }
            }

            return {
                id: obraId,
                nome: obra.nome,
                status: obra.status,
                // Prioridade: Contrato > Obra > Padrão
                responsavel: contract.responsavel_nome || obra.responsavel || 'A Definir', 
                fiscal_nome: contract.fiscal_nome || obra.fiscal || 'A Definir',
                
                // Dados Brutos para Configuração (Legacy Fallback)
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
                    horas_contratadas: horasContratadas,
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
                data_inicio: contract.start_date || obra.dataInicio,
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
    // ... (Mantém o código existente da última versão correta)
    const { id } = req.params;
    if (!id) return res.status(400).json({message: 'ID da obra inválido.'});

    try {
        let obra = [];
        try {
            const [resObra] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
            obra = resObra || [];
        } catch (e) { return res.status(404).json({message: 'Erro ao buscar obra.', debug: e.message}); }

        if (!obra.length) return res.status(404).json({message: 'Obra não encontrada'});

        let contractData = {};
        try {
            const [contract] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
            contractData = contract[0] || {};
        } catch (e) { console.warn('Contrato warning:', e.message); }

        let burnupData = [];
        try {
            const [resBurnup] = await db.query(`SELECT DATE(date) as data, SUM(totalHours) as horas_dia FROM daily_work_logs WHERE obraId = ? GROUP BY DATE(date) ORDER BY date ASC`, [id]);
            burnupData = resBurnup || [];
        } catch (e) { console.warn('Burnup warning:', e.message); }

        let vehicles = [];
        try {
            const [resVehicles] = await db.query(`SELECT v.id, v.placa, v.modelo, v.tipo, voa.startDate as data_alocacao, COALESCE(e.name, '---') as operador_nome, ces.fator_conversao, ces.grupo_contratado FROM vehicles v LEFT JOIN vehicle_operational_assignment voa ON v.id = voa.vehicleId AND voa.obraId = ? AND (voa.endDate IS NULL OR voa.endDate > NOW()) LEFT JOIN employees e ON voa.employeeId = e.id LEFT JOIN contract_equipment_substitutions ces ON ces.veiculo_real_id = v.id AND ces.obra_contract_id = ? WHERE v.obraAtualId = ?`, [id, contractData.id || 0, id]);
            vehicles = resVehicles || [];
        } catch (e) { vehicles = []; }

        let crmLogs = [];
        try {
            const [resCrm] = await db.query(`SELECT l.*, u.username as supervisor_name FROM obra_crm_logs l LEFT JOIN users u ON l.user_id = u.id WHERE l.obra_id = ? ORDER BY l.created_at DESC`, [id]);
            crmLogs = resCrm || [];
        } catch (e) { crmLogs = []; }

        let kpi = { horas_executadas: 0, total_gasto: 0 };
        try {
            const [expenses] = await db.query('SELECT SUM(amount) as total FROM expenses WHERE obraId = ?', [id]);
            const [hours] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [id]);
            kpi = { horas_executadas: parseFloat(hours[0]?.total) || 0, total_gasto: parseFloat(expenses[0]?.total) || 0 };
        } catch (e) { }

        res.json({
            obra: { ...obra[0], kpi }, contract: contractData, burnup: burnupData || [], vehicles: vehicles || [], crm_history: crmLogs || [], employees: []
        });
    } catch (error) { res.status(500).json({message: 'Erro crítico.', debug: error.message}); }
};

exports.addCrmLog = async (req, res) => {
    // ... (Mantém o código existente)
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.userId || null;
    try {
        await db.query(`INSERT INTO obra_crm_logs (obra_id, user_id, interaction_type, notes, agreed_action) VALUES (?, ?, ?, ?, ?)`, [obra_id, user_id, interaction_type, notes, agreed_action]);
        res.json({success: true});
    } catch (e) { res.status(500).json({error: e.message}); }
};

// 4. SALVAR/ATUALIZAR CONTRATO
exports.upsertContract = async (req, res) => {
    // ADICIONADO: responsavel_nome
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome } = req.body;
    
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;
    if (!fiscal_nome) fiscal_nome = null;
    if (!responsavel_nome) responsavel_nome = null;

    try {
        // Verifica se a coluna responsavel_nome existe na tabela, se não, ignora ou tenta
        // O ideal é rodar o script SQL abaixo para garantir
        
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