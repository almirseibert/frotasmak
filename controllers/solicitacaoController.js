// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- CONFIGURAÇÃO MULTER (Uploads) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

// --- HELPERS ---
const safeNum = (val) => {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// --- FUNÇÃO PRINCIPAL: CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        const { 
            veiculoId, obraId, postoId, tipoCombustivel, 
            litragem, flagTanqueCheio, flagOutros, 
            horimetro, odometro 
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;

        // 1. Verificar Bloqueio do Usuário
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        if (users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO. Contate o administrador.' });
        }

        // 2. Verificar Regras de Leitura (Consistência)
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculoId]);
        const veiculo = vehicles[0];
        
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        const antHorimetro = safeNum(veiculo.horimetro || veiculo.horimetroDigital);

        // Validação Odômetro
        if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) erroValidacao = `Odômetro menor que o anterior (${antOdometro}).`;
            else if ((novoOdometro - antOdometro) > 1000) erroValidacao = `Salto de Odômetro excessivo (>1000km).`;
        }

        // Validação Horímetro
        if (novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) erroValidacao = `Horímetro menor que o anterior (${antHorimetro}).`;
            else if ((novoHorimetro - antHorimetro) > 50) erroValidacao = `Salto de Horímetro excessivo (>50h).`;
        }

        // --- TRATAMENTO DE ERRO (BLOQUEIO 3 TENTATIVAS) ---
        if (erroValidacao) {
            const novasTentativas = users[0].tentativas_falhas_abastecimento + 1;
            let bloquear = 0;
            let msgBloqueio = '';

            if (novasTentativas >= 3) {
                bloquear = 1;
                msgBloqueio = ' BLOQUEADO POR TENTATIVAS EXCEDIDAS.';
            }

            await connection.execute(
                'UPDATE users SET tentativas_falhas_abastecimento = ?, bloqueado_abastecimento = ? WHERE id = ?',
                [novasTentativas, bloquear, usuarioId]
            );
            
            await connection.commit();
            return res.status(400).json({ 
                error: `Erro de Leitura: ${erroValidacao} (Tentativa ${novasTentativas}/3).${msgBloqueio}` 
            });
        }

        // Se passou, zera tentativas
        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

        // 3. Trava Orçamentária (20%)
        const [obras] = await connection.execute('SELECT valorContrato FROM obras WHERE id = ?', [obraId]);
        if (obras.length > 0 && obras[0].valorContrato > 0) {
            const valorContrato = parseFloat(obras[0].valorContrato);
            
            // Busca total gasto (Expenses + Refuelings não confirmados ainda não geram expense, então somamos expenses)
            // Nota: Para simplificar e ser performático, somamos expenses da categoria combustível
            const [expenses] = await connection.execute(
                "SELECT SUM(amount) as total FROM expenses WHERE obraId = ? AND category = 'Combustível'", 
                [obraId]
            );
            const totalGasto = safeNum(expenses[0].total);
            
            // Estimativa custo atual (Litragem * Preço Médio ou Preço do Posto)
            // Se não tiver litragem (tanque cheio), estima 100L ou pega capacidade do veículo (se tivesse). 
            // Usaremos um valor seguro ou o preço do posto se disponível.
            let precoEst = 6.00; // Fallback
            if (postoId) {
                const [precos] = await connection.execute('SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?', [postoId, tipoCombustivel]);
                if (precos.length > 0) precoEst = safeNum(precos[0].price);
            }
            
            const custoEstimado = (safeNum(litragem) || 200) * precoEst; // Se tanque cheio, chuta alto para segurança
            
            if ((totalGasto + custoEstimado) > (valorContrato * 0.20)) {
                await connection.rollback();
                // Mensagem genérica conforme solicitado
                return res.status(400).json({ error: 'Limite orçamentário da obra excedido para abastecimento.' });
            }
        }

        // 4. Inserir Solicitação
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, status, data_solicitacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', NOW())`,
            [
                usuarioId, veiculoId, obraId, postoId || null, tipoCombustivel,
                safeNum(litragem), flagTanqueCheio ? 1 : 0, flagOutros ? 1 : 0,
                novoHorimetro || null, novoOdometro || null, fotoPainel
            ]
        );

        await connection.commit();
        
        // Notifica Admins via Socket
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        req.io.emit('admin:notificacao', { tipo: 'nova_solicitacao', id: result.insertId });

        res.status(201).json({ message: 'Solicitação enviada! Aguarde aprovação.', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar solicitação.' });
    } finally {
        connection.release();
    }
};

// --- LISTAR SOLICITAÇÕES ---
const listarSolicitacoes = async (req, res) => {
    try {
        const usuarioId = req.user.id;
        const userRole = req.user.role; // 'admin', 'gestor', 'operador'

        let query = `
            SELECT s.*, 
                   v.placa, v.registroInterno as veiculo_nome, 
                   o.nome as obra_nome, 
                   p.razaoSocial as posto_nome,
                   u.name as solicitante_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            LEFT JOIN users u ON s.usuario_id = u.id
        `;

        const params = [];

        // Se for operador, vê apenas as suas. Se for admin/gestor, vê todas (ou filtra por status se quiser)
        if (userRole === 'operador' || (userRole !== 'admin' && !req.user.canAccessRefueling)) {
            query += ' WHERE s.usuario_id = ?';
            params.push(usuarioId);
        }

        query += ' ORDER BY s.data_solicitacao DESC LIMIT 100';

        const [rows] = await db.execute(query, params);
        res.json(rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
};

// --- AVALIAR (GESTOR) ---
const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivoNegativa } = req.body; // status: 'LIBERADO' ou 'NEGADO'
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [solicitacao] = await connection.execute('SELECT * FROM solicitacoes_abastecimento WHERE id = ?', [id]);
        if (solicitacao.length === 0) return res.status(404).json({ error: 'Solicitação não encontrada' });
        
        const sol = solicitacao[0];

        if (status === 'NEGADO') {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['NEGADO', motivoNegativa, req.user.id, id]
            );
            await connection.commit();
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            return res.json({ message: 'Solicitação negada.' });
        }

        if (status === 'LIBERADO') {
            // 1. Gera registro na tabela REFULEINGS (Legado/Principal)
            // Isso cria a "Ordem interna" que o sistema já conhece
            const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
            const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
            const newRefuelingId = crypto.randomUUID();

            // Busca nome do posto para persistir
            let partnerName = 'N/A';
            if (sol.posto_id) {
                const [p] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [sol.posto_id]);
                if (p.length > 0) partnerName = p[0].razaoSocial;
            }

            await connection.execute(
                `INSERT INTO refuelings (
                    id, authNumber, vehicleId, partnerId, partnerName, 
                    obraId, fuelType, data, status, 
                    isFillUp, litrosLiberados, 
                    odometro, horimetro, 
                    createdBy, createdFromSolicitacaoId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'Aberta', ?, ?, ?, ?, ?, ?)`,
                [
                    newRefuelingId, newAuthNumber, sol.veiculo_id, sol.posto_id, partnerName,
                    sol.obra_id, sol.tipo_combustivel, 
                    sol.flag_tanque_cheio, sol.litragem_solicitada,
                    sol.odometro_informado, sol.horimetro_informado,
                    JSON.stringify({ id: req.user.id, name: 'Via Solicitação' }), sol.id
                ]
            );

            await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

            // 2. Atualiza status da solicitação
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['LIBERADO', req.user.id, id]
            );

            await connection.commit();
            req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
            return res.json({ message: 'Solicitação liberada! Ordem gerada.', authNumber: newAuthNumber });
        }

    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ error: 'Erro ao avaliar solicitação.' });
    } finally {
        connection.release();
    }
};

// --- ENVIAR COMPROVANTE (OPERADOR) ---
const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto do cupom obrigatória.' });

        const fotoPath = `/uploads/solicitacoes/${req.file.filename}`;

        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "AGUARDANDO_BAIXA", foto_cupom_path = ? WHERE id = ?',
            [fotoPath, id]
        );

        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        // Avisar admin que tem baixa pendente
        req.io.emit('admin:notificacao', { tipo: 'baixa_pendente', id: id });

        res.json({ message: 'Comprovante enviado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

// --- CONFIRMAR BAIXA (GESTOR) ---
const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    const { litrosReais, valorTotal, nf } = req.body; // Opcional: atualizar valores reais se o admin digitar na baixa
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Busca a solicitação e a ordem vinculada (se houver lógica de vínculo direto, 
        // mas aqui usamos createdFromSolicitacaoId na tabela refuelings para achar)
        
        await connection.execute(
            'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?',
            [id]
        );

        // Opcional: Atualizar a ordem na tabela refuelings para 'Concluida' automaticamente?
        // O fluxo do prompt diz: "caso o responsável confira a NF... confirma a abastecida".
        // Isso sugere que o admin usa o modal de "Confirmar Abastecimento" padrão, que agora
        // pode puxar os dados dessa solicitação. 
        // Para simplificar este controller, apenas marcamos a solicitação como concluída. 
        // O Admin provavelmente usará a rota `refuelings/:id/confirm` padrão do sistema para fechar o financeiro,
        // usando a foto da solicitação como base.

        await connection.commit();
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada. Solicitação finalizada.' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    } finally {
        connection.release();
    }
};

// --- REJEITAR COMPROVANTE ---
const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        // Volta status para LIBERADO para que o usuário envie foto de novo
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', 
            [id]
        );
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado. Usuário notificado para reenvio.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar comprovante.' });
    }
};

const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ error: 'Usuário não encontrado' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Erro interno' });
    }
};

module.exports = {
    criarSolicitacao,
    listarSolicitacoes,
    avaliarSolicitacao,
    enviarComprovante,
    confirmarBaixa,
    rejeitarComprovante,
    verificarStatusUsuario,
    upload
};