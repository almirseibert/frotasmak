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
        console.log('[Supervisor] Iniciando busca de dados do dashboard...');

        // Query principal com tratamento de nulos via COALESCE
        // NOTA: Se der erro aqui, verifique se as colunas 'fiscal_nome' existem na tabela 'obra_contracts'
        const query = `
            SELECT 
                o.id, 
                o.nome,
                oc.total_value as valor_total_contrato, 
                oc.total_hours_contracted as horas_totais_contratadas,
                oc.start_date as data_inicio_contratual,
                oc.expected_end_date as data_fim_contratual,
                oc.fiscal_nome,
                (SELECT COALESCE(SUM(total_value), 0) FROM expenses WHERE obra_id = o.id) as total_gasto,
                (SELECT COALESCE(SUM(horas_trabalhadas), 0) FROM daily_work_logs WHERE obra_id = o.id) as total_horas_realizadas
            FROM obras o
            LEFT JOIN obra_contracts oc ON o.id = oc.obra_id
            WHERE o.status = 'Ativa'
        `;

        const [obras] = await db.query(query);

        console.log(`[Supervisor] Encontradas ${obras.length} obras ativas.`);

        const dashboardData = obras.map(obra => {
            // Sanitização de valores para evitar NaN ou null
            const valorTotal = parseFloat(obra.valor_total_contrato) || 0;
            const totalGasto = parseFloat(obra.total_gasto) || 0;
            const horasTotais = parseFloat(obra.horas_totais_contratadas) || 0;
            const horasRealizadas = parseFloat(obra.total_horas_realizadas) || 0;

            // Cálculos de Percentual (Evita divisão por zero)
            let percentualFinanceiro = 0;
            if (valorTotal > 0) {
                percentualFinanceiro = (totalGasto / valorTotal) * 100;
            }

            let percentualHoras = 0;
            if (horasTotais > 0) {
                percentualHoras = (horasRealizadas / horasTotais) * 100;
            }

            // Define o percentual mestre (o maior entre financeiro e horas é o risco)
            const percentualConclusao = Math.max(percentualFinanceiro, percentualHoras);

            // Previsão Inteligente
            let previsaoTermino = null;
            let statusPrazo = 'indefinido';

            // Só calcula previsão se houver horas realizadas e contrato configurado
            if (horasRealizadas > 0 && horasTotais > 0 && obra.data_inicio_contratual) {
                // Média simples: horas por dia desde o início
                const dataInicio = new Date(obra.data_inicio_contratual);
                const hoje = new Date();
                const diffTime = Math.abs(hoje - dataInicio);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1; // Evita zero dias
                
                const horasPorDia = horasRealizadas / diffDays;
                const horasRestantes = horasTotais - horasRealizadas;

                if (horasPorDia > 0 && horasRestantes > 0) {
                    const diasRestantesEstimados = Math.ceil(horasRestantes / horasPorDia);
                    previsaoTermino = addBusinessDays(new Date(), diasRestantesEstimados);
                }
            }

            // Verifica atraso
            if (previsaoTermino && obra.data_fim_contratual) {
                const fimContrato = new Date(obra.data_fim_contratual);
                statusPrazo = previsaoTermino > fimContrato ? 'atrasado' : 'no_prazo';
            }

            return {
                id: obra.id,
                nome: obra.nome,
                responsavel: obra.fiscal_nome || 'Não Definido', // Fallback se null
                fiscal_nome: obra.fiscal_nome,
                kpi: {
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    saldo_financeiro: valorTotal - totalGasto,
                    horas_contratadas: horasTotais,
                    horas_realizadas: horasRealizadas,
                    saldo_horas: horasTotais - horasRealizadas,
                    percentual_conclusao: parseFloat(percentualConclusao.toFixed(1)), // 1 casa decimal
                    alertas_assinatura: 0 // Placeholder para futuro
                },
                previsao: {
                    data_termino_estimada: previsaoTermino,
                    status: statusPrazo
                },
                data_inicio_contratual: obra.data_inicio_contratual,
                data_fim_contratual: obra.data_fim_contratual
            };
        });

        res.json(dashboardData);

    } catch (error) {
        // LOG CRÍTICO PARA O EASYPANEL
        console.error('============ ERRO NO DASHBOARD SUPERVISOR ============');
        console.error('Mensagem:', error.message);
        console.error('SQL State:', error.sqlState);
        console.error('SQL Message:', error.sqlMessage); // Aqui vai dizer qual coluna falta
        console.error('======================================================');
        
        res.status(500).json({ 
            message: 'Erro interno ao carregar dashboard.',
            debug_error: error.sqlMessage || error.message // Envia erro pro front em dev
        });
    }
};

// 2. OBTER DETALHES DA OBRA (COCKPIT)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        // Busca veículos alocados na obra (Logíca baseada em vehicle_operational_assignment ou histórico recente)
        // Adaptar conforme sua regra de alocação atual. Aqui busco assignments ativos.
        const [vehicles] = await db.query(`
            SELECT v.id, v.plate, v.model, v.type 
            FROM vehicles v
            WHERE v.current_location_id = ? AND v.status = 'active'
        `, [id]);

        // Busca histórico de CRM
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

// 3. REGISTRAR CRM (DIÁRIO DE OBRA/CONTATO)
exports.addCrmLog = async (req, res) => {
    const { obra_id, tipo_interacao, resumo_conversa, data_proximo_contato } = req.body;
    const supervisor_id = req.user.userId; // Do authMiddleware
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

// 4. CONFIGURAR CONTRATO (UPSERT)
exports.upsertContract = async (req, res) => {
    // Sanitização básica
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome } = req.body;
    
    // Converte strings vazias para null para evitar erro de data inválida no MySQL
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