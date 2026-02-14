const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

// Função para calcular dias úteis
const addBusinessDays = (startDate, daysToAdd) => {
    if (!startDate) return new Date();
    let count = 0;
    let currentDate = new Date(startDate);
    while (count < daysToAdd) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = Domingo, 6 = Sábado
            count++;
        }
    }
    return currentDate;
};

// ==================================================================================
// CONTROLADORES
// ==================================================================================

// 1. OBTER DADOS DO DASHBOARD (MACRO - MODO TV)
exports.getDashboardData = async (req, res) => {
    try {
        console.log('[Supervisor] Iniciando busca de dados do dashboard (Modo Seguro)...');

        // 1. Buscar Obras (Query Simples)
        const [allObras] = await db.query('SELECT * FROM obras');
        
        // Filtragem (Blacklist) - Mostra tudo exceto Inativas/Concluídas
        const obrasAtivas = allObras.filter(o => {
            if (o.status === undefined || o.status === null) return true; 
            const s = String(o.status).toLowerCase().trim();
            const statusInativos = ['inativa', 'inactive', 'concluída', 'concluida', 'finalizada', 'cancelada', 'arquivada'];
            return !statusInativos.includes(s);
        });

        // 2. Buscar Contratos (Protegido contra falhas)
        let contracts = [];
        try {
            const [resContracts] = await db.query('SELECT * FROM obra_contracts');
            contracts = resContracts;
        } catch (e) {
            console.error('[Supervisor WARN] Erro ao buscar obra_contracts:', e.message);
        }

        // 3. Buscar Totais de Despesas
        let expensesMap = {};
        try {
            const [resExpenses] = await db.query('SELECT obra_id, SUM(total_value) as total FROM expenses GROUP BY obra_id');
            resExpenses.forEach(r => expensesMap[r.obra_id] = r.total);
        } catch (e) { /* Ignora erro se tabela não existir */ }

        // 4. Buscar Totais de Horas
        let hoursMap = {};
        try {
            const [resHours] = await db.query('SELECT obra_id, SUM(horas_trabalhadas) as total FROM daily_work_logs GROUP BY obra_id');
            resHours.forEach(r => hoursMap[r.obra_id] = r.total);
        } catch (e) { /* Ignora erro se tabela não existir */ }

        // 5. Montagem dos Dados
        const dashboardData = obrasAtivas.map(obra => {
            const obraIdStr = String(obra.id);
            // Procura contrato convertendo ambos IDs para string
            const contract = contracts.find(c => String(c.obra_id) === obraIdStr) || {};
            
            // Sanitização de valores
            const valorTotal = parseFloat(contract.total_value) || 0;
            const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
            const totalGasto = parseFloat(expensesMap[obraIdStr] || expensesMap[obra.id]) || 0;
            const horasRealizadas = parseFloat(hoursMap[obraIdStr] || hoursMap[obra.id]) || 0;

            // Cálculos
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
                const horasRestantes = horasTotais - horasRealizadas;

                if (horasPorDia > 0 && horasRestantes > 0) {
                    const diasRestantesEstimados = Math.ceil(horasRestantes / horasPorDia);
                    previsaoTermino = addBusinessDays(new Date(), diasRestantesEstimados);
                }
            }
            if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

            return {
                id: String(obra.id), // Garante retorno como String
                nome: obra.nome,
                responsavel: contract.fiscal_nome || 'Não Definido', 
                fiscal_nome: contract.fiscal_nome,
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    saldo_financeiro: valorTotal - totalGasto,
                    horas_contratadas: horasTotais,
                    horas_realizadas: horasRealizadas,
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
        console.error('============ ERRO FATAL NO DASHBOARD ============', error);
        res.status(500).json({ message: 'Erro interno ao carregar dashboard.', debug_error: error.message });
    }
};

// 2. OBTER DETALHES DA OBRA (COCKPIT) - REFORMULADO
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    console.log(`[Supervisor] Buscando detalhes para Obra ID: ${id}`);
    
    try {
        // 1. Busca Dados da Obra (Tabela Principal)
        const [obraInfo] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        
        if (!obraInfo || obraInfo.length === 0) {
            return res.status(404).json({ message: 'Obra não encontrada.' });
        }
        
        const obra = obraInfo[0];
        const obraIdStr = String(obra.id); // Garante string

        // 2. Busca Contrato
        let contract = {};
        try {
            const [c] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
            if (c.length > 0) contract = c[0];
        } catch (e) { console.warn('[Supervisor] Contrato não encontrado/erro:', e.message); }

        // 3. Busca Totais Financeiros e Horas (Independente do Dashboard)
        let totalGasto = 0;
        let horasRealizadas = 0;
        try {
            const [exp] = await db.query('SELECT SUM(total_value) as total FROM expenses WHERE obra_id = ?', [id]);
            totalGasto = parseFloat(exp[0].total) || 0;
            
            const [hrs] = await db.query('SELECT SUM(horas_trabalhadas) as total FROM daily_work_logs WHERE obra_id = ?', [id]);
            horasRealizadas = parseFloat(hrs[0].total) || 0;
        } catch (e) { console.warn('[Supervisor] Erro ao somar totais:', e.message); }

        // 4. Cálculos KPI (Mesma lógica do Dashboard)
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
            const hoje = new Date();
            const diffTime = Math.abs(hoje - dataInicio);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
            const horasPorDia = horasRealizadas / diffDays;
            
            if (horasPorDia > 0 && (horasTotais - horasRealizadas) > 0) {
                const diasRestantes = Math.ceil((horasTotais - horasRealizadas) / horasPorDia);
                previsaoTermino = addBusinessDays(new Date(), diasRestantes);
            }
        }
        if (previsaoTermino && dataFim) statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';

        // Objeto Completo da Obra (substitui a necessidade de buscar no dashboard)
        const macroData = {
            id: String(obra.id),
            nome: obra.nome,
            status: obra.status,
            responsavel: contract.fiscal_nome || 'Não Definido', 
            fiscal_nome: contract.fiscal_nome,
            kpi: {
                valor_total_contrato: valorTotal,
                total_gasto: totalGasto,
                saldo_financeiro: valorTotal - totalGasto,
                horas_contratadas: horasTotais,
                horas_realizadas: horasRealizadas,
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

        // 5. Veículos
        let vehicles = [];
        try {
            const [veh] = await db.query(`
                SELECT v.id, v.plate, v.model, v.type 
                FROM vehicles v
                WHERE v.current_location_id = ? 
            `, [id]);
            vehicles = veh;
        } catch (vErr) { console.warn('[Supervisor] Veículos não carregados:', vErr.sqlMessage); }

        // 6. Logs CRM
        let crmLogs = [];
        try {
            const [logs] = await db.query(`
                SELECT * FROM obra_crm_logs 
                WHERE obra_id = ? 
                ORDER BY created_at DESC LIMIT 50
            `, [id]);
            crmLogs = logs;
        } catch (crmErr) { console.warn('[Supervisor] CRM não carregado:', crmErr.sqlMessage); }

        // Retorna tudo unificado
        res.json({
            obra: macroData,
            vehicles: vehicles,
            crm_history: crmLogs
        });

    } catch (error) {
        console.error('============ ERRO CRÍTICO NO DETALHE ============', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.', debug: error.message });
    }
};

// 3. REGISTRAR CRM
exports.addCrmLog = async (req, res) => {
    const { obra_id, tipo_interacao, resumo_conversa, data_proximo_contato } = req.body;
    const supervisor_id = req.user?.userId || null;
    const supervisor_name = req.user?.username || 'Supervisor'; 

    try {
        await db.query(`
            INSERT INTO obra_crm_logs 
            (obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato]);

        res.status(201).json({ message: 'Registro salvo com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar CRM:', error);
        res.status(500).json({ message: 'Erro ao salvar registro.', debug: error.sqlMessage });
    }
};

// 4. CONFIGURAR CONTRATO
exports.upsertContract = async (req, res) => {
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome } = req.body;
    
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
                INSERT INTO obra_contracts (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome]);
        }

        res.json({ message: 'Contrato configurado com sucesso.' });
    } catch (error) {
        console.error('Erro ao configurar contrato:', error);
        res.status(500).json({ message: 'Erro ao salvar configurações.', debug: error.sqlMessage });
    }
};