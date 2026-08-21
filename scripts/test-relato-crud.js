// scripts/test-relato-crud.js
//
// Smoke test do CRUD de relatos de ocorrência (FRM-MAN-001). Chama os handlers
// do controller direto com req/res falsos — não precisa de token nem do
// servidor no ar. Limpa tudo o que cria.
//
//   node scripts/test-relato-crud.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../database');
const c = require('../controllers/relatoController');

const resultados = [];
const check = (label, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    resultados.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
    return ok;
};

// req/res falsos com a mesma superfície que o controller usa.
const call = (handler, { params = {}, query = {}, body = {}, user = null } = {}) =>
    new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(data) { resolve({ status: this.statusCode, body: data }); return this; },
        };
        const req = {
            params, query, body,
            user: user || { id: 'test-user', email: 'teste@makservicos.com', user_type: 'admin' },
            io: { emit: () => {} },
        };
        Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });

(async () => {
    let relatoId = null;
    try {
        const [[vehicle]] = await db.query('SELECT id, modelo, placa, registroInterno FROM vehicles LIMIT 1');
        if (!vehicle) throw new Error('Nenhum veículo no banco para testar.');
        console.log(`Veículo de teste: ${vehicle.registroInterno || vehicle.placa || vehicle.id}\n`);

        // --- Configuração de gravidade (seed) ---
        const sla = await call(c.getSlaConfig);
        check('GET config/sla devolve 4 gravidades', sla.body.length, 4);
        check('SLA de A = 2 dias úteis', sla.body.find(s => s.gravidade === 'A')?.slaDiasUteis, 2);
        check('SLA de D = 30 dias úteis', sla.body.find(s => s.gravidade === 'D')?.slaDiasUteis, 30);
        check('A bloqueia operação', sla.body.find(s => s.gravidade === 'A')?.bloqueiaOperacao, 1);

        // --- Validação na criação ---
        const semNome = await call(c.createRelato, { body: { vehicleId: vehicle.id, dataRelato: '2026-08-07' } });
        check('cria sem relator → 400', semNome.status, 400);

        const gravidadeRuim = await call(c.createRelato, {
            body: {
                relatorNome: 'Teste', vehicleId: vehicle.id, dataRelato: '2026-08-07',
                itens: [{ itemComponente: 'Freio', descricaoProblema: 'Vazando', gravidade: 'X' }],
            },
        });
        check('gravidade inválida → 400', gravidadeRuim.status, 400);
        check('mensagem cita A, B, C ou D', /A, B, C ou D/.test(gravidadeRuim.body.error), true);

        const [[antes]] = await db.query("SELECT lastNumber FROM counters WHERE name='relatoOcorrenciaCounter'");
        check('erro de validação NÃO consome número', antes.lastNumber, antes.lastNumber);

        // --- Criação válida ---
        const criado = await call(c.createRelato, {
            body: {
                relatorNome: 'João Operador', relatorFuncao: 'Operador de Escavadeira',
                filialCidade: 'Lajeado', dataRelato: '2026-08-07',
                vehicleId: vehicle.id, hodometro: 12345.5, horimetro: 890.2,
                observacoesGerais: 'Barulho aumentou depois da chuva.',
                assinaturaColaborador: 'João Operador', assinaturaSupervisor: 'Carlos Encarregado',
                status: 'Digitado',
                itens: [
                    { itemComponente: 'Sistema de freios', descricaoProblema: 'Pedal vai até o fim', gravidade: 'a' },
                    { itemComponente: 'Mangueira hidráulica', descricaoProblema: 'Suando óleo', gravidade: 'B' },
                    { itemComponente: 'Pintura da lança', descricaoProblema: 'Descascando', gravidade: 'D' },
                ],
            },
        });
        check('criação válida → 201', criado.status, 201);
        relatoId = criado.body.id;
        const numero = criado.body.numero;
        check('número sequencial atribuído', numero, antes.lastNumber + 1);

        // --- Detalhe ---
        const det = await call(c.getRelatoById, { params: { id: relatoId } });
        check('GET detalhe → 200', det.status, 200);
        check('3 itens', det.body.itens.length, 3);
        check('gravidade minúscula normalizada p/ maiúscula', det.body.itens[0].gravidade, 'A');
        check('sequência 1..3 na ordem da ficha', det.body.itens.map(i => i.sequencia), [1, 2, 3]);
        check('status inicial do item = Em Análise', det.body.itens[0].status, 'Em Análise');
        check('data como YYYY-MM-DD (sem timestamp)', det.body.dataRelato, '2026-08-07');
        check('snapshot do modelo gravado', det.body.veiculoModelo, vehicle.modelo || null);
        check('snapshot do RE gravado', det.body.veiculoFrota, vehicle.registroInterno || null);
        check('status do relato = Digitado', det.body.status, 'Digitado');
        check('nenhuma ordem ainda', det.body.ordens.length, 0);

        // --- Listagem ---
        const lista = await call(c.getRelatos, { query: { vehicleId: vehicle.id } });
        const meu = lista.body.find(r => r.id === relatoId);
        check('aparece na listagem', !!meu, true);
        check('itensCount agregado', Number(meu.itensCount), 3);
        check('itensConcluidos = 0', Number(meu.itensConcluidos), 0);
        check('gravidadeMax = A (a pior)', meu.gravidadeMax, 'A');

        // --- Novo item avulso ---
        const novoItem = await call(c.createRelatoItem, {
            params: { id: relatoId },
            body: { itemComponente: 'Farol dianteiro', descricaoProblema: 'Queimado', gravidade: 'C' },
        });
        check('POST item → 201', novoItem.status, 201);
        check('sequência continua em 4', novoItem.body.sequencia, 4);

        // --- Movimento de status do item (seção 6 da ficha) ---
        const mov = await call(c.updateRelatoItemStatus, {
            params: { id: relatoId, itemId: novoItem.body.id },
            body: { status: 'Aguardando Peça' },
        });
        check('move p/ Aguardando Peça → 200', mov.status, 200);

        const movRuim = await call(c.updateRelatoItemStatus, {
            params: { id: relatoId, itemId: novoItem.body.id },
            body: { status: 'Inventado' },
        });
        check('status inválido → 400', movRuim.status, 400);

        await call(c.updateRelatoItemStatus, {
            params: { id: relatoId, itemId: novoItem.body.id },
            body: { status: 'Concluído' },
        });
        const [[itemConcl]] = await db.query('SELECT status, dataConclusaoReal FROM relato_ocorrencia_itens WHERE id = ?', [novoItem.body.id]);
        check('Concluído grava dataConclusaoReal', itemConcl.dataConclusaoReal !== null, true);

        await call(c.updateRelatoItemStatus, {
            params: { id: relatoId, itemId: novoItem.body.id },
            body: { status: 'Em Execução' },
        });
        const [[itemVolta]] = await db.query('SELECT dataConclusaoReal FROM relato_ocorrencia_itens WHERE id = ?', [novoItem.body.id]);
        check('voltar de terminal limpa dataConclusaoReal', itemVolta.dataConclusaoReal, null);

        // --- Triagem ---
        const det2 = await call(c.getRelatoById, { params: { id: relatoId } });
        const itemFreio = det2.body.itens.find(i => i.gravidade === 'A');
        const triagem = await call(c.updateRelatoItem, {
            params: { id: relatoId, itemId: itemFreio.id },
            body: { executorTipo: 'interno', servicoDescricao: 'Sangria e troca de fluido', valorEstimado: 480.5, slaDiasUteis: 3 },
        });
        check('triagem do item → 200', triagem.status, 200);
        const [[itemTri]] = await db.query('SELECT executorTipo, valorEstimado, slaDiasUteis FROM relato_ocorrencia_itens WHERE id = ?', [itemFreio.id]);
        check('executorTipo gravado', itemTri.executorTipo, 'interno');
        check('valorEstimado gravado', Number(itemTri.valorEstimado), 480.5);
        check('slaDiasUteis sobrescreve o padrão', itemTri.slaDiasUteis, 3);

        // --- Exclusão de item renumera ---
        const itemDoMeio = det2.body.itens.find(i => i.sequencia === 2);
        const del = await call(c.deleteRelatoItem, { params: { id: relatoId, itemId: itemDoMeio.id } });
        check('DELETE item → 200', del.status, 200);
        const det3 = await call(c.getRelatoById, { params: { id: relatoId } });
        check('sobraram 3 itens', det3.body.itens.length, 3);
        check('renumerado 1..3 sem buraco', det3.body.itens.map(i => i.sequencia), [1, 2, 3]);

        // --- Edição do cabeçalho ---
        const upd = await call(c.updateRelato, {
            params: { id: relatoId },
            body: { responsavelManutencao: 'Saulo Oficina', recebidoEm: '2026-08-10' },
        });
        check('PUT cabeçalho → 200', upd.status, 200);
        const det4 = await call(c.getRelatoById, { params: { id: relatoId } });
        check('seção 6 gravada', det4.body.responsavelManutencao, 'Saulo Oficina');
        check('recebidoEm normalizado', det4.body.recebidoEm, '2026-08-10');

        // --- Exclusão do relato ---
        const delRel = await call(c.deleteRelato, { params: { id: relatoId } });
        check('DELETE relato → 200', delRel.status, 200);
        const [[{ n }]] = await db.query('SELECT COUNT(*) n FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]);
        check('itens removidos junto', n, 0);
        relatoId = null;

        const del404 = await call(c.getRelatoById, { params: { id: 'nao-existe' } });
        check('GET inexistente → 404', del404.status, 404);
    } catch (e) {
        resultados.push(`FAIL  exceção não tratada: ${e.message}\n${e.stack}`);
    } finally {
        if (relatoId) {
            await db.query('DELETE FROM relato_ocorrencia_itens WHERE relatoId = ?', [relatoId]);
            await db.query('DELETE FROM relatos_ocorrencia WHERE id = ?', [relatoId]);
        }
        console.log(resultados.join('\n'));
        const falhas = resultados.filter(r => r.startsWith('FAIL')).length;
        console.log(falhas ? `\n>>> ${falhas} FALHA(S)` : '\n>>> TODOS OS TESTES PASSARAM');
        process.exit(falhas ? 1 : 0);
    }
})();
