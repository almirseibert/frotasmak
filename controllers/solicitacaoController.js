// controllers/solicitacaoController.js
const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// --- CONFIGURAÇÃO MULTER (Uploads Otimizados) ---
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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --- HELPERS ---
const safeNum = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    const strVal = String(val).replace(',', '.');
    const n = parseFloat(strVal);
    return isNaN(n) ? 0 : n;
};

// --- 1. CRIAR SOLICITAÇÃO (Corrigido para evitar erro 500) ---
const criarSolicitacao = async (req, res) => {
    let connection;
    try {
        console.log('--- Nova Solicitação ---', req.body);

        const {
            veiculo_id, obra_id, posto_id, funcionario_id,
            tipo_combustivel, litragem, 
            flag_tanque_cheio, flag_outros, descricao_outros,
            horimetro, odometro,
            latitude, longitude, observacao
        } = req.body;

        if (!req.file) return res.status(400).json({ error: 'Foto do painel obrigatória.' });
        const foto_painel_path = req.file.filename;

        // Validação
        if (!veiculo_id || !obra_id || !posto_id || !funcionario_id) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        // Inserção Segura
        const query = `
            INSERT INTO solicitacoes_abastecimento (
                veiculo_id, obra_id, posto_id, funcionario_id,
                tipo_combustivel, litragem_solicitada, 
                flag_tanque_cheio, flag_outros, descricao_outros,
                horimetro, odometro,
                latitude, longitude, observacao,
                foto_painel_path, data_solicitacao, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDENTE')
        `;

        const values = [
            veiculo_id, obra_id, posto_id, funcionario_id,
            tipo_combustivel, 
            safeNum(litragem),
            String(flag_tanque_cheio) === '1' ? 1 : 0, 
            String(flag_outros) === '1' ? 1 : 0, 
            descricao_outros || '',
            safeNum(horimetro), safeNum(odometro),
            latitude || '0', longitude || '0', 
            observacao || '',
            foto_painel_path
        ];

        const [result] = await connection.execute(query, values);
        await connection.commit();

        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });

        res.status(201).json({ message: 'Solicitação enviada.', id: result.insertId });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Erro criarSolicitacao:', error);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch(e){}
        res.status(500).json({ error: 'Erro ao processar solicitação.' });
    } finally {
        if (connection) connection.release();
    }
};

// --- 2. LISTAR SOLICITAÇÕES ---
const listarSolicitacoes = async (req, res) => {
    try {
        // Query com Joins para trazer nomes legíveis
        const [rows] = await db.execute(`
            SELECT s.*, 
                   v.placa, v.modelo as veiculo_nome,
                   o.nome as obra_nome,
                   p.razaoSocial as posto_nome,
                   u.name as funcionario_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            LEFT JOIN users u ON s.funcionario_id = u.id
            ORDER BY s.data_solicitacao DESC
            LIMIT 100
        `);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar.' });
    }
};

// --- 3. AVALIAR SOLICITAÇÃO (GESTOR) ---
const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivo_negativa, litros_liberados, litros_liberados_arla } = req.body;
    
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Atualizar Status da Solicitação
        let updateQuery = 'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?';
        const params = [status, motivo_negativa || null];

        if (status === 'LIBERADO') {
            updateQuery += ', litragem_liberada = ?, litragem_liberada_arla = ?';
            params.push(safeNum(litros_liberados), safeNum(litros_liberados_arla));
        }
        
        updateQuery += ' WHERE id = ?';
        params.push(id);

        await connection.execute(updateQuery, params);

        // 2. Se aprovado, criar pré-ordem na tabela 'refuelings' (Opcional, mas recomendado)
        if (status === 'LIBERADO') {
            const [solicitacao] = await connection.execute('SELECT * FROM solicitacoes_abastecimento WHERE id = ?', [id]);
            const sol = solicitacao[0];

            if (sol) {
                await connection.execute(`
                    INSERT INTO refuelings (
                        vehicleId, driverId, obraId, partnerId,
                        fuelType, expectedLiters, 
                        odometer, hourMeter,
                        status, createdFromSolicitacaoId, date
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NOW())
                `, [
                    sol.veiculo_id, sol.funcionario_id, sol.obra_id, sol.posto_id,
                    sol.tipo_combustivel, safeNum(litros_liberados) || sol.litragem_solicitada,
                    sol.odometro, sol.horimetro,
                    id
                ]);
            }
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
        res.json({ message: `Solicitação ${status.toLowerCase()}.` });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error(error);
        res.status(500).json({ error: 'Erro ao avaliar solicitação.' });
    } finally {
        if (connection) connection.release();
    }
};

// --- 4. ENVIAR COMPROVANTE (OPERADOR) ---
const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Foto do comprovante obrigatória.' });

    try {
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET foto_cupom_path = ?, status = "CONCLUIDO" WHERE id = ?',
            [req.file.filename, id]
        );
        
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante enviado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao salvar comprovante.' });
    }
};

// --- 5. CONFIRMAR BAIXA (GESTOR) ---
const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Finaliza a solicitação
        await connection.execute(
            'UPDATE solicitacoes_abastecimento SET status = "FINALIZADO" WHERE id = ?', 
            [id]
        );

        // Finaliza a ordem de abastecimento associada (se houver)
        await connection.execute(
            'UPDATE refuelings SET status = "CONFIRMED" WHERE createdFromSolicitacaoId = ?', 
            [id]
        );

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
        res.json({ message: 'Baixa confirmada. Ciclo encerrado.' });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error(error);
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    } finally {
        if (connection) connection.release();
    }
};

// --- 6. REJEITAR COMPROVANTE (GESTOR) ---
const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        // Retorna status para LIBERADO para que o motorista possa enviar a foto novamente
        await db.execute(
            'UPDATE solicitacoes_abastecimento SET status = "LIBERADO", foto_cupom_path = NULL WHERE id = ?', 
            [id]
        );
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado. Solicitado reenvio.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao rejeitar comprovante.' });
    }
};

// --- 7. VERIFICAR STATUS DO USUÁRIO ---
const verificarStatusUsuario = async (req, res) => {
    try {
        // Se o usuario não estiver logado ou req.user não existir, retorna padrão limpo
        if (!req.user || !req.user.id) {
            return res.json({ bloqueado_abastecimento: 0, tentativas: 0 });
        }

        const [rows] = await db.execute(
            'SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', 
            [req.user.id]
        );
        
        if (rows.length > 0) {
            res.json({
                bloqueado_abastecimento: rows[0].bloqueado_abastecimento,
                tentativas_falhas_abastecimento: rows[0].tentativas_falhas_abastecimento
            });
        } else {
            res.json({ bloqueado_abastecimento: 0, tentativas: 0 });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao verificar status.' });
    }
};

module.exports = {
    upload,
    criarSolicitacao,
    listarSolicitacoes,
    avaliarSolicitacao,
    enviarComprovante,
    confirmarBaixa,
    rejeitarComprovante,
    verificarStatusUsuario
};