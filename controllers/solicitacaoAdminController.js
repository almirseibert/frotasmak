const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const whatsappService = require('../services/whatsappService');
const { criarOrdem } = require('./refuelingController');

// --- CONFIGURAÇÃO MULTER E LIMPEZA (Copiado de refuelingController) ---

// Função para limpar arquivos antigos (> 30 dias)
const cleanupOldFiles = (directory) => {
    fs.readdir(directory, (err, files) => {
        if (err) return console.error("Erro ao ler diretório para limpeza:", err);

        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias

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

const storagePdf = multer.diskStorage({
    destination: (req, file, cb) => {
        // Caminho absoluto para garantir compatibilidade
        const dir = path.join(__dirname, '../public/uploads/orders');
        
        // Garante que a pasta existe
        if (!fs.existsSync(dir)) {
            console.log("Criando diretório de ordens:", dir);
            fs.mkdirSync(dir, { recursive: true });
        }

        // Executa limpeza assíncrona (igual ao refuelingController)
        cleanupOldFiles(dir);

        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Garante a extensão correta
        const ext = path.extname(file.originalname) || '.pdf'; 
        cb(null, `ordem-${uniqueSuffix}${ext}`);
    }
});

const uploadPdf = multer({ 
    storage: storagePdf,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --- HELPERS LOCAIS ---
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

// --- FUNÇÕES DO GESTOR/ADMIN ---

const listarTodasSolicitacoes = async (req, res) => {
    try {
        const query = `
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
            ORDER BY s.data_solicitacao DESC LIMIT 100
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar todas solicitações.' });
    }
};

const uploadPdfGerado = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }
        
        // CORREÇÃO CRÍTICA AQUI:
        // Antes estava: `/uploads/orders${req.file.filename}` (faltava a barra)
        // Agora está correto: `/uploads/orders/${req.file.filename}`
        const fileUrl = `/uploads/orders/${req.file.filename}`;
        
        console.log("PDF Salvo com sucesso:", fileUrl);
        res.json({ url: fileUrl });
    } catch (error) {
        console.error("Erro no upload do PDF:", error);
        res.status(500).json({ error: 'Falha ao salvar PDF no servidor.' });
    }
};

const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivoNegativa } = req.body; 
    
    const connection = await db.getConnection();
    await connection.beginTransaction();
    let liberouConexao = false;

    try {
        const [solicitacao] = await connection.execute(
            `SELECT s.*, v.placa AS veiculo_placa, v.registroInterno AS veiculo_re
             FROM solicitacoes_abastecimento s
             LEFT JOIN vehicles v ON v.id = s.veiculo_id
             WHERE s.id = ? FOR UPDATE`,
            [id]
        );
        if (!solicitacao.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const sol = solicitacao[0];

        // --- FLUXO DE REPROVAÇÃO ---
        if (status === 'NEGADO') {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['NEGADO', motivoNegativa, req.user.id, id]
            );
            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });

            // Notifica solicitante via WhatsApp
            try {
                const [userRows] = await db.query(
                    `SELECT u.name, wcs.phone_number
                     FROM users u
                     JOIN whatsapp_chatbot_sessions wcs
                       ON JSON_UNQUOTE(JSON_EXTRACT(wcs.session_data, '$.employee_uuid')) = u.employeeId
                     WHERE u.id = ?
                     ORDER BY wcs.last_activity DESC
                     LIMIT 1`,
                    [sol.usuario_id]
                );
                const solicitante = userRows[0];
                if (solicitante?.phone_number) {
                    const partes = [sol.veiculo_re && `RE ${sol.veiculo_re}`, sol.veiculo_placa].filter(Boolean);
                    const veiculo = partes.length ? partes.join(' – ') : `ID ${sol.veiculo_id}`;
                    const motivo  = motivoNegativa ? `\n\n*Motivo:* ${motivoNegativa}` : '';
                    await whatsappService.enviarMensagem(
                        solicitante.phone_number,
                        solicitante.name,
                        'negativa_solicitacao',
                        `❌ *Solicitação de Abastecimento Negada*\n\nSua solicitação para o veículo *${veiculo}* foi *negada*.${motivo}\n\nEm caso de dúvidas, entre em contato com o responsável.`
                    );
                }
            } catch (e) {
                console.error('[SOLICITACAO] Erro ao notificar negativa via WhatsApp:', e.message);
            }

            return res.json({ message: 'Solicitação negada.' });
        }

        // --- FLUXO DE APROVAÇÃO (GERAR ORDEM) ---
        if (status === 'LIBERADO') {
            // Antes daqui havia um INSERT cru em `refuelings`, que pulava TODAS as
            // travas soberanas: ordem já aberta para o veículo, operador
            // placeholder há mais de 7 dias, regressão/salto de leitura e o limite
            // de 20% do contrato. Também não empenhava saldo pré-pago nem enviava
            // a ordem ao posto.
            //
            // Na prática a tela de Solicitações não usava este caminho (ela abre o
            // RefuelingOrderModal e emite pelo POST /api/refuelings), mas o
            // endpoint continuava aberto e era uma porta lateral em volta das
            // regras. Agora chama o mesmo núcleo do caminho humano.
            //
            // A transação local é encerrada antes: criarOrdem abre a sua própria e
            // faz o UPDATE da solicitação para LIBERADO por dentro.
            await connection.commit();
            connection.release();
            liberouConexao = true;

            const resultado = await criarOrdem({
                vehicleId: sol.veiculo_id,
                partnerId: sol.posto_id || null,
                employeeId: sol.funcionario_id || null,
                obraId: sol.obra_id,
                fuelType: normalizeFuelType(sol.tipo_combustivel),
                isFillUp: !!sol.flag_tanque_cheio,
                litrosLiberados: safeNum(sol.litragem_solicitada),
                odometro: safeNum(sol.odometro_informado),
                horimetro: safeNum(sol.horimetro_informado),
                outros: sol.observacao || null,
                solicitacaoId: id,
                createdBy: { id: req.user.id, name: req.user.name || 'Gestor' },
            }, { actor: req.user, io: req.io });

            if (!resultado.ok) return res.status(resultado.status).json(resultado.body);

            return res.json({
                message: 'Solicitação liberada! Ordem gerada.',
                authNumber: resultado.body.authNumber,
                bloqueadoLeitura: resultado.body.bloqueadoLeitura,
                bloqueadoOrcamento: resultado.body.bloqueadoOrcamento,
            });
        }

    } catch (error) {
        await connection.rollback();
        console.error("Erro Avaliar Admin:", error);
        res.status(500).json({ error: 'Erro ao avaliar: ' + error.message });
    } finally {
        // criarOrdem abre a própria conexão, então o fluxo de aprovação encerra
        // esta antes de chamá-lo. Liberar de novo devolveria a mesma conexão duas
        // vezes ao pool.
        if (!liberouConexao) connection.release();
    }
};

const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar.' });
    }
};

module.exports = {
    listarTodasSolicitacoes,
    avaliarSolicitacao,
    confirmarBaixa,
    rejeitarComprovante,
    uploadPdfGerado,
    uploadPdf // Exporta o multer configurado
};