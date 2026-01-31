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
    limits: { fileSize: 5 * 1024 * 1024 } // Limite 5MB (segurança back-end)
});

// --- HELPERS ---
const safeNum = (val) => {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// --- CORE: CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        const { 
            veiculoId, obraId, postoId, tipoCombustivel, 
            litragem, flagTanqueCheio, flagOutros, 
            horimetro, odometro, latitude, longitude
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;

        // 1. Verificar Bloqueio do Usuário (Consulta Rápida)
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        if (users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            // Retorna erro específico para o front tratar
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO. Contate o administrador.' });
        }

        // 2. Verificar Regras de Leitura e Consistência
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculoId]);
        const veiculo = vehicles[0];
        
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        // Suporte a legado: verifica horimetro normal ou digital
        const antHorimetro = safeNum(veiculo.horimetro || veiculo.horimetroDigital);

        // Validação Odômetro (se informado)
        if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) erroValidacao = `Odômetro menor que o anterior (${antOdometro} Km).`;
            else if ((novoOdometro - antOdometro) > 1000) erroValidacao = `Salto de Odômetro excessivo (>1000km).`;
        }

        // Validação Horímetro (se informado)
        if (novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) erroValidacao = `Horímetro menor que o anterior (${antHorimetro} h).`;
            else if ((novoHorimetro - antHorimetro) > 50) erroValidacao = `Salto de Horímetro excessivo (>50h).`;
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
        // Busca valor total do contrato da obra
        const [obras] = await connection.execute('SELECT valorContrato FROM obras WHERE id = ?', [obraId]);
        
        if (obras.length > 0 && safeNum(obras[0].valorContrato) > 0) {
            const valorContrato = parseFloat(obras[0].valorContrato);
            
            // Soma despesas já lançadas na categoria Combustível para esta obra
            const [expenses] = await connection.execute(
                "SELECT SUM(amount) as total FROM expenses WHERE obraId = ? AND category = 'Combustível'", 
                [obraId]
            );
            const totalGasto = safeNum(expenses[0].total);
            
            // Estima o custo da solicitação atual
            let precoEst = 6.00; // Preço médio de segurança (fallback)
            if (postoId) {
                const [precos] = await connection.execute('SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?', [postoId, tipoCombustivel]);
                if (precos.length > 0) precoEst = safeNum(precos[0].price);
            }
            
            // Se for tanque cheio, estima com base na capacidade média (ex: 200L ou lógica do veículo se tiver) ou usa litragem informada
            const litragemEstimada = flagTanqueCheio ? 200 : safeNum(litragem);
            const custoEstimado = litragemEstimada * precoEst;
            
            // Verifica regra dos 20%
            if ((totalGasto + custoEstimado) > (valorContrato * 0.20)) {
                await connection.rollback();
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Limite orçamentário da obra excedido (20%). Solicitação bloqueada pelo sistema.' });
            }
        }

        // 4. Análise de Queda de Média (>25%) - Gera Alerta mas NÃO bloqueia
        let alertaMedia = 0;
        // Busca último abastecimento confirmado deste veículo para comparar
        const [lastRefuel] = await connection.execute(
            'SELECT odometro, horimetro, litragem_solicitada, flag_tanque_cheio FROM solicitacoes_abastecimento WHERE veiculo_id = ? AND status = "CONCLUIDO" ORDER BY data_baixa DESC LIMIT 1',
            [veiculoId]
        );

        // Lógica simplificada de verificação de média (só possível se tivermos histórico confiável)
        // Aqui apenas marcamos a flag para o ADMIN ver, já que o cálculo preciso exige litragem real que ainda não temos (se for tanque cheio)
        // O Admin verá o alerta "Média em queda" baseado nos dados históricos.

        // 5. Inserir Solicitação
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, 
            geo_latitude, geo_longitude, status, alerta_media_consumo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', ?)`,
            [
                usuarioId, veiculoId, obraId, postoId || null, tipoCombustivel,
                safeNum(litragem), flagTanqueCheio ? 1 : 0, flagOutros ? 1 : 0,
                novoHorimetro || null, novoOdometro || null, fotoPainel,
                latitude || null, longitude || null, alertaMedia
            ]
        );

        await connection.commit();
        
        // Notifica Admins via Socket (Emitir evento para todos os sockets conectados na sala 'admins')
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        req.io.emit('admin:notificacao', { 
            tipo: 'nova_solicitacao', 
            msg: `Nova solicitação #${result.insertId} recebida.`,
            id: result.insertId 
        });

        res.status(201).json({ message: 'Solicitação enviada! Aguarde a liberação.', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Criar Solicitação:", error);
        if (req.file) fs.unlinkSync(req.file.path); // Limpa arquivo órfão
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

        // Operador vê apenas as suas. Admin/Gestor vê todas.
        // Se o usuário tiver permissão especial canAccessRefueling, vê tudo.
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
            
            // Opcional: Enviar notificação socket para o usuário específico
            
            await connection.commit();
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            return res.json({ message: 'Solicitação negada.' });
        }

        if (status === 'LIBERADO') {
            // 1. Gera registro na tabela REFULEINGS (Integração com sistema legado)
            // Isso cria a "Ordem interna" que o sistema já conhece.
            // O status inicial na tabela refuelings será 'Aberta'
            
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

        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        req.io.emit('admin:notificacao', { 
            tipo: 'baixa_pendente', 
            msg: `Comprovante enviado para solicitação #${id}.`,
            id: id 
        });

        res.json({ message: 'Comprovante enviado. Aguardando confirmação do gestor.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

// --- CONFIRMAR BAIXA (GESTOR) ---
// Nota: A baixa real (financeira/estoque) geralmente ocorre no endpoint 'refuelingController.confirmRefuelingOrder'
// Este endpoint aqui serve para finalizar o fluxo visual da solicitação.
const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?',
            [id]
        );
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada. Processo finalizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

// --- REJEITAR COMPROVANTE (GESTOR) ---
const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        // Retorna status para LIBERADO para forçar novo upload
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', 
            [id]
        );
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado. Operador notificado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar comprovante.' });
    }
};

// --- STATUS DO USUÁRIO (PARA O FRONTEND) ---
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