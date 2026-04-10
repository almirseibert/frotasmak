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
        // Usa DATE_FORMAT para obter a data exatamente como foi salva e ignorar o fuso horário do servidor
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

            // Forçamos a string do banco de dados a ser interpretada como UTC-3 (Horário de Brasília)
            // Isso previne o bug onde o Node.js em UTC via a data do Brasil como 3 horas no passado, 
            // fazendo o alerta disparar instantaneamente logo após a criação do evento.
            const dataEventoMs = new Date(evento.event_datetime_str + '-03:00').getTime();

            for (let i = 0; i < reminders.length; i++) {
                const rem = reminders[i];

                // Se o lembrete já foi enviado, ignora
                if (rem.sent) continue;

                let subtrairMs = 0;

                // Prioriza os minutos exatos calculados pelo frontend (suporta 'meses' corretamente e resolve bugs)
                if (rem.minutes !== undefined) {
                    subtrairMs = rem.minutes * 60000;
                } else {
                    // Fallback para eventos antigos caso o 'minutes' não exista na linha do banco
                    if (rem.unit === 'minutos') subtrairMs = rem.value * 60000;
                    else if (rem.unit === 'horas') subtrairMs = rem.value * 3600000;
                    else if (rem.unit === 'dias') subtrairMs = rem.value * 86400000;
                    else if (rem.unit === 'semanas') subtrairMs = rem.value * 604800000;
                    else if (rem.unit === 'meses') subtrairMs = rem.value * 2592000000;
                }

                const dataGatilhoMs = dataEventoMs - subtrairMs;

                // Se a hora atual já passou ou é igual à hora calculada pro gatilho
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

            // Atualiza o banco para não repetir
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