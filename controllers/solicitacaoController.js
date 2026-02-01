// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- CONFIGURAÇÃO MULTER (Uploads Otimizados) ---
// As imagens já devem vir comprimidas do Frontend (Canvas), aqui apenas salvamos.
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Limite 5MB
});

// --- HELPERS ---
const safeNum = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// --- CORE: CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        
        // CORREÇÃO: Ler os campos em snake_case conforme enviado pelo FormData do Frontend
        const { 
            veiculo_id, 
            obra_id, 
            posto_id, 
            tipo_combustivel, 
            litragem, 
            flag_tanque_cheio, 
            flag_outros, 
            horimetro, 
            odometro, 
            latitude, 
            longitude 
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;

        // 1. Verificar Bloqueio do Usuário (Consulta Rápida)
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        
        if (!users.length || users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO ou inexistente. Contate o administrador.' });
        }

        // Validação se veiculo_id chegou
        if (!veiculo_id) {
            throw new Error("ID do veículo não informado.");
        }

        // 2. Verificar Regras de Leitura e Consistência
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculo_id]);
        
        if (vehicles.length === 0) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Veículo não encontrado no sistema.' });
        }

        const veiculo = vehicles[0];
        
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        // Suporte a legado: verifica horimetro normal ou digital
        const antHorimetro = safeNum(veiculo.horimetro || veiculo.horimetroDigital);

        // Validação Odômetro (se informado e maior que zero)
        if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) erroValidacao = `Odômetro menor que o anterior (${antOdometro} Km).`;
            else if ((novoOdometro - antOdometro) > 2000) erroValidacao = `Salto de Odômetro excessivo (>2000km). Verifique a digitação.`;
        }

        // Validação Horímetro (se informado e maior que zero)
        if (novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) erroValidacao = `Horímetro menor que o anterior (${antHorimetro} h).`;
            else if ((novoHorimetro - antHorimetro) > 100) erroValidacao = `Salto de Horímetro excessivo (>100h). Verifique a digitação.`;
        }

        // --- LÓGICA DE BLOQUEIO POR TENTATIVAS FALHAS ---
        if (erroValidacao) {
            const novasTentativas = users[0].tentativas_falhas_abastecimento + 1;
            let bloquear = 0;
            let msgBloqueio = '';

            if (novasTentativas >= 3) {
                bloquear = 1;
                msgBloqueio = ' USUÁRIO BLOQUEADO POR TENTATIVAS EXCEDIDAS.';
            }

            await connection.execute(
                'UPDATE users SET tentativas_falhas_abastecimento = ?, bloqueado_abastecimento = ? WHERE id = ?',
                [novasTentativas, bloquear, usuarioId]
            );
            
            await connection.commit();
            
            // Remove a foto enviada já que a solicitação falhou logicamente
            if (req.file) fs.unlinkSync(req.file.path);

            return res.status(400).json({ 
                error: `Erro de Leitura: ${erroValidacao} (Tentativa ${novasTentativas}/3).${msgBloqueio}` 
            });
        }

        // Se passou na validação, zera o contador de falhas
        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

        // 3. Trava Orçamentária (20% do Contrato)
        // FIX: Usamos SELECT * para evitar erro se a coluna 'valorContrato' não existir.
        const [obras] = await connection.execute('SELECT * FROM obras WHERE id = ?', [obra_id]);
        
        // Tenta localizar o valor do contrato em campos comuns ou assume 0 se não existir
        const obraData = obras[0] || {};
        const valorContratoEncontrado = obraData.valorContrato || obraData.valor_contrato || obraData.contractValue || 0;

        if (obras.length > 0 && safeNum(valorContratoEncontrado) > 0) {
            const valorContrato = parseFloat(valorContratoEncontrado);
            
            // Soma despesas já lançadas na categoria Combustível para esta obra
            const [expenses] = await connection.execute(
                "SELECT SUM(amount) as total FROM expenses WHERE obraId = ? AND category = 'Combustível'", 
                [obra_id]
            );
            const totalGasto = safeNum(expenses[0].total);
            
            // Estima o custo da solicitação atual
            let precoEst = 6.00; // Preço médio de segurança (fallback)
            if (posto_id) {
                const [precos] = await connection.execute('SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?', [posto_id, tipo_combustivel]);
                if (precos.length > 0) precoEst = safeNum(precos[0].price);
            }
            
            // Parse do flag
            const isTanqueCheio = (flag_tanque_cheio === '1' || flag_tanque_cheio === 'true' || flag_tanque_cheio === true);
            const litragemEstimada = isTanqueCheio ? 200 : safeNum(litragem);
            const custoEstimado = litragemEstimada * precoEst;
            
            // Verifica regra dos 20%
            if ((totalGasto + custoEstimado) > (valorContrato * 0.20)) {
                await connection.rollback();
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Limite orçamentário da obra excedido (20%). Solicitação bloqueada pelo sistema.' });
            }
        }

        const isTanqueCheio = (flag_tanque_cheio === '1' || flag_tanque_cheio === 'true' || flag_tanque_cheio === true);
        const isOutros = (flag_outros === '1' || flag_outros === 'true' || flag_outros === true);

        // 4. Análise de Queda de Média (>25%) - Gera Alerta mas NÃO bloqueia
        let alertaMedia = 0;
        
        // 5. Inserir Solicitação
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, 
            geo_latitude, geo_longitude, status, alerta_media_consumo, data_solicitacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', ?, NOW())`,
            [
                usuarioId, 
                veiculo_id, 
                obra_id, 
                posto_id || null, 
                tipo_combustivel,
                safeNum(litragem), 
                isTanqueCheio ? 1 : 0, 
                isOutros ? 1 : 0,
                novoHorimetro || null, 
                novoOdometro || null, 
                fotoPainel,
                latitude || null, 
                longitude || null, 
                alertaMedia
            ]
        );

        await connection.commit();
        
        // Notifica Admins via Socket (Emitir evento para todos os sockets conectados na sala 'admins')
        if (req.io) {
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            req.io.emit('admin:notificacao', { 
                tipo: 'nova_solicitacao', 
                msg: `Nova solicitação #${result.insertId} recebida.`,
                id: result.insertId 
            });
        }

        res.status(201).json({ message: 'Solicitação enviada! Aguarde a liberação.', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Criar Solicitação:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); // Limpa arquivo órfão
        res.status(500).json({ error: 'Erro ao processar solicitação: ' + error.message });
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

        // Operador vê apenas as suas. Admin/Gestor vê todas.
        const isGestor = userRole === 'admin' || userRole === 'gestor' || req.user.canAccessRefueling;

        if (!isGestor) {
            query += ' WHERE s.usuario_id = ?';
            params.push(usuarioId);
        }

        // Ordenação: Pendentes primeiro, depois por data
        query += ` ORDER BY 
            CASE WHEN s.status = 'PENDENTE' THEN 1 
                 WHEN s.status = 'AGUARDANDO_BAIXA' THEN 2 
                 ELSE 3 END, 
            s.data_solicitacao DESC LIMIT 100`;

        const [rows] = await db.execute(query, params);
        res.json(rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
};

// --- AVALIAR (GESTOR: LIBERAR OU NEGAR) ---
const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivoNegativa } = req.body; // status: 'LIBERADO' ou 'NEGADO'
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [solicitacao] = await connection.execute('SELECT * FROM solicitacoes_abastecimento WHERE id = ? FOR UPDATE', [id]);
        if (solicitacao.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const sol = solicitacao[0];

        if (status === 'NEGADO') {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['NEGADO', motivoNegativa, req.user.id, id]
            );
            
            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
            return res.json({ message: 'Solicitação negada.' });
        }

        if (status === 'LIBERADO') {
            const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
            const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
            const newRefuelingId = crypto.randomUUID();

            let partnerName = 'Posto Externo';
            if (sol.posto_id) {
                const [p] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [sol.posto_id]);
                if (p.length > 0) partnerName = p[0].razaoSocial;
            }

            // Criação da Ordem na tabela principal
            await connection.execute(
                `INSERT INTO refuelings (
                    id, authNumber, vehicleId, partnerId, partnerName, 
                    obraId, fuelType, data, status, 
                    isFillUp, litrosLiberados, 
                    odometro, horimetro, 
                    createdBy, createdFromSolicitacaoId, needsArla
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'Aberta', ?, ?, ?, ?, ?, ?, 0)`,
                [
                    newRefuelingId, newAuthNumber, sol.veiculo_id, sol.posto_id, partnerName,
                    sol.obra_id, sol.tipo_combustivel, 
                    sol.flag_tanque_cheio, sol.litragem_solicitada,
                    sol.odometro_informado, sol.horimetro_informado,
                    JSON.stringify({ id: req.user.id, name: req.user.name || 'Gestor' }), 
                    sol.id // Link importante para rastreabilidade
                ]
            );

            await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

            // 2. Atualiza status da solicitação
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['LIBERADO', req.user.id, id]
            );

            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
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

// --- ENVIAR COMPROVANTE (OPERADOR: CUPOM FISCAL) ---
const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto do cupom obrigatória.' });

        const fotoPath = `/uploads/solicitacoes/${req.file.filename}`;

        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "AGUARDANDO_BAIXA", foto_cupom_path = ? WHERE id = ?',
            [fotoPath, id]
        );

        if (req.io) {
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            req.io.emit('admin:notificacao', { 
                tipo: 'baixa_pendente', 
                msg: `Comprovante enviado para solicitação #${id}.`,
                id: id 
            });
        }

        res.json({ message: 'Comprovante enviado. Aguardando confirmação do gestor.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

// --- CONFIRMAR BAIXA (GESTOR) ---
const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?',
            [id]
        );
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada. Processo finalizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

// --- REJEITAR COMPROVANTE (GESTOR) ---
const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', 
            [id]
        );
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado. Operador notificado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar comprovante.' });
    }
};

// --- STATUS DO USUÁRIO ---
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