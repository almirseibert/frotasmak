const cron = require('node-cron');
const db = require('../database');

// ====================================================================
// 1. ROTINA DIÁRIA (08:00) - Verifica CNH e Manutenções Preventivas
// ====================================================================
cron.schedule('0 8 * * *', async () => {
    console.log('⏳ [CRON] Rodando rotina automática de verificação para a Agenda...');
    
    try {
        const [gestores] = await db.query("SELECT id FROM users WHERE role IN ('admin', 'master', 'supervisor')");
        if (gestores.length === 0) {
            console.log('⏳ [CRON] Nenhum usuário gestor encontrado para receber alertas.');
            return;
        }

        // Verificação de CNH
        try {
            const [cnhVencendo] = await db.query(`
                SELECT id, name, cnhExpiration 
                FROM employees 
                WHERE cnhExpiration = CURDATE() + INTERVAL 30 DAY
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
             console.error('❌ [CRON] Erro ao verificar CNHs:', e.message);
        }

        // Verificação de Manutenção
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

        console.log('✅ [CRON] Rotina automática da agenda finalizada com sucesso.');
    } catch (error) {
        console.error('❌ [CRON] Erro geral na rotina automática da agenda:', error);
    }
});


// ====================================================================
// 2. ROTINA MINUTO A MINUTO - Disparo Real-Time de Avisos da Agenda
// ====================================================================
cron.schedule('* * * * *', async () => {
    try {
        // Busca eventos que não foram concluídos e estão na janela de ação (-1h a +2 dias)
        const query = `
            SELECT id, user_id, title, event_datetime, reminder_time, notification_status 
            FROM user_agenda 
            WHERE is_completed = FALSE 
            AND event_datetime BETWEEN NOW() - INTERVAL 1 HOUR AND NOW() + INTERVAL 2 DAY
        `;
        const [eventos] = await db.query(query);

        const agora = new Date();

        for (const evento of eventos) {
            const dataEvento = new Date(evento.event_datetime);
            const diffMinutos = Math.floor((dataEvento - agora) / (1000 * 60)); // Diferença em minutos

            let precisaAvisar = false;
            let novaCategoriaStatus = evento.notification_status || 'pending';
            let mensagem = '';

            // Lógica Normal (15 min, 60 min, 1440 min)
            if (evento.reminder_time > 0) {
                if (diffMinutos <= evento.reminder_time && diffMinutos >= 0 && (evento.notification_status === 'pending' || !evento.notification_status)) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent';
                    mensagem = `⏳ Lembrete: Este evento começa em ${evento.reminder_time >= 60 ? (evento.reminder_time/60)+' hora(s)' : evento.reminder_time+' minutos'}.`;
                }
            } 
            // Lógica Padrão (Na hora exata - 0)
            else if (evento.reminder_time === 0) {
                 if (diffMinutos <= 0 && diffMinutos >= -5 && (evento.notification_status === 'pending' || !evento.notification_status)) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent';
                    mensagem = `🔴 O evento está começando agora!`;
                 }
            }
            // Lógica de Cascata Crítica (-1)
            else if (evento.reminder_time === -1) {
                if (diffMinutos <= 1440 && diffMinutos > 60 && (!evento.notification_status || evento.notification_status === 'pending')) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent_1440';
                    mensagem = `📅 CRÍTICO (1 Dia): Este evento importante acontece amanhã!`;
                } else if (diffMinutos <= 60 && diffMinutos > 15 && (evento.notification_status === 'pending' || evento.notification_status === 'sent_1440')) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent_60';
                    mensagem = `⏰ CRÍTICO (1 Hora): O evento importante será em 1 hora!`;
                } else if (diffMinutos <= 15 && diffMinutos > 0 && (evento.notification_status === 'pending' || evento.notification_status === 'sent_1440' || evento.notification_status === 'sent_60')) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent_15';
                    mensagem = `⚠️ URGENTE: O evento crítico começa em 15 minutos!`;
                } else if (diffMinutos <= 0 && diffMinutos >= -5 && (evento.notification_status !== 'sent_0')) {
                    precisaAvisar = true;
                    novaCategoriaStatus = 'sent_0';
                    mensagem = `🚨 O EVENTO CRÍTICO ESTÁ COMEÇANDO AGORA!`;
                }
            }

            // Se a lógica detectou que deve avisar, dispara o alerta!
            if (precisaAvisar) {
                // 1. Atualiza o banco para não repetir o mesmo aviso
                await db.query('UPDATE user_agenda SET notification_status = ? WHERE id = ?', [novaCategoriaStatus, evento.id]);

                // 2. Dispara o alerta instantâneo pelo Socket.io
                if (global.io) {
                    global.io.emit('agenda:alerta', {
                        userId: evento.user_id,
                        title: evento.title,
                        message: mensagem,
                        eventId: evento.id
                    });
                }
            }
        }
    } catch (error) {
        console.error('❌ [CRON MINUTO] Erro na rotina de lembretes da agenda:', error);
    }
});

module.exports = cron;