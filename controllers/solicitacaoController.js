// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// --- CONFIGURAÇÃO MULTER (UPLOAD COM AUTO-LIMPEZA) ---
// Função para limpar arquivos antigos (> 30 dias)
const cleanupOldFiles = (directory) => {
    fs.readdir(directory, (err, files) => {
        if (err) return console.error("Erro ao ler diretório para limpeza:", err);
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000;
        files.forEach(file => {
            const filePath = path.join(directory, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, (err) => {});
                }
            });
        });
    });
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cleanupOldFiles(dir);
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
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// --- [NOVO] OBTER CONTEXTO (Obra/Veículos/Funcionários) ---
const getContextoUsuario = async (req, res) => {
    const userId = req.user.id;
    try {
        const [users] = await db.execute('SELECT employeeId, name FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        
        const userEmployeeId = users[0].employeeId;
        if (!userEmployeeId) return res.status(400).json({ error: 'Usuário sem funcionário vinculado.' });

        const queryObra = `
            SELECT DISTINCT ohv.obraId, o.nome as obraNome
            FROM obras_historico_veiculos ohv
            JOIN obras o ON ohv.obraId = o.id
            WHERE ohv.employeeId = ? AND ohv.dataSaida IS NULL
            LIMIT 1
        `;
        const [obraRows] = await db.execute(queryObra, [userEmployeeId]);
        if (obraRows.length === 0) return res.status(404).json({ error: 'Sem Obra Alocada', details: 'Não encontramos veículos vinculados.' });

        const currentObra = obraRows[0];

        const queryVehicles = `
            SELECT v.id, v.placa, v.modelo, v.grupo, v.tipo, v.horimetro, 
                   v.proximaRevisaoKm, v.proximaRevisaoHoras, v.proximaRevisaoData,
                   v.validadeTacografo, v.validadeAET_DAER, v.validadeAET_DNIT, v.validadeLicenciamento, v.status,
                   (SELECT partnerId FROM refuelings WHERE vehicleId = v.id ORDER BY data DESC LIMIT 1) as lastPartnerId
            FROM vehicles v
            JOIN obras_historico_veiculos ohv ON v.id = ohv.vehicleId
            WHERE ohv.obraId = ? AND ohv.dataSaida IS NULL
            ORDER BY v.placa ASC
        `;
        const [vehicles] = await db.execute(queryVehicles, [currentObra.obraId]);

        const queryEmployees = `
            SELECT DISTINCT e.id, e.name, e.jobTitle
            FROM employees e
            JOIN obras_historico_veiculos ohv ON e.id = ohv.employeeId
            WHERE ohv.obraId = ? AND ohv.dataSaida IS NULL
            ORDER BY e.name ASC
        `;
        const [employees] = await db.execute(queryEmployees, [currentObra.obraId]);

        res.json({
            obra: currentObra,
            vehicles: vehicles,
            employees: employees, 
            currentUserEmployeeId: userEmployeeId
        });
    } catch (error) {
        console.error('Erro contexto:', error);
        res.status(500).json({ error: 'Erro ao carregar contexto.' });
    }
};

// --- [GET] STATUS USUÁRIO ---
const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: 'Usuário não encontrado' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao verificar status' });
    }
};

// --- [POST] CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const { veiculoId, obraId, postoId, funcionarioId, tipo_combustivel, litragem_solicitada, leitura_atual, observacao } = req.body;

        if (!veiculoId || !obraId || !postoId || !tipo_combustivel) throw new Error('Campos obrigatórios faltando.');

        // Se a rota usar upload.single('foto_painel') e enviar arquivo, ele estaria em req.file
        // Mas nossa nova lógica usa upload separado de cupom. Mantemos compatibilidade ignorando req.file aqui se não for usado.

        const [result] = await conn.execute(`
            INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel, litragem_solicitada, leitura_atual, observacao, status, data_solicitacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', NOW())
        `, [
            req.user.id, veiculoId, obraId, postoId, funcionarioId || null, tipo_combustivel, 
            safeNum(litragem_solicitada), safeNum(leitura_atual), observacao
        ]);

        await conn.commit();
        req.io.emit('server:sync', { targets: ['admin_solicitacoes'] });
        res.status(201).json({ message: 'Solicitação criada!', id: result.insertId });

    } catch (error) {
        await conn.rollback();
        console.error('Erro criarSolicitacao:', error);
        res.status(500).json({ error: error.message || 'Erro ao processar solicitação.' });
    } finally {
        conn.release();
    }
};

// --- [GET] LISTAR TODAS (ADMIN) ---
// Essencial para a rota router.get('/', ...) funcionar
const listarSolicitacoes = async (req, res) => {
    try {
        const query = `
            SELECT s.*, v.placa as veiculo_placa, v.modelo as veiculo_modelo, o.nome as obra_nome, 
                   p.name as posto_nome, u.name as usuario_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            LEFT JOIN users u ON s.usuario_id = u.id
            ORDER BY s.data_solicitacao DESC LIMIT 100
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
};

// --- [GET] LISTAR MINHAS (OPERADOR) ---
const listarMinhasSolicitacoes = async (req, res) => {
    try {
        const query = `
            SELECT s.*, v.placa as veiculo_placa, v.modelo as veiculo_modelo, o.nome as obra_nome, p.name as posto_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            WHERE s.usuario_id = ?
            ORDER BY s.data_solicitacao DESC LIMIT 50
        `;
        const [rows] = await db.execute(query, [req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar histórico.' });
    }
};

// --- [PUT] ATUALIZAR/AVALIAR (ADMIN) ---
// Essencial para a rota router.put('/:id', ...) funcionar
const atualizarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivo_negativa } = req.body;
    try {
        const updates = [];
        const values = [];

        if (status) {
            updates.push('status = ?');
            values.push(status);
            if (status === 'AUTORIZADO') updates.push('data_aprovacao = NOW()');
        }
        if (motivo_negativa !== undefined) {
            updates.push('motivo_negativa = ?');
            values.push(motivo_negativa);
        }

        if (updates.length > 0) {
            values.push(id);
            await db.execute(`UPDATE solicitacoes_abastecimento SET ${updates.join(', ')} WHERE id = ?`, values);
            req.io.emit('server:sync', { targets: ['solicitacoes', 'admin_solicitacoes'] });
            res.json({ message: 'Solicitação atualizada.' });
        } else {
            res.status(400).json({ error: 'Nada para atualizar.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar solicitação.' });
    }
};

// --- [POST] ENVIAR CUPOM ---
const enviarCupom = async (req, res) => {
    upload.single('cupom')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        const { id } = req.params; 
        if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });

        try {
            const imagePath = `/uploads/solicitacoes/${req.file.filename}`;
            await db.execute('UPDATE solicitacoes_abastecimento SET comprovante_path = ?, status = "AGUARDANDO_BAIXA" WHERE id = ?', [imagePath, id]);
            req.io.emit('server:sync', { targets: ['admin_solicitacoes'] });
            res.json({ message: 'Comprovante enviado!', path: imagePath });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao salvar comprovante.' });
        }
    });
};

const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', [id]);
        req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro.' });
    }
};

const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO" WHERE id = ?', [id]);
        req.io.emit('server:sync', { targets: ['solicitacoes', 'admin_solicitacoes'] });
        res.json({ message: 'Baixa confirmada.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro.' });
    }
};

// --- EXPORTAÇÕES (CRÍTICO: Inclui Upload e Aliases para Rotas) ---
module.exports = {
    // Middleware necessário para router.post('/', upload.single(...))
    upload,
    
    // Funções principais
    getContextoUsuario,
    verificarStatusUsuario,
    criarSolicitacao,
    
    // Funções de Listagem (necessário para router.get('/'))
    listarSolicitacoes,
    listarMinhasSolicitacoes,
    
    // Funções de Edição (necessário para router.put('/:id'))
    atualizarSolicitacao,
    
    // Aliases para garantir compatibilidade se a rota usar nomes diferentes
    updateSolicitacao: atualizarSolicitacao,
    editSolicitacao: atualizarSolicitacao,
    aprovarSolicitacao: atualizarSolicitacao,
    
    // Outras ações
    enviarCupom,
    rejeitarComprovante,
    confirmarBaixa
};