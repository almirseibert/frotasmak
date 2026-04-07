const cron = require('node-cron');
const db = require('../database');

// Esta rotina vai rodar TODOS OS DIAS às 08:00 da manhã
// Formato do cron: 'minuto hora dia mes dia_da_semana'
cron.schedule('0 8 * * *', async () => {
    console.log('⏳ [CRON] Rodando rotina automática de verificação para a Agenda...');
    
    try {
        // 1. Buscar usuários que devem receber alertas (Admin, Master e Supervisor)
        const [gestores] = await db.query("SELECT id FROM users WHERE role IN ('admin', 'master', 'supervisor')");
        if (gestores.length === 0) {
            console.log('⏳ [CRON] Nenhum usuário gestor encontrado para receber alertas.');
            return;
        }

        // ====================================================================
        // 2. VERIFICAÇÃO DE VENCIMENTO DE CNH (Aviso 30 dias antes)
        // Coluna confirmada no frotasmak.sql: cnhExpiration
        // ====================================================================
        try {
            const [cnhVencendo] = await db.query(`
                SELECT id, name, cnhExpiration 
                FROM employees 
                WHERE cnhExpiration = CURDATE() + INTERVAL 30 DAY
            `);

            for (const emp of cnhVencendo) {
                for (const gestor of gestores) {
                    // Evita duplicidade de aviso para a mesma CNH no mesmo dia
                    const [jaAvisou] = await db.query(`
                        SELECT id FROM user_agenda 
                        WHERE user_id = ? AND related_type = 'employee' AND related_id = ? 
                          AND title LIKE '%CNH Vencendo%' AND DATE(event_datetime) = CURDATE()
                    `, [gestor.id, emp.id]);

                    if (jaAvisou.length === 0) {
                        await db.query(`
                            INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [
                            gestor.id,
                            `🚨 CNH Vencendo: ${emp.name}`,
                            `A CNH do motorista/operador ${emp.name} vencerá em exatos 30 dias. Providenciar renovação.`,
                            new Date(), // Agenda para hoje
                            'employee', // Tag para Deep Link
                            emp.id,
                            '#EF4444' // Vermelho (Urgente - Tailwind red-500)
                        ]);
                    }
                }
            }
        } catch (e) {
            console.error('❌ [CRON] Erro ao verificar CNHs:', e.message);
        }

        // ====================================================================
        // 3. VERIFICAÇÃO DE MANUTENÇÃO PREVENTIVA (Troca de Óleo / KM)
        // Colunas confirmadas no frotasmak.sql: currentKm, nextOilChangeKm
        // ====================================================================
        try {
            // Busca veículos que estão a 1000km ou menos da próxima troca de óleo
            const [veiculosManutencao] = await db.query(`
                SELECT id, plate, fleetNumber, currentKm, nextOilChangeKm 
                FROM vehicles 
                WHERE nextOilChangeKm IS NOT NULL 
                  AND (nextOilChangeKm - currentKm) <= 1000
                  AND (nextOilChangeKm - currentKm) > 0
            `);

            for (const v of veiculosManutencao) {
                for (const gestor of gestores) {
                    // Regra de Ouro: Evitar SPAM. Verifica se já não criamos esse alerta nos últimos 7 dias.
                    const [jaAvisou] = await db.query(`
                        SELECT id FROM user_agenda 
                        WHERE user_id = ? AND related_type = 'vehicle' AND related_id = ? 
                          AND title LIKE '%Manutenção Próxima%' AND created_at >= NOW() - INTERVAL 7 DAY
                    `, [gestor.id, v.id]);

                    if (jaAvisou.length === 0) {
                        await db.query(`
                            INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [
                            gestor.id,
                            `🔧 Manutenção Próxima: Veículo ${v.plate}`,
                            `O veículo ${v.plate} (Frota ${v.fleetNumber}) está com ${v.currentKm}km. A troca de óleo está prevista para ${v.nextOilChangeKm}km.`,
                            new Date(), // Agenda para hoje
                            'vehicle', // Tag para Deep Link
                            v.id,
                            '#EAB308' // Amarelo (Atenção - Tailwind yellow-500)
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

module.exports = cron;