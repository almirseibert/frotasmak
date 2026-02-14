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
        
        // LOG DE DIAGNÓSTICO (Para ver no console o que está vindo do banco)
        if (allObras.length > 0) {
            console.log('[Supervisor Debug] Status encontrados:', allObras.map(o => `${o.id}: ${o.status}`).join(', '));
        } else {
            console.log('[Supervisor Debug] Nenhuma obra encontrada na tabela obras.');
        }

        // 2. Filtragem em Memória (Lógica BLACKLIST - Mais permissiva)
        // Mostra tudo, EXCETO o que for explicitamente inativo/concluído
        const obrasAtivas = allObras.filter(o => {
            // Se não tiver coluna status ou for nula, assume que é ativa (para aparecer na tela)
            if (o.status === undefined || o.status === null) return true; 
            
            // Normaliza para comparar (remove espaços e põe em minúsculas)
            const s = String(o.status).toLowerCase().trim();
            
            // Define o que NÃO queremos mostrar
            const statusInativos = ['inativa', 'inactive', 'concluída', 'concluida', 'finalizada', 'cancelada', 'arquivada'];
            
            // Retorna true se NÃO estiver na lista de inativos
            return !statusInativos.includes(s);
        });

        console.log(`[Supervisor] Obras carregadas: ${allObras.length} total, ${obrasAtivas.length} consideradas ativas.`);

        // 3. Buscar Contratos (Separado para não quebrar se a tabela faltar)
        let contracts = [];
        try {
            const [resContracts] = await db.query('SELECT * FROM obra_contracts');
            contracts = resContracts;
        } catch (e) {
            console.error('[Supervisor WARN] Tabela obra_contracts não encontrada ou erro:', e.message);
        }

        // 4. Buscar Totais de Despesas (Expenses)
        let expensesMap = {};
        try {
            const [resExpenses] = await db.query('SELECT obra_id, SUM(total_value) as total FROM expenses GROUP BY obra_id');
            resExpenses.forEach(r => expensesMap[r.obra_id] = r.total);
        } catch (e) {
            console.warn('[Supervisor WARN] Erro ao buscar expenses:', e.message);
        }

        // 5. Buscar Totais de Horas (Daily Work Logs)
        let hoursMap = {};
        try {
            const [resHours] = await db.query('SELECT obra_id, SUM(horas_trabalhadas) as total FROM daily_work_logs GROUP BY obra_id');
            resHours.forEach(r => hoursMap[r.obra_id] = r.total);
        } catch (e) {
            console.warn('[Supervisor WARN] Erro ao buscar daily_work_logs:', e.message);
        }

        // 6. Montagem dos Dados
        const dashboardData = obrasAtivas.map(obra => {
            const contract = contracts.find(c => c.obra_id === obra.id) || {};
            
            // Sanitização de valores
            const valorTotal = parseFloat(contract.total_value) || 0;
            const horasTotais = parseFloat(contract.total_hours_contracted) || 0;
            const totalGasto = parseFloat(expensesMap[obra.id]) || 0;
            const horasRealizadas = parseFloat(hoursMap[obra.id]) || 0;

            // Cálculos de Percentual
            let percentualFinanceiro = 0;
            if (valorTotal > 0) percentualFinanceiro = (totalGasto / valorTotal) * 100;

            let percentualHoras = 0;
            if (horasTotais > 0) percentualHoras = (horasRealizadas / horasTotais) * 100;

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

            if (previsaoTermino && dataFim) {
                statusPrazo = previsaoTermino > dataFim ? 'atrasado' : 'no_prazo';
            }

            return {
                id: obra.id,
                nome: obra.nome,
                status_original: obra.status, // Útil para debug no front se precisar
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
        console.error('============ ERRO FATAL NO DASHBOARD ============');
        console.error('Mensagem:', error.message);
        console.error('=================================================');
        
        res.status(500).json({ 
            message: 'Erro interno ao carregar dashboard.',
            debug_error: error.message 
        });
    }
};

// 2. OBTER DETALHES DA OBRA (COCKPIT)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const [vehicles] = await db.query(`
            SELECT v.id, v.plate, v.model, v.type 
            FROM vehicles v
            WHERE v.current_location_id = ? AND v.status = 'active'
        `, [id]);

        const [crmLogs] = await db.query(`
            SELECT * FROM obra_crm_logs 
            WHERE obra_id = ? 
            ORDER BY created_at DESC 
            LIMIT 50
        `, [id]);

        res.json({
            vehicles: vehicles,
            crm_history: crmLogs
        });
    } catch (error) {
        console.error('Erro ao buscar detalhes da obra:', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.' });
    }
};

// 3. REGISTRAR CRM
exports.addCrmLog = async (req, res) => {
    const { obra_id, tipo_interacao, resumo_conversa, data_proximo_contato } = req.body;
    const supervisor_id = req.user.userId;
    const supervisor_name = req.user.username || 'Supervisor'; 

    try {
        await db.query(`
            INSERT INTO obra_crm_logs 
            (obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [obra_id, supervisor_id, supervisor_name, tipo_interacao, resumo_conversa, data_proximo_contato]);

        res.status(201).json({ message: 'Registro salvo com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar CRM:', error);
        res.status(500).json({ message: 'Erro ao salvar registro.' });
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
        res.status(500).json({ message: 'Erro ao salvar configurações do contrato.', debug: error.message });
    }
};