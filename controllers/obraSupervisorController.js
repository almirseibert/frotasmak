const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES (CÁLCULOS MATEMÁTICOS)
// ==================================================================================

// Função para calcular dias úteis (Segunda a Sexta) a adicionar
const addBusinessDays = (startDate, daysToAdd) => {
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
        // Busca obras ativas e seus contratos
        const [obras] = await db.query(`
            SELECT 
                o.id, o.nome, o.responsavel,
                oc.fiscal_nome, oc.valor_total_contrato, oc.horas_totais_contratadas,
                oc.data_inicio_contratual, oc.data_fim_contratual,
                oc.id as contract_id
            FROM obras o
            LEFT JOIN obra_contracts oc ON o.id = oc.obra_id
            WHERE o.status = 'ativa'
        `);

        const dashboardData = await Promise.all(obras.map(async (obra) => {
            let horasExecutadas = 0;
            let mediaDiaria = 0;
            let pendencias = 0;

            try {
                // A. Calcular Horas Executadas (Baseado nos logs de faturamento)
                const [totalExec] = await db.query(`
                    SELECT COALESCE(SUM(horas_trabalhadas), 0) as total 
                    FROM daily_work_logs 
                    WHERE obra_id = ?
                `, [obra.id]);
                horasExecutadas = parseFloat(totalExec[0].total) || 0;

                // B. Calcular Ritmo Atual (Média dos últimos 7 dias de apontamento)
                const [ritmo] = await db.query(`
                    SELECT COALESCE(SUM(horas_trabalhadas) / 7, 0) as media_diaria
                    FROM daily_work_logs 
                    WHERE obra_id = ? AND data_apontamento >= DATE_SUB(NOW(), INTERVAL 10 DAY)
                `, [obra.id]);
                mediaDiaria = parseFloat(ritmo[0].media_diaria) || 0;

                // C. Alertas (Assinaturas pendentes)
                const [pend] = await db.query(`
                    SELECT COUNT(*) as qtd 
                    FROM daily_work_logs 
                    WHERE obra_id = ? AND (assinatura_digital IS NULL OR assinatura_digital = '')
                `, [obra.id]);
                pendencias = pend[0].qtd;

            } catch (kpiError) {
                console.warn(`Aviso: Erro ao calcular KPIs para obra ${obra.id}:`, kpiError.message);
            }

            // D. Previsão de Término (Cérebro do Sistema)
            let previsaoFim = null;
            let diasRestantes = 0;
            const saldoHoras = (obra.horas_totais_contratadas || 0) - horasExecutadas;

            if (saldoHoras > 0 && mediaDiaria > 0) {
                diasRestantes = Math.ceil(saldoHoras / mediaDiaria);
                previsaoFim = addBusinessDays(new Date(), diasRestantes);
            }

            // E. Definição de Cores e Status (Lógica 30-70-90)
            const percentual = obra.horas_totais_contratadas > 0 
                ? (horasExecutadas / obra.horas_totais_contratadas) * 100 
                : 0;

            let statusCor = 'green'; 
            if (percentual > 30) statusCor = 'yellow';
            if (percentual > 70) statusCor = 'violet';
            if (percentual > 90) statusCor = 'red';

            return {
                ...obra,
                kpi: {
                    horas_contratadas: obra.horas_totais_contratadas || 0,
                    horas_executadas: horasExecutadas,
                    saldo: saldoHoras,
                    percentual_conclusao: percentual.toFixed(1),
                    media_diaria_atual: mediaDiaria.toFixed(1),
                    dias_restantes_estimados: diasRestantes,
                    data_fim_estimada: previsaoFim,
                    status_cor: statusCor,
                    alertas_assinatura: pendencias
                }
            };
        }));

        // Ordenar: Prazo mais curto primeiro
        dashboardData.sort((a, b) => {
            if (a.kpi.data_fim_estimada && !b.kpi.data_fim_estimada) return -1;
            if (!a.kpi.data_fim_estimada && b.kpi.data_fim_estimada) return 1;
            if (a.kpi.data_fim_estimada && b.kpi.data_fim_estimada) {
                return new Date(a.kpi.data_fim_estimada) - new Date(b.kpi.data_fim_estimada);
            }
            return 0;
        });

        res.json(dashboardData);

    } catch (error) {
        console.error('Erro no Dashboard Supervisor:', error);
        res.status(500).json({ message: 'Erro ao carregar dados do dashboard.' });
    }
};

// 2. DETALHES DA OBRA (MICRO - COCKPIT)
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Dados Básicos e Contrato
        const [obraInfo] = await db.query(`
            SELECT 
                o.id, o.nome, o.responsavel,
                oc.fiscal_nome, oc.valor_total_contrato, oc.horas_totais_contratadas,
                oc.data_inicio_contratual, oc.data_fim_contratual,
                oc.id as contract_id
            FROM obras o
            LEFT JOIN obra_contracts oc ON o.id = oc.obra_id
            WHERE o.id = ?
        `, [id]);

        if (obraInfo.length === 0) return res.status(404).json({ message: 'Obra não encontrada.' });
        const obra = obraInfo[0];

        // 2. Cálculo de Despesas (Solicitado: Categorias e Total)
        const [expensesData] = await db.query(`
            SELECT category, SUM(amount) as total 
            FROM expenses 
            WHERE obraId = ? 
            GROUP BY category
        `, [id]);

        const totalExpenses = expensesData.reduce((sum, exp) => sum + parseFloat(exp.total), 0);
        const percentExpenses = obra.valor_total_contrato > 0 
            ? (totalExpenses / obra.valor_total_contrato) * 100 
            : 0;

        // 3. KPIs de Execução (Horas)
        const [totalExec] = await db.query(`SELECT COALESCE(SUM(horas_trabalhadas), 0) as total FROM daily_work_logs WHERE obra_id = ?`, [id]);
        const horasExecutadas = parseFloat(totalExec[0].total) || 0;
        const percentualHoras = obra.horas_totais_contratadas > 0 ? (horasExecutadas / obra.horas_totais_contratadas) * 100 : 0;

        // 4. Veículos Alocados
        const [veiculos] = await db.query(`
            SELECT 
                v.id, v.modelo, v.placa, v.tipo, v.horimetro, 
                COALESCE(ces.fator_conversao, 1.00) as fator_conversao,
                v.operador_atual,
                ces.data_fim_alocacao as previsao_liberacao
            FROM vehicles v
            LEFT JOIN contract_equipment_substitutions ces ON v.id = ces.veiculo_real_id AND ces.data_fim_alocacao IS NULL
            WHERE v.obraAtualId = ?
        `, [id]);

        // 5. Histórico CRM
        const [crmLogs] = await db.query(`
            SELECT log.*, u.name as supervisor_name
            FROM obra_crm_logs log
            JOIN users u ON log.supervisor_id = u.id
            WHERE log.obra_id = ?
            ORDER BY log.created_at DESC
        `, [id]);

        res.json({
            macro: {
                ...obra,
                financeiro: {
                    total_despesas: totalExpenses,
                    percentual_despesas: percentExpenses.toFixed(2),
                    despesas_por_categoria: expensesData.map(e => ({
                        ...e,
                        percentual: obra.valor_total_contrato > 0 ? ((e.total / obra.valor_total_contrato) * 100).toFixed(2) : 0
                    }))
                },
                execucao: {
                    horas_executadas: horasExecutadas,
                    percentual_horas: percentualHoras.toFixed(1)
                }
            },
            veiculos_alocados: veiculos,
            crm_history: crmLogs
        });

    } catch (error) {
        console.error('Erro ao buscar detalhes da obra:', error);
        res.status(500).json({ message: 'Erro interno.' });
    }
};

// 3. REGISTRAR INTERAÇÃO CRM
exports.addCrmLog = async (req, res) => {
    const { obra_id, tipo_interacao, resumo, compromisso_data } = req.body;
    const supervisor_id = req.user.id; 

    try {
        await db.query(`
            INSERT INTO obra_crm_logs (obra_id, supervisor_id, tipo_interacao, resumo_conversa, compromisso_data)
            VALUES (?, ?, ?, ?, ?)
        `, [obra_id, supervisor_id, tipo_interacao, resumo, compromisso_data]);

        res.status(201).json({ message: 'Registro salvo com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar CRM:', error);
        res.status(500).json({ message: 'Erro ao salvar registro.' });
    }
};

// 4. CONFIGURAR CONTRATO (QUANDO CRIA A OBRA OU EDITA)
exports.upsertContract = async (req, res) => {
    const { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome } = req.body;

    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);

        if (existing.length > 0) {
            await db.query(`
                UPDATE obra_contracts 
                SET valor_total_contrato = ?, horas_totais_contratadas = ?, data_inicio_contratual = ?, data_fim_contratual = ?, fiscal_nome = ?
                WHERE obra_id = ?
            `, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, obra_id]);
        } else {
            await db.query(`
                INSERT INTO obra_contracts (obra_id, valor_total_contrato, horas_totais_contratadas, data_inicio_contratual, data_fim_contratual, fiscal_nome)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome]);
        }

        res.json({ message: 'Dados do contrato atualizados com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar contrato:', error);
        res.status(500).json({ message: 'Erro ao processar dados do contrato.' });
    }
};