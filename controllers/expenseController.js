// controllers/expenseController.js
const db = require('../database');

// --- Função para Criar ou Atualizar Despesas Semanais (Deve ser chamada dentro de uma transação) ---
const createOrUpdateWeeklyFuelExpense = async ({ connection, obraId, date, fuelType, partnerName, valueChange }) => {
    // 1. Condições para não gerar despesa (ex: valor zero)
    if (!valueChange || valueChange === 0) {
        return;
    }

    // 2. Calcular o início e fim da semana (Segunda a Domingo)
    const txDate = new Date(date);
    txDate.setHours(0, 0, 0, 0); 
    const dayOfWeek = txDate.getDay(); 
    const diff = txDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStartDate = new Date(txDate.setDate(diff));
    
    // 3. Montar a descrição e os dados
    const formattedFuelType = (fuelType || 'N/A').replace(/([A-Z])/g, ' $1').toLowerCase();
    const description = `Combustível: ${formattedFuelType} - ${partnerName}`;

    // 4. Procurar por uma despesa existente para essa semana/obra/combustível/posto
    const [querySnapshot] = await connection.execute(
        `SELECT id, amount FROM expenses 
         WHERE obraId = ? AND weekStartDate = ? AND fuelType = ? AND partnerName = ?`,
        [obraId, weekStartDate.toISOString().split('T')[0], fuelType, partnerName]
    );

    if (querySnapshot.length === 0) {
        // Se não existir, CRIA uma nova despesa
        if (valueChange > 0) {
            await connection.execute(`INSERT INTO expenses 
                (obraId, description, amount, category, createdAt, weekStartDate, fuelType, partnerName)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                [obraId, description, valueChange, 'Combustível', new Date(), weekStartDate, fuelType, partnerName]
            );
        }
    } else {
        // Se existir, ATUALIZA o valor (incrementando ou decrementando)
        const existingExpense = querySnapshot[0];
        const newAmount = existingExpense.amount + valueChange;

        if (newAmount === 0) {
             // Deleta a despesa se o valor final for zero
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense.id]);
        } else {
            await connection.execute('UPDATE expenses SET amount = ? WHERE id = ?', [newAmount, existingExpense.id]);
        }
    }
};

module.exports = {
    createOrUpdateWeeklyFuelExpense,
};