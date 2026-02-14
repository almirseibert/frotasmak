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

            // Tenta buscar dados de execução (KPIs). Se a tabela não existir, assume 0.
            try {
                // A. Calcular Horas Executadas
                const [totalExec] = await db.query(`
                    SELECT COALESCE(SUM(horas_trabalhadas), 0) as total 
                    FROM daily_work_logs 
                    WHERE obra_id = ?
                `, [obra.id]);
                horasExecutadas = parseFloat(totalExec[0].total) || 0;

                // B. Calcular Ritmo Atual (Média dos últimos 7 dias)
                const [ritmo] = await db.query(`
                    SELECT COALESCE(SUM(horas_trabalhadas) / 7, 0) as media_diaria
                    FROM daily_work_logs 
                    WHERE obra_id = ? AND data_apontamento >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                `, [obra.id]);
                mediaDiaria = parseFloat(ritmo[0].media_diaria) || 0;

                // E. Alertas (Assinaturas pendentes)
                const [pend] = await db.query(`
                    SELECT COUNT(*) as qtd 
                    FROM daily_work_logs 
                    WHERE obra_id = ? AND (assinatura_digital IS NULL OR assinatura_digital = '')
                `, [obra.id]);
                pendencias = pend[0].qtd;

            } catch (kpiError) {
                console.warn(`Aviso: Erro ao calcular KPIs para obra ${obra.id} (Tabela daily_work_logs existe?):`, kpiError.message);
                // Continua com valores zerados
            }

            // C. Previsão de Término
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

        // Ordenar
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

// 2. DETALHES DA OBRA (MICRO - COCKPIT) - REVISADO PARA SER COMPLETO
exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Buscar Dados da Obra e Contrato (Igual ao Dashboard)
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

        if (obraInfo.length === 0) {
            return res.status(404).json({ message: 'Obra não encontrada.' });
        }
        const obra = obraInfo[0];

        // 2. Calcular KPIs Específicos para esta obra (Lógica duplicada segura)
        let horasExecutadas = 0;
        let mediaDiaria = 0;
        let pendencias = 0;

        try {
            const [totalExec] = await db.query(`SELECT COALESCE(SUM(horas_trabalhadas), 0) as total FROM daily_work_logs WHERE obra_id = ?`, [id]);
            horasExecutadas = parseFloat(totalExec[0].total) || 0;

            const [ritmo] = await db.query(`SELECT COALESCE(SUM(horas_trabalhadas) / 7, 0) as media_diaria FROM daily_work_logs WHERE obra_id = ? AND data_apontamento >= DATE_SUB(NOW(), INTERVAL 7 DAY)`, [id]);
            mediaDiaria = parseFloat(ritmo[0].media_diaria) || 0;

            const [pend] = await db.query(`SELECT COUNT(*) as qtd FROM daily_work_logs WHERE obra_id = ? AND (assinatura_digital IS NULL OR assinatura_digital = '')`, [id]);
            pendencias = pend[0].qtd;
        } catch (err) {
            console.warn(`Erro KPI Detalhe Obra ${id}:`, err.message);
        }

        // Cálculos
        let previsaoFim = null;
        let diasRestantes = 0;
        const saldoHoras = (obra.horas_totais_contratadas || 0) - horasExecutadas;
        if (saldoHoras > 0 && mediaDiaria > 0) {
            diasRestantes = Math.ceil(saldoHoras / mediaDiaria);
            previsaoFim = addBusinessDays(new Date(), diasRestantes);
        }
        const percentual = obra.horas_totais_contratadas > 0 ? (horasExecutadas / obra.horas_totais_contratadas) * 100 : 0;
        
        let statusCor = 'green';
        if (percentual > 30) statusCor = 'yellow';
        if (percentual > 70) statusCor = 'violet';
        if (percentual > 90) statusCor = 'red';

        const macroData = {
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

        // 3. Busca Veículos e CRM
        const [veiculos] = await db.query(`
            SELECT 
                v.id, v.modelo, v.placa, v.tipo, v.horimetro, 
                COALESCE(ces.fator_conversao, 1.00) as fator_conversao,
                v.operador_atual
            FROM vehicles v
            LEFT JOIN contract_equipment_substitutions ces ON v.id = ces.veiculo_real_id AND ces.data_fim_alocacao IS NULL
            WHERE v.obraAtualId = ?
        `, [id]);

        const [crmLogs] = await db.query(`
            SELECT log.*, u.name as supervisor_name
            FROM obra_crm_logs log
            JOIN users u ON log.supervisor_id = u.id
            WHERE log.obra_id = ?
            ORDER BY log.created_at DESC
        `, [id]);

        // Retorna tudo unificado
        res.json({
            macro: macroData,
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

// 4. CONFIGURAR CONTRATO
exports.upsertContract = async (req, res) => {
    const { obra_id, valor_total, horas_totais, data_inicio, fiscal_nome } = req.body;

    try {
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