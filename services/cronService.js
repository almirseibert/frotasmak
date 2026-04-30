const cron = require('node-cron');
const db = require('../database');
const whatsappService = require('./whatsappService'); // Importação do serviço de WhatsApp

// ====================================================================
// 1. ROTINA DIÁRIA (08:00) - Verifica Agenda, Manutenções e RH (WhatsApp)
// ====================================================================
cron.schedule('0 8 * * *', async () => {
    console.log('⏳ [CRON] Rodando rotina automática diária (Agenda e RH)...');
    
    try {
        const [gestores] = await db.query("SELECT id FROM users WHERE role IN ('admin', 'master', 'supervisor')");
        if (gestores.length === 0) {
            console.log('⏳ [CRON] Nenhum usuário gestor encontrado para receber alertas.');
            // Não damos return aqui para garantir que os alertas de WhatsApp para os funcionários ainda rodem
        }

        // ====================================================================
        // A. ALERTAS DE AGENDA (ORIGINAL MANTIDO) - CNH e Manutenção
        // ====================================================================
        if (gestores.length > 0) {
            // Verificação de CNH para Agenda (Mantive suporte a cnhExpiration/cnhVencimento)
            try {
                const [cnhVencendo] = await db.query(`
                    SELECT id, IFNULL(nome, name) as name, COALESCE(cnhVencimento, cnhExpiration) as dataVencimento
                    FROM employees 
                    WHERE COALESCE(cnhVencimento, cnhExpiration) = CURDATE() + INTERVAL 30 DAY
                `);

                for (const emp of cnhVencendo) {
                    for (const gestor of gestores) {
                        const [jaAvisou] = await db.query(`
                            SELECT id FROM user_agenda 
                            WHERE user_id = ? AND related_type = 'employee' AND related_id = ? 
                              AND title LIKE '%CNH%' AND created_at >= NOW() - INTERVAL 7 DAY
                        `, [gestor.id, emp.id]);

                        if (jaAvisou.length === 0) {
                            await db.query(`
                                INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, reminder_time, notification_status)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                            `, [
                                gestor.id,
                                `⚠️ CNH Vencendo: ${emp.name}`,
                                `A CNH do funcionário ${emp.name} vence em 30 dias. Verifique a renovação.`,
                                new Date(),
                                'employee',
                                emp.id,
                                '#EF4444',
                                0
                            ]);
                        }
                    }
                }
            } catch (e) {
                 console.error('❌ [CRON] Erro ao verificar CNHs para Agenda:', e.message);
            }

            // Verificação de Manutenção para Agenda
            try {
                const [manutencoes] = await db.query(`
                    SELECT id, plate, fleetNumber, currentKm, nextOilChangeKm 
                    FROM vehicles 
                    WHERE status = 'Ativo' AND currentKm >= (nextOilChangeKm - 1000)
                `);

                for (const v of manutencoes) {
                    for (const gestor of gestores) {
                        const [jaAvisou] = await db.query(`
                            SELECT id FROM user_agenda 
                            WHERE user_id = ? AND related_type = 'vehicle' AND related_id = ? 
                              AND title LIKE '%Manutenção Próxima%' AND created_at >= NOW() - INTERVAL 7 DAY
                        `, [gestor.id, v.id]);

                        if (jaAvisou.length === 0) {
                            await db.query(`
                                INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, reminder_time, notification_status)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                            `, [
                                gestor.id,
                                `🔧 Manutenção Próxima: Veículo ${v.plate}`,
                                `O veículo ${v.plate} (Frota ${v.fleetNumber}) está com ${v.currentKm}km. A troca de óleo está prevista para ${v.nextOilChangeKm}km.`,
                                new Date(),
                                'vehicle',
                                v.id,
                                '#EAB308',
                                0
                            ]);
                        }
                    }
                }
            } catch (e) {
                 console.error('❌ [CRON] Erro ao verificar manutenções preventivas:', e.message);
            }
        }

        // ====================================================================
        // B. ALERTAS DE RH VIA WHATSAPP E AUDITORIA (NOVO)
        // ====================================================================
        try {
            const [vencimentosRH] = await db.query(`
                SELECT id, IFNULL(nome, name) as nome, contato, cnhVencimento, exameToxicologicoVencimento
                FROM employees 
                WHERE status = 'ativo' AND (
                    cnhVencimento = CURDATE() + INTERVAL 30 DAY OR
                    cnhVencimento = CURDATE() OR
                    exameToxicologicoVencimento = CURDATE() + INTERVAL 30 DAY OR
                    exameToxicologicoVencimento = CURDATE()
                )
            `);

            for (const emp of vencimentosRH) {
                const isCnh30Dias = emp.cnhVencimento && new Date(emp.cnhVencimento).toISOString().split('T')[0] === new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
                const isCnhHoje = emp.cnhVencimento && new Date(emp.cnhVencimento).toISOString().split('T')[0] === new Date().toISOString().split('T')[0];
                const isTox30Dias = emp.exameToxicologicoVencimento && new Date(emp.exameToxicologicoVencimento).toISOString().split('T')[0] === new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
                const isToxHoje = emp.exameToxicologicoVencimento && new Date(emp.exameToxicologicoVencimento).toISOString().split('T')[0] === new Date().toISOString().split('T')[0];

                if (emp.contato && whatsappService) {
                    // Envio para o Funcionário (30 dias)
                    if (isCnh30Dias) {
                        await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Alerta CNH 30 Dias', `Olá ${emp.nome}, sua CNH vencerá em 30 dias. Por favor, programe a renovação.`).catch(() => {});
                    }
                    if (isTox30Dias) {
                        await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Alerta Toxicológico 30 Dias', `Olá ${emp.nome}, seu Exame Toxicológico vencerá em 30 dias. Por favor, programe a renovação.`).catch(() => {});
                    }

                    // Envio para o Funcionário e RH (Hoje)
                    if (isCnhHoje) {
                        await whatsappService.enviarMensagem(emp.contato, emp.nome, 'CNH Vencida Hoje', `⚠️ Atenção ${emp.nome}, sua CNH vence HOJE. Entre em contato com o RH.`).catch(() => {});
                        await whatsappService.enviarMensagem(whatsappService.CONTATOS_INTERNOS.RH, 'RH', 'Aviso CNH Vencida', `A CNH do funcionário *${emp.nome}* venceu hoje.`).catch(() => {});
                    }
                    if (isToxHoje) {
                        await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Toxicológico Vencido Hoje', `⚠️ Atenção ${emp.nome}, seu Exame Toxicológico vence HOJE. Entre em contato com o RH.`).catch(() => {});
                        await whatsappService.enviarMensagem(whatsappService.CONTATOS_INTERNOS.RH, 'RH', 'Aviso Toxicológico Vencido', `O Exame Toxicológico do funcionário *${emp.nome}* venceu hoje.`).catch(() => {});
                    }
                }
            }
        } catch (e) {
             console.error('❌ [CRON] Erro ao verificar Documentos RH para WhatsApp:', e.message);
        }

        // ====================================================================
        // C. RETORNO AUTOMÁTICO DE AFASTAMENTOS E FÉRIAS (NOVO)
        // ====================================================================
        try {
            const [afastados] = await db.query(`
                SELECT id, IFNULL(nome, name) as nome, statusAfastamentoTipo 
                FROM employees 
                WHERE statusAfastamentoTipo IS NOT NULL 
                  AND statusAfastamentoTermino < CURDATE()
                  AND status = 'ativo'
            `);

            for (const emp of afastados) {
                // Remove o status de afastamento e define a data de retorno para HOJE
                await db.query(`
                    UPDATE employees 
                    SET statusAfastamentoTipo = NULL, statusAfastamentoTermino = NULL, dataRetornoAfastamento = CURDATE()
                    WHERE id = ?
                `, [emp.id]);

                // Dispara o alerta para os gestores na Agenda informando o retorno
                for (const gestor of gestores) {
                    await db.query(`
                        INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, notification_status)
                        VALUES (?, ?, ?, NOW(), 'employee', ?, '#3B82F6', 'pending')
                    `, [
                        gestor.id,
                        `✅ Retorno de ${emp.statusAfastamentoTipo}: ${emp.nome}`,
                        `O colaborador ${emp.nome} finalizou seu período de ${emp.statusAfastamentoTipo} e retornou às atividades hoje.`,
                        emp.id
                    ]);
                }
            }
        } catch (e) {
             console.error('❌ [CRON] Erro ao verificar retorno de afastamentos:', e.message);
        }

        console.log('✅ [CRON] Rotina diária finalizada com sucesso.');
    } catch (error) {
        console.error('❌ [CRON] Erro geral na rotina automática:', error);
    }
});


// ====================================================================
// 2. ROTINA MINUTO A MINUTO (ORIGINAL MANTIDO) - Lembretes Agenda Real-Time
// ====================================================================
cron.schedule('* * * * *', async () => {
    try {
        const [eventos] = await db.query(`
            SELECT id, user_id, title, DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime_str, reminders 
            FROM user_agenda 
            WHERE is_completed = 0
        `);

        if (eventos.length === 0) return;

        const agora = Date.now();

        for (const evento of eventos) {
            if (!evento.reminders || !evento.event_datetime_str) continue;

            let reminders = [];
            try {
                reminders = typeof evento.reminders === 'string' ? JSON.parse(evento.reminders) : evento.reminders;
            } catch (e) {
                console.error(`[CRON] Erro ao parsear lembretes do evento ID: ${evento.id}`);
                continue;
            }

            if (!Array.isArray(reminders) || reminders.length === 0) continue;

            let atualizouBanco = false;

            const dataEventoMs = new Date(evento.event_datetime_str + '-03:00').getTime();

            for (let i = 0; i < reminders.length; i++) {
                const rem = reminders[i];

                if (rem.sent) continue;

                let subtrairMs = 0;

                if (rem.minutes !== undefined) {
                    subtrairMs = rem.minutes * 60000;
                } else {
                    if (rem.unit === 'minutos') subtrairMs = rem.value * 60000;
                    else if (rem.unit === 'horas') subtrairMs = rem.value * 3600000;
                    else if (rem.unit === 'dias') subtrairMs = rem.value * 86400000;
                    else if (rem.unit === 'semanas') subtrairMs = rem.value * 604800000;
                    else if (rem.unit === 'meses') subtrairMs = rem.value * 2592000000;
                }

                const dataGatilhoMs = dataEventoMs - subtrairMs;

                if (agora >= dataGatilhoMs) {
                    if (global.io) {
                        let msgTempo = '';
                        if (rem.unit === 'na_hora') {
                            msgTempo = 'começará agora!';
                        } else if (rem.label) {
                            msgTempo = `começará em ${rem.label.replace(' antes', '')}.`;
                        } else {
                            msgTempo = `começará em ${rem.value} ${rem.unit}.`;
                        }

                        const mensagem = `Lembrete: "${evento.title}" ${msgTempo}`;
                        
                        global.io.emit('agenda:alerta', {
                            userId: evento.user_id,
                            eventId: evento.id,
                            title: 'Lembrete de Agenda',
                            message: mensagem
                        });
                        console.log(`[CRON AGENDA] Alerta disparado para usuário ${evento.user_id} - Evento: ${evento.title}`);
                    }
                    rem.sent = true;
                    atualizouBanco = true;
                }
            }

            if (atualizouBanco) {
                const novosLembretes = JSON.stringify(reminders);
                await db.query('UPDATE user_agenda SET reminders = ? WHERE id = ?', [novosLembretes, evento.id]);
            }
        }
    } catch (error) {
        console.error('❌ [CRON AGENDA] Erro na rotina de lembretes da agenda:', error);
    }
});

module.exports = cron;