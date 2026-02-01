// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- CONFIGURAÇÃO MULTER (UPLOAD COM AUTO-LIMPEZA) ---

// Função para limpar arquivos antigos (> 30 dias)
const cleanupOldFiles = (directory) => {
    fs.readdir(directory, (err, files) => {
        if (err) return console.error("Erro ao ler diretório para limpeza:", err);

        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias em milissegundos

        files.forEach(file => {
            const filePath = path.join(directory, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, (err) => {
                        if (err) console.error(`Erro ao deletar arquivo antigo ${file}:`, err);
                    });
                }
            });
        });
    });
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Executa limpeza ao salvar novo arquivo
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
    limits: { fileSize: 5 * 1024 * 1024 } // Limite 5MB
});

// --- HELPERS ---
const safeNum = (val) => {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

// --- NOVO MÉTODO: OBTER CONTEXTO DO USUÁRIO (Filtragem de Obra/Veículos) ---
const getContextoUsuario = async (req, res) => {
    const userId = req.user.id; // Do middleware de auth

    try {
        // 1. Descobrir EmployeeID do Usuário
        const [users] = await db.execute('SELECT employeeId, name FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        
        const userEmployeeId = users[0].employeeId;
        
        if (!userEmployeeId) {
            return res.status(400).json({ 
                error: 'Usuário sem funcionário vinculado.',
                details: 'Seu usuário não está ligado a um cadastro de funcionário (RH). Contate o suporte.'
            });
        }

        // 2. Descobrir Obra Atual
        // Lógica: Tabela obras_historico_veiculos onde employeeId match E dataSaida IS NULL
        const queryObra = `
            SELECT DISTINCT ohv.obraId, o.nome as obraNome
            FROM obras_historico_veiculos ohv
            JOIN obras o ON ohv.obraId = o.id
            WHERE ohv.employeeId = ? 
            AND ohv.dataSaida IS NULL
            LIMIT 1
        `;

        const [obraRows] = await db.execute(queryObra, [userEmployeeId]);

        if (obraRows.length === 0) {
            return res.status(404).json({ 
                error: 'Sem Obra Alocada',
                details: 'Não encontramos veículos vinculados ao seu usuário nesta obra.'
            });
        }

        const currentObra = obraRows[0];

        // 3. Buscar Veículos desta Obra
        const queryVehicles = `
            SELECT 
                v.id, v.placa, v.modelo, v.grupo, v.tipo, 
                v.horimetro, -- Coluna unificada (Regra 8)
                v.proximaRevisaoKm, v.proximaRevisaoHoras, v.proximaRevisaoData,
                v.validadeTacografo, v.validadeAET_DAER, v.validadeAET_DNIT, v.validadeLicenciamento,
                v.status,
                (SELECT partnerId FROM refuelings WHERE vehicleId = v.id ORDER BY data DESC LIMIT 1) as lastPartnerId
            FROM vehicles v
            JOIN obras_historico_veiculos ohv ON v.id = ohv.vehicleId
            WHERE ohv.obraId = ? 
            AND ohv.dataSaida IS NULL
            ORDER BY v.placa ASC
        `;
        
        const [vehicles] = await db.execute(queryVehicles, [currentObra.obraId]);

        // 4. Buscar Funcionários desta Obra (para seleção no combo)
        const queryEmployees = `
            SELECT DISTINCT e.id, e.name, e.jobTitle, e.cnhExpirationDate
            FROM employees e
            JOIN obras_historico_veiculos ohv ON e.id = ohv.employeeId
            WHERE ohv.obraId = ?
            AND ohv.dataSaida IS NULL
            ORDER BY e.name ASC
        `;

        const [employees] = await db.execute(queryEmployees, [currentObra.obraId]);

        // Retorna o pacote completo
        res.json({
            obra: currentObra,
            vehicles: vehicles,
            employees: employees, 
            currentUserEmployeeId: userEmployeeId
        });

    } catch (error) {
        console.error('Erro ao buscar contexto:', error);
        res.status(500).json({ error: 'Erro interno ao carregar contexto de obra.' });
    }
};

// --- VERIFICAR STATUS DO USUÁRIO (Restauração) ---
const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ error: 'Usuário não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro ao verificar status' });
    }
};

// --- CORE: CRIAR SOLICITAÇÃO ---
const criarSolicitacao = async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const { 
            veiculoId, 
            obraId, 
            postoId, 
            funcionarioId, 
            tipo_combustivel, 
            litragem_solicitada, 
            leitura_atual, 
            observacao 
        } = req.body;

        // Validação básica
        if (!veiculoId || !obraId || !postoId || !tipo_combustivel) {
            throw new Error('Campos obrigatórios faltando.');
        }

        // Validação de Leitura no Backend (Segurança Adicional)
        const [vehRows] = await conn.execute('SELECT horimetro, grupo, tipo FROM vehicles WHERE id = ? FOR UPDATE', [veiculoId]);
        
        // Aqui confiamos no bloqueio do Frontend (senha de supervisor), mas salvamos o registro PENDENTE para auditoria.

        const [result] = await conn.execute(`
            INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel, litragem_solicitada, leitura_atual, observacao, status, data_solicitacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', NOW())
        `, [
            req.user.id, 
            veiculoId, 
            obraId, 
            postoId, 
            funcionarioId || null, 
            tipo_combustivel, 
            safeNum(litragem_solicitada), 
            safeNum(leitura_atual), 
            observacao
        ]);

        const solicitacaoId = result.insertId;

        await conn.commit();
        
        req.io.emit('server:sync', { targets: ['admin_solicitacoes'] });
        
        res.status(201).json({ 
            message: 'Solicitação criada com sucesso!', 
            id: solicitacaoId 
        });

    } catch (error) {
        await conn.rollback();
        console.error('Erro criarSolicitacao:', error);
        res.status(500).json({ error: error.message || 'Erro ao processar solicitação.' });
    } finally {
        conn.release();
    }
};

// --- LISTAR MINHAS SOLICITAÇÕES ---
const listarMinhasSolicitacoes = async (req, res) => {
    try {
        const query = `
            SELECT s.*, 
                v.placa as veiculo_placa, v.modelo as veiculo_modelo,
                o.nome as obra_nome,
                p.name as posto_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            WHERE s.usuario_id = ?
            ORDER BY s.data_solicitacao DESC
            LIMIT 50
        `;
        const [rows] = await db.execute(query, [req.user.id]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
};

// --- ENVIAR CUPOM (UPLOAD) ---
const enviarCupom = async (req, res) => {
    upload.single('cupom')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        
        const { id } = req.params; 
        if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });

        try {
            const imagePath = `/uploads/solicitacoes/${req.file.filename}`;
            
            await db.execute(
                'UPDATE solicitacoes_abastecimento SET comprovante_path = ?, status = "AGUARDANDO_BAIXA" WHERE id = ?',
                [imagePath, id]
            );

            req.io.emit('server:sync', { targets: ['admin_solicitacoes'] });
            res.json({ message: 'Comprovante enviado com sucesso!', path: imagePath });

        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Erro ao salvar comprovante.' });
        }
    });
};

// --- REJEITAR COMPROVANTE (Restauração) ---
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

// --- CONFIRMAR BAIXA (Restauração) ---
const confirmarBaixa = async (req, res) => {
    // Esta função geralmente é chamada pelo Admin, mas estava no arquivo enviado
    const { id } = req.params;
    try {
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO" WHERE id = ?',
            [id]
        );
        req.io.emit('server:sync', { targets: ['solicitacoes', 'admin_solicitacoes'] });
        res.json({ message: 'Baixa confirmada. Processo finalizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

module.exports = {
    upload, // ADICIONADO AQUI PARA CORRIGIR O ERRO NAS ROTAS
    getContextoUsuario,
    verificarStatusUsuario,
    criarSolicitacao,
    listarMinhasSolicitacoes,
    enviarCupom,
    rejeitarComprovante,
    confirmarBaixa
};