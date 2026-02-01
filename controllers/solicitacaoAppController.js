const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

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
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// --- HELPERS ---
const safeNum = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

const normalizeFuelType = (val) => {
    if (!val) return null;
    const v = val.toString().trim().toUpperCase();
    const map = {
        'DIESEL S10': 'dieselS10',
        'DIESEL S500': 'dieselS500',
        'GASOLINA COMUM': 'gasolinaComum',
        'GASOLINA ADITIVADA': 'gasolinaAditivada',
        'ETANOL': 'etanol',
        'ARLA 32': 'arla32'
    };
    return map[v] || val;
};

// --- FUNÇÕES ---

const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        
        const { 
            veiculo_id, obra_id, posto_id, funcionario_id, 
            tipo_combustivel, litragem, flag_tanque_cheio, 
            flag_outros, descricao_outros, horimetro, odometro, 
            latitude, longitude, observacao,
            data_abastecimento // Data manual vinda do front
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;
        const tipoCombustivelNormalizado = normalizeFuelType(tipo_combustivel);

        // 1. Validar Veículo ID
        if (!veiculo_id) throw new Error("ID do veículo não informado.");
        
        // 2. VERIFICAÇÃO DE PEDIDO EM ABERTO (BLOQUEANTE)
        // Não permite criar novo se existir um Pendente, Liberado ou Aguardando Baixa para o mesmo veículo
        const [pedidosAbertos] = await connection.execute(
            `SELECT id, status, data_solicitacao FROM solicitacoes_abastecimento 
             WHERE veiculo_id = ? 
             AND status IN ('PENDENTE', 'LIBERADO', 'AGUARDANDO_BAIXA')`, 
            [veiculo_id]
        );

        if (pedidosAbertos.length > 0) {
            const ped = pedidosAbertos[0];
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                error: `BLOQUEIO: Já existe o pedido #${ped.id} (${ped.status}) em aberto para este veículo desde ${new Date(ped.data_solicitacao).toLocaleDateString()}. Finalize-o antes.` 
            });
        }

        // 3. Buscar Dados do Veículo (para validações de status)
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculo_id]);
        if (vehicles.length === 0) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Veículo não encontrado.' });
        }
        const veiculo = vehicles[0];

        // 4. Validar Status do Veículo (Manutenção/Quebrado)
        if (['manutencao', 'MANUTENCAO', 'quebrado', 'QUEBRADO'].includes(veiculo.status)) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: `VEÍCULO BLOQUEADO: Status atual é ${veiculo.status}. Contate a oficina.` });
        }

        // 5. Validar Bloqueio Usuário
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        if (!users.length || users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO POR ERROS REPETIDOS. Contate o administrador.' });
        }

        // 6. Validação Leitura (Simples checagem de regressão no backend)
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        const antHorimetro = safeNum(veiculo.horimetro || veiculo.horimetroDigital);

        if (novoOdometro > 0 && novoOdometro <= antOdometro) {
            erroValidacao = `Odômetro informado (${novoOdometro}) é menor ou igual ao atual (${antOdometro}).`;
        }
        if (novoHorimetro > 0 && novoHorimetro <= antHorimetro) {
            erroValidacao = `Horímetro informado (${novoHorimetro}) é menor ou igual ao atual (${antHorimetro}).`;
        }

        if (erroValidacao) {
            const novasTentativas = users[0].tentativas_falhas_abastecimento + 1;
            const bloquear = novasTentativas >= 3 ? 1 : 0;
            
            await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = ?, bloqueado_abastecimento = ? WHERE id = ?', [novasTentativas, bloquear, usuarioId]);
            await connection.commit();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: `ERRO DE LEITURA: ${erroValidacao} (Erro ${novasTentativas}/3). Cuidado!` });
        }

        // Resetar tentativas se deu certo
        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

        // 7. Data Efetiva
        // Se o usuário não enviou data (campo vazio), usa NOW().
        const dataEfetiva = data_abastecimento ? new Date(data_abastecimento) : new Date();

        // 8. Inserir
        let obsFinal = observacao || '';
        const isOutros = (flag_outros === '1' || flag_outros === 'true' || flag_outros === true);
        if (isOutros && descricao_outros) {
            obsFinal = `[Item: ${descricao_outros}] ${obsFinal}`;
        }
        
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, 
            geo_latitude, geo_longitude, status, alerta_media_consumo, data_solicitacao, observacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', 0, ?, ?)`,
            [
                usuarioId, veiculo_id, obra_id, posto_id || null, funcionario_id || null, 
                tipoCombustivelNormalizado, safeNum(litragem), 
                (flag_tanque_cheio === '1' || flag_tanque_cheio === 'true') ? 1 : 0, 
                isOutros ? 1 : 0, novoHorimetro || null, novoOdometro || null, fotoPainel,
                latitude || null, longitude || null, dataEfetiva, obsFinal
            ]
        );

        await connection.commit();
        
        if (req.io) {
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            req.io.emit('admin:notificacao', { tipo: 'nova_solicitacao', id: result.insertId });
        }

        res.status(201).json({ message: 'Solicitação enviada!', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Criar Solicitacao App:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro no servidor: ' + error.message });
    } finally {
        connection.release();
    }
};

const listarMinhasSolicitacoes = async (req, res) => {
    try {
        const usuarioId = req.user.id;
        const query = `
            SELECT s.*, 
                   v.placa, v.registroInterno as veiculo_nome, 
                   o.nome as obra_nome, 
                   p.razaoSocial as posto_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            WHERE s.usuario_id = ?
            ORDER BY s.data_solicitacao DESC LIMIT 50
        `;
        const [rows] = await db.execute(query, [usuarioId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar minhas solicitações.' });
    }
};

const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto obrigatória.' });
        const fotoPath = `/uploads/solicitacoes/${req.file.filename}`;
        
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "AGUARDANDO_BAIXA", foto_cupom_path = ? WHERE id = ?', [fotoPath, id]);
        
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante enviado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: 'Usuário não encontrado' });
    } catch (e) {
        res.status(500).json({ error: 'Erro interno' });
    }
};

module.exports = {
    criarSolicitacao,
    listarMinhasSolicitacoes,
    enviarComprovante,
    verificarStatusUsuario,
    upload
};