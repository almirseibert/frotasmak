// controllers/inactivityAlertController.js
const db = require('../database');

const getAllInactivityAlerts = async (req, res) => {
    try {
        // --- ROTINA DE AUTO-LIMPEZA (NOVO) ---
        // Antes de devolver a lista, o sistema verifica se existem abastecimentos POSTERIORES
        // à data do alerta. Se houver, marca o alerta como 'Resolvido' automaticamente.
        
        const autoResolveQuery = `
            UPDATE inactivity_alerts ia
            JOIN refuelings r ON ia.vehicleId = r.vehicleId
            SET 
                ia.status = 'Resolvido',
                ia.observation = CONCAT('Sistema: Resolvido automaticamente. Abastecimento detectado em ', DATE_FORMAT(r.date, '%d/%m/%Y')),
                ia.dismissedAt = NOW()
            WHERE 
                ia.status IN ('Ativo', 'Pendente') -- Apenas alertas abertos
                AND r.status = 'Concluída'        -- Apenas abastecimentos válidos
                AND r.date > ia.lastRefuelingDate -- Abastecimento é mais novo que o alerta
        `;

        try {
            await db.execute(autoResolveQuery);
        } catch (cleanupError) {
            // Logamos o erro mas não travamos a requisição principal
            console.warn('Aviso: Rotina de auto-limpeza falhou (verifique nomes das tabelas/colunas):', cleanupError.message);
        }
        
        // --- FIM DA AUTO-LIMPEZA ---

        // Agora busca apenas os alertas atualizados
        // Ordena por data (mais recentes primeiro)
        const [rows] = await db.execute('SELECT * FROM inactivity_alerts ORDER BY createdAt DESC');
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar alertas de inatividade:', error);
        res.status(500).json({ error: 'Erro ao buscar alertas de inatividade' });
    }
};

const createInactivityAlert = async (req, res) => {
    const data = req.body;

    // --- VALIDAÇÃO PREVENTIVA (NOVO) ---
    // Impede a criação de alertas duplicados ou inválidos no momento da inserção
    try {
        // 1. Verifica se já existe alerta Ativo para este veículo
        const [existing] = await db.execute(
            "SELECT id FROM inactivity_alerts WHERE vehicleId = ? AND status IN ('Ativo', 'Pendente')",
            [data.vehicleId]
        );

        if (existing.length > 0) {
            // Se já existe, apenas atualiza a data do último abastecimento do alerta existente
            await db.execute(
                "UPDATE inactivity_alerts SET lastRefuelingDate = ? WHERE id = ?",
                [data.lastRefuelingDate, existing[0].id]
            );
            return res.status(200).json({ message: 'Alerta existente atualizado', id: existing[0].id });
        }
    } catch (valError) {
        console.warn('Erro na validação preventiva:', valError);
    }

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO inactivity_alerts (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);
        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao criar alerta de inatividade' });
    }
};

const updateInactivityAlert = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const fields = Object.keys(data).filter(key => key !== 'id');
    const values = Object.values(data);
    
    if (fields.length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar" });

    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const query = `UPDATE inactivity_alerts SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        res.json({ message: 'Alerta de inatividade atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao atualizar alerta de inatividade' });
    }
};

const deleteInactivityAlert = async (req, res) => {
    try {
        await db.execute('DELETE FROM inactivity_alerts WHERE id = ?', [req.params.id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar alerta de inatividade:', error);
        res.status(500).json({ error: 'Erro ao deletar alerta de inatividade' });
    }
};

module.exports = {
    getAllInactivityAlerts,
    createInactivityAlert,
    updateInactivityAlert,
    deleteInactivityAlert,
};