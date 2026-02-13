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
            // A. Calcular Horas Executadas (Total Real - Baseado em Logs/Apontamentos e Horímetros)
            // Aqui unificamos logs de trabalho (faturamento) ou horímetro real se houver tracking
            // Para simplificar conforme solicitado, usamos daily_work_logs como base do "Executado"
            const [totalExec] = await db.query(`
                SELECT COALESCE(SUM(horas_trabalhadas), 0) as total 
                FROM daily_work_logs 
                WHERE obra_id = ?
            `, [obra.id]);
            const horasExecutadas = parseFloat(totalExec[0].total) || 0;

            // B. Calcular Ritmo Atual (Média dos últimos 7 dias)
            // Isso define a "Velocidade de Cruzeiro" da obra
            const [ritmo] = await db.query(`
                SELECT COALESCE(SUM(horas_trabalhadas) / 7, 0) as media_diaria
                FROM daily_work_logs 
                WHERE obra_id = ? AND data_apontamento >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            `, [obra.id]);
            const mediaDiaria = parseFloat(ritmo[0].media_diaria) || 0;

            // C. Previsão de Término (A "IA" do Sistema)
            let previsaoFim = null;
            let diasRestantes = 0;
            const saldoHoras = (obra.horas_totais_contratadas || 0) - horasExecutadas;

            if (saldoHoras > 0 && mediaDiaria > 0) {
                diasRestantes = Math.ceil(saldoHoras / mediaDiaria);
                previsaoFim = addBusinessDays(new Date(), diasRestantes);
            }

            // D. Definição de Cores e Status
            const percentual = obra.horas_totais_contratadas > 0 
                ? (horasExecutadas / obra.horas_totais_contratadas) * 100 
                : 0;

            let statusCor = 'green'; // 0-30%
            if (percentual > 30) statusCor = 'yellow'; // 30-70%
            if (percentual > 70) statusCor = 'violet'; // 70-90%
            if (percentual > 90) statusCor = 'red';    // >90%

            // E. Alertas (Assinaturas pendentes)
            const [pendencias] = await db.query(`
                SELECT COUNT(*) as qtd 
                FROM daily_work_logs 
                WHERE obra_id = ? AND (assinatura_digital IS NULL OR assinatura_digital = '')
            `, [obra.id]);

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
                    alertas_assinatura: pendencias[0].qtd
                }
            };
        }));

        // Ordenar: Obras que acabam primeiro aparecem antes (Prioridade)
        dashboardData.sort((a, b) => {
            // Se uma tem previsão e outra não, a que tem previsão vem primeiro
            if (a.kpi.data_fim_estimada && !b.kpi.data_fim_estimada) return -1;
            if (!a.kpi.data_fim_estimada && b.kpi.data_fim_estimada) return 1;
            
            // Se ambas tem previsão, ordena pela data (mais cedo primeiro)
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
        // Busca Veículos Alocados atualmente
        // Faz LEFT JOIN com a tabela de substituição para ver se tem fator de conversão
        const [veiculos] = await db.query(`
            SELECT 
                v.id, v.modelo, v.placa, v.tipo, v.horimetro, 
                COALESCE(ces.fator_conversao, 1.00) as fator_conversao,
                v.operador_atual -- Assumindo que você tem essa coluna ou similar no JSON
            FROM vehicles v
            LEFT JOIN contract_equipment_substitutions ces ON v.id = ces.veiculo_real_id AND ces.data_fim_alocacao IS NULL
            WHERE v.obraAtualId = ?
        `, [id]);

        // Busca Histórico de CRM (Ligações)
        const [crmLogs] = await db.query(`
            SELECT log.*, u.name as supervisor_name
            FROM obra_crm_logs log
            JOIN users u ON log.supervisor_id = u.id
            WHERE log.obra_id = ?
            ORDER BY log.created_at DESC
        `, [id]);

        res.json({
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
    const supervisor_id = req.user.id; // Pega do token JWT

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
    const { obra_id, valor_total, horas_totais, data_inicio, fiscal_nome } = req.body;

    try {
        // Verifica se já existe contrato
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);

        if (existing.length > 0) {
            await db.query(`
                UPDATE obra_contracts 
                SET valor_total_contrato = ?, horas_totais_contratadas = ?, data_inicio_contratual = ?, fiscal_nome = ?
                WHERE obra_id = ?
            `, [valor_total, horas_totais, data_inicio, fiscal_nome, obra_id]);
        } else {
            await db.query(`
                INSERT INTO obra_contracts (obra_id, valor_total_contrato, horas_totais_contratadas, data_inicio_contratual, fiscal_nome)
                VALUES (?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, fiscal_nome]);
        }

        res.json({ message: 'Dados do contrato atualizados.' });
    } catch (error) {
        console.error('Erro ao salvar contrato:', error);
        res.status(500).json({ message: 'Erro interno.' });
    }
};