// Diagnóstico do aceite automático de abastecimento.
//
// NÃO ESCREVE NADA. Roda os mesmos portões que o motor usaria e imprime o
// veredito de cada um, para calibrar limiares sem mexer em produção.
//
// Uso:
//   node scripts/testarIaAbastecimento.js --solicitacao 1234
//   node scripts/testarIaAbastecimento.js --pendentes 10     # últimas N pendentes
//   node scripts/testarIaAbastecimento.js --imagem public/uploads/solicitacoes/x.jpg --tipo odometro
//   node scripts/testarIaAbastecimento.js --config           # parâmetros vigentes
//
// Para conferir as médias de consumo use scripts/recalcMediasConsumo.js --listar.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../database');
const motor = require('../services/abastecimentoAutoService');
const visao = require('../services/aiVisionService');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valor = (f, padrao = null) => {
    const i = args.indexOf(f);
    return (i === -1 || i === args.length - 1) ? padrao : args[i + 1];
};

const ICONE = { ok: '  OK  ', falha: 'FALHA ', indeterminado: ' ??   ' };
const simbolo = (st) => ICONE[st] || st;

const linha = (c = '-') => console.log(c.repeat(78));

function imprimirPortao(p) {
    console.log(`  ${simbolo(p.status)} ${p.nome.padEnd(22)} ${p.detalhe}`);
    // Números que ajudam a calibrar, quando o portão os produziu
    const extras = [];
    if (p.mediaObservada != null) extras.push(`observada=${Number(p.mediaObservada).toFixed(2)}`);
    if (p.mediaEsperada != null) extras.push(`esperada=${Number(p.mediaEsperada).toFixed(2)}`);
    if (p.desvioPercentual != null) extras.push(`desvio=${Number(p.desvioPercentual).toFixed(1)}%`);
    if (p.litrosEstimados != null) extras.push(`estimados=${Number(p.litrosEstimados).toFixed(1)}L`);
    if (p.percentualTanque != null) extras.push(`tanque=${Number(p.percentualTanque).toFixed(0)}%`);
    if (p.valorIa != null) extras.push(`IA=${p.valorIa}`);
    if (p.valorInformado != null) extras.push(`informado=${p.valorInformado}`);
    if (p.confianca != null) extras.push(`confiança=${(p.confianca * 100).toFixed(0)}%`);
    if (p.modelo) extras.push(`modelo=${p.modelo}${p.escalonou ? ' (escalonou)' : ''}`);
    if (p.valorEstimado != null) extras.push(`R$${Number(p.valorEstimado).toFixed(2)}`);
    if (extras.length) console.log(`         ${extras.join('  ')}`);
}

async function mostrarConfig() {
    const config = await motor.carregarConfig(db);
    if (!config) return console.log('Nenhuma configuração encontrada (tabela abastecimento_auto_config).');
    console.log('Parâmetros vigentes:');
    linha();
    Object.entries(config).forEach(([k, v]) => {
        console.log('  ' + k.padEnd(32) + (v === null ? '(nulo)' : String(v)));
    });
    linha();
    console.log(config.ativo == 1
        ? `Motor LIGADO em modo "${config.modo}".`
        : 'Motor DESLIGADO (ativo = 0): nenhuma solicitação é analisada.');
    console.log(visao.isConfigured()
        ? 'ANTHROPIC_API_KEY presente — leitura de imagem disponível.'
        : 'ANTHROPIC_API_KEY AUSENTE — portão de visão fica indeterminado.');
}

async function analisarUma(solicitacaoId, config) {
    const [[sol]] = await db.query(
        `SELECT s.*, u.bloqueado_abastecimento AS usuario_bloqueado,
                v.registroInterno, v.placa
           FROM solicitacoes_abastecimento s
           LEFT JOIN users u ON u.id = s.usuario_id
           LEFT JOIN vehicles v ON v.id = s.veiculo_id
          WHERE s.id = ?`,
        [solicitacaoId]
    );
    if (!sol) { console.log(`Solicitação ${solicitacaoId} não encontrada.`); return; }

    const [[veiculo]] = await db.query('SELECT * FROM vehicles WHERE id = ?', [sol.veiculo_id]);
    if (!veiculo) { console.log(`Veículo ${sol.veiculo_id} não encontrado.`); return; }

    linha('=');
    console.log(`Solicitação #${sol.id}  |  status ${sol.status}  |  ${sol.registroInterno || ''} ${sol.placa || ''} (${veiculo.tipo})`);
    console.log(`  leitura informada: odo=${sol.odometro_informado || '—'}  hor=${sol.horimetro_informado || '—'}`);
    console.log(`  combustível: ${sol.tipo_combustivel}  |  ${sol.flag_tanque_cheio == 1 ? 'TANQUE CHEIO' : (sol.litragem_solicitada || 0) + ' L'}`);
    console.log(`  foto painel: ${sol.foto_painel_path || '(sem foto)'}`);
    linha();

    const portoes = [];
    portoes.push(motor.avaliarG0(sol, veiculo, config));
    if (portoes[0].status === 'ok') portoes.push(await motor.avaliarG1(db, sol, veiculo));

    if (portoes.every((p) => p.status === 'ok')) {
        const g2 = await motor.avaliarG2(db, veiculo, config);
        portoes.push(g2);
        if (g2.status === 'ok') {
            const g3 = await motor.avaliarG3(db, sol, veiculo, config, g2.mediaEsperada);
            portoes.push(g3);
            if (g3.status === 'ok') {
                // G4 é o único portão que gasta chamada de IA.
                // Usa o portão REAL do motor, não uma réplica: uma cópia aqui
                // divergiria do comportamento de produção no primeiro ajuste,
                // que é justamente o que este diagnóstico existe para evitar.
                const g4 = visao.isConfigured()
                    ? await motor.avaliarG4(db, sol, veiculo, config)
                    : { nome: 'G4_visao', status: 'indeterminado', detalhe: 'ANTHROPIC_API_KEY ausente.' };
                portoes.push(g4);
                if (g4.status === 'ok') {
                    portoes.push(await motor.avaliarG5(db, sol, config, g3.litrosEstimados));
                }
            }
        }
    }

    portoes.forEach(imprimirPortao);
    linha();
    const todosOk = portoes.every((p) => p.status === 'ok');
    const modo = config.modo === 'ativo' ? 'ATIVO' : 'SOMBRA';
    console.log(todosOk
        ? `DECISÃO: liberaria automaticamente (modo ${modo}${modo === 'SOMBRA' ? ' — nada seria liberado de fato' : ''}).`
        : `DECISÃO: enviaria ao setor de abastecimento — ${portoes.find((p) => p.status !== 'ok').detalhe}`);
}

async function lerImagemAvulsa(caminho, tipo) {
    if (!visao.isConfigured()) {
        console.log('ANTHROPIC_API_KEY ausente — não há como ler a imagem.');
        return;
    }
    console.log(`Lendo ${caminho} como ${tipo}...`);
    const r = await visao.lerPainel(caminho, { tipoLeitura: tipo });
    console.log(JSON.stringify(r, null, 2));
}

(async () => {
    try {
        if (flag('--config')) { await mostrarConfig(); process.exit(0); }

        if (flag('--imagem')) {
            await lerImagemAvulsa(valor('--imagem'), valor('--tipo', 'odometro'));
            process.exit(0);
        }

        const config = await motor.carregarConfig(db);
        if (!config) { console.log('Configuração não encontrada — rode as migrações primeiro.'); process.exit(1); }

        if (flag('--solicitacao')) {
            await analisarUma(parseInt(valor('--solicitacao'), 10), config);
            process.exit(0);
        }

        const n = parseInt(valor('--pendentes', '5'), 10) || 5;
        const [pendentes] = await db.query(
            `SELECT id FROM solicitacoes_abastecimento
              WHERE status = 'PENDENTE' ORDER BY data_solicitacao DESC LIMIT ${n}`
        );
        if (pendentes.length === 0) { console.log('Nenhuma solicitação PENDENTE no banco.'); process.exit(0); }
        for (const p of pendentes) await analisarUma(p.id, config);
        process.exit(0);
    } catch (e) {
        console.error('Falha:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
