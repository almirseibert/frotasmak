const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

const addBusinessDays = (startDate, daysToAdd) => {
    if (!startDate) return new Date();
    let count = 0;
    let currentDate = new Date(startDate);
    // Proteção contra loop infinito em datas muito distantes
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

        // 1. Dados Básicos
        // Busca apenas obras ativas para o dashboard principal
        const [allObras] = await db.query('SELECT * FROM obras WHERE status = "ativa"');
        const [contracts] = await db.query('SELECT * FROM obra_contracts');
        
        // 2. Agregações Financeiras e de Horas (Faturamento)
        const [expenses] = await db.query(`
            SELECT obraId, SUM(amount) as total 
            FROM expenses 
            GROUP BY obraId
        `); 

        const [hoursLogs] = await db.query(`
            SELECT obraId, SUM(totalHours) as total 
            FROM daily_work_logs 
            GROUP BY obraId
        `);

        // 3. Contagem de Máquinas Ativas (Correção: Busca na tabela vehicles)
        // Consideramos "Pesados" para o cálculo: Caminhão, Escavadeira, Motoniveladora, Retroescavadeira, Rolo, Trator
        const [activeMachines] = await db.query(`
            SELECT 
                obraAtualId as obraId, 
                COUNT(id) as qtd_maquinas
            FROM vehicles
            WHERE obraAtualId IS NOT NULL
            AND tipo IN ('Caminhão', 'Escavadeira', 'Motoniveladora', 'Retroescavadeira', 'Rolo', 'Trator', 'Pá Carregadeira')
            GROUP BY obraAtualId
        `);

        // Mapeamento para acesso rápido
        const contractMap = {}; contracts.forEach(c => contractMap[c.obra_id] = c);
        const expenseMap = {}; expenses.forEach(e => expenseMap[e.obraId] = e.total);
        const hoursMap = {}; hoursLogs.forEach(h => hoursMap[h.obraId] = h.total);
        const machinesMap = {}; activeMachines.forEach(m => machinesMap[m.obraId] = m.qtd_maquinas);

        const dashboardData = allObras.map(obra => {
            const obraId = String(obra.id);
            const contract = contractMap[obra.id] || {};
            
            // Valores (Fallback para dados da obra se contrato não existir)
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
                
                // Capacidade diária: 8h por máquina (padrão solicitado)
                // Se não tiver máquina ativa, assumimos 1 para não travar o cálculo (divisão por zero)
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

            return {
                id: obraId,
                nome: obra.nome,
                status: obra.status,
                responsavel: contract.fiscal_nome || obra.responsavel || 'A Definir',
                fiscal_nome: contract.fiscal_nome || obra.fiscal || 'A Definir',
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

        // Ordenação Inteligente: Prioridade para quem termina antes
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

        const [contract] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
        const contractData = contract[0] || {};

        // Burnup Chart Data
        const [burnupData] = await db.query(`
            SELECT 
                DATE(date) as data, 
                SUM(totalHours) as horas_dia 
            FROM daily_work_logs 
            WHERE obraId = ? 
            GROUP BY DATE(date) 
            ORDER BY date ASC
        `, [id]);

        // Veículos Alocados (Correção SQL)
        // Busca veículos na tabela vehicles (obraAtualId), cruza com histórico para data e voa para operador
        const [vehicles] = await db.query(`
            SELECT 
                v.id, v.placa, v.modelo, v.tipo, 
                ohv.dataEntrada as data_alocacao,
                COALESCE(voa.employeeName, '---') as operador_nome,
                ces.fator_conversao,
                ces.grupo_contratado
            FROM vehicles v
            LEFT JOIN obras_historico_veiculos ohv ON v.id = ohv.veiculoId AND ohv.dataSaida IS NULL AND ohv.obraId = ?
            LEFT JOIN vehicle_operational_assignment voa ON v.id = voa.vehicleId
            LEFT JOIN contract_equipment_substitutions ces ON ces.veiculo_real_id = v.id AND ces.obra_contract_id = ?
            WHERE v.obraAtualId = ?
        `, [id, contractData.id || 0, id]);

        // Histórico CRM
        const [crmLogs] = await db.query(`
            SELECT * FROM obra_crm_logs 
            WHERE obra_id = ? 
            ORDER BY created_at DESC
        `, [id]);

        // Recalcular KPIs unitários para esta obra (sincronia com dashboard)
        const [expenses] = await db.query('SELECT SUM(amount) as total FROM expenses WHERE obraId = ?', [id]);
        const [hours] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [id]);
        
        const kpi = {
            horas_executadas: parseFloat(hours[0].total) || 0,
            total_gasto: parseFloat(expenses[0].total) || 0
        };

        res.json({
            obra: { ...obra[0], kpi }, // Injeta KPI atualizado no objeto obra
            contract: contractData,
            burnup: burnupData,
            vehicles: vehicles,
            crm: crmLogs
        });

    } catch (error) {
        console.error('Erro Detalhes:', error);
        res.status(500).json({message: 'Erro ao carregar detalhes da obra', debug: error.message});
    }
};

// 3. REGISTRAR CRM
exports.addCrmLog = async (req, res) => {
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.userId; 

    try {
        await db.query(`
            INSERT INTO obra_crm_logs 
            (obra_id, user_id, interaction_type, notes, agreed_action)
            VALUES (?, ?, ?, ?, ?)
        `, [obra_id, user_id, interaction_type, notes, agreed_action]);
        
        res.json({success: true});
    } catch (e) {
        console.error('Erro CRM:', e);
        res.status(500).json({error: e.message});
    }
};

// 4. SALVAR/ATUALIZAR CONTRATO
exports.upsertContract = async (req, res) => {
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome } = req.body;
    
    // Tratamento de nulos
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;
    if (!fiscal_nome) fiscal_nome = null;

    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);
        
        if (existing.length > 0) {
            await db.query(`
                UPDATE obra_contracts 
                SET total_value = ?, total_hours_contracted = ?, start_date = ?, expected_end_date = ?, fiscal_nome = ? 
                WHERE obra_id = ?
            `, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, obra_id]);
        } else {
            await db.query(`
                INSERT INTO obra_contracts 
                (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome) 
                VALUES (?, ?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome]);
        }
        
        res.json({ message: 'Contrato salvo com sucesso.' });
    } catch (error) {
        console.error("Erro ao salvar contrato:", error);
        res.status(500).json({ message: 'Erro ao salvar contrato.' });
    }
};