// scripts/auditar-divergencia-historicos.js
//
// A alocação em obra é gravada em duas tabelas que deveriam dizer o mesmo:
//   - obras_historico_veiculos — tela da obra, aba Produção, regra de
//     sobreposição (utils/periodosObra.js);
//   - vehicle_history (historyType 'obra') — "Histórico do Veículo", checagem
//     de conflito da estadia retroativa.
// Quando divergem, uma tela diz que a máquina estava na obra e a outra não
// (caso RE779: obra fechou em 22/09, veículo seguiu até 19/10).
//
// Compara dia a dia, por veículo e obra, e lista os trechos que só existem em
// uma das tabelas, com as horas lançadas nesses dias. Somente leitura.
//
//   node scripts/auditar-divergencia-historicos.js                 # desde 01/01 do ano
//   node scripts/auditar-divergencia-historicos.js --desde 2026-07-01
//   node scripts/auditar-divergencia-historicos.js --json
//   node scripts/auditar-divergencia-historicos.js --producao   # banco de produção (só SELECT)
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.local', override: true, quiet: true });

const { obterConexao, anunciar } = require('../utils/conexaoAlvo');
const { diaCivil } = require('../utils/periodosObra');

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : null; };
const hoje = diaCivil(new Date(Date.now() - 3 * 3600 * 1000));
const DESDE = arg('--desde') || `${hoje.slice(0, 4)}-01-01`;

const proximoDia = (ymd) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};
const br = (d) => d.split('-').reverse().join('/');

// veiculo → obra → Set(dias), recortado em [DESDE, hoje]
const expandir = (periodos) => {
    const mapa = new Map();
    for (const p of periodos) {
        const ini = diaCivil(p.inicio);
        if (!ini || !p.obraId) continue;
        const fim = diaCivil(p.fim) || hoje;
        let d = ini > DESDE ? ini : DESDE;
        const ate = fim < hoje ? fim : hoje;
        if (!mapa.has(p.veiculoId)) mapa.set(p.veiculoId, new Map());
        const porObra = mapa.get(p.veiculoId);
        if (!porObra.has(p.obraId)) porObra.set(p.obraId, new Set());
        const dias = porObra.get(p.obraId);
        for (; d <= ate; d = proximoDia(d)) dias.add(d);
    }
    return mapa;
};

// Dias soltos → trechos consecutivos
const trechos = (dias) => {
    const lista = [...dias].sort();
    const out = [];
    for (const d of lista) {
        const ult = out[out.length - 1];
        if (ult && proximoDia(ult.ate) === d) ult.ate = d;
        else out.push({ de: d, ate: d });
    }
    return out;
};

(async () => {
    let conexao;
    try {
        conexao = await obterConexao();
        if (!process.argv.includes('--json')) anunciar(conexao);
        const { db } = conexao;
        const [oh] = await db.query(
            'SELECT veiculoId, obraId, dataEntrada AS inicio, dataSaida AS fim FROM obras_historico_veiculos'
        );
        const [vh] = await db.query(
            `SELECT vehicleId AS veiculoId, JSON_UNQUOTE(JSON_EXTRACT(details, '$.obraId')) AS obraId,
                    startDate AS inicio, endDate AS fim
               FROM vehicle_history WHERE historyType = 'obra'`
        );
        const [logs] = await db.query(
            `SELECT vehicleId, obraId, DATE_FORMAT(date, '%Y-%m-%d') AS dia, totalHours
               FROM daily_work_logs WHERE date >= ? AND totalHours > 0`,
            [DESDE]
        );
        const [veics] = await db.query('SELECT id, registroInterno, placa, isOutsourced FROM vehicles');
        const [obrasRows] = await db.query('SELECT id, nome, orgao_contratante FROM obras');

        const veiculo = new Map(veics.map(v => [String(v.id), v]));
        const obraNome = new Map(obrasRows.map(o => [String(o.id), o.orgao_contratante ? `${o.nome} (${o.orgao_contratante})` : o.nome]));
        const horasDia = new Map(); // `${vid}|${obraId}|${dia}` → h
        for (const l of logs) {
            const k = `${l.vehicleId}|${l.obraId}|${l.dia}`;
            horasDia.set(k, (horasDia.get(k) || 0) + Number(l.totalHours));
        }

        const norm = (rows) => rows.map(r => ({ ...r, veiculoId: String(r.veiculoId), obraId: r.obraId ? String(r.obraId) : null }));
        const A = expandir(norm(oh)); // obra
        const B = expandir(norm(vh)); // veículo

        const achados = [];
        for (const vid of new Set([...A.keys(), ...B.keys()])) {
            const a = A.get(vid) || new Map();
            const b = B.get(vid) || new Map();
            for (const oid of new Set([...a.keys(), ...b.keys()])) {
                const da = a.get(oid) || new Set();
                const db_ = b.get(oid) || new Set();
                const soVeiculo = [...db_].filter(d => !da.has(d));
                const soObra = [...da].filter(d => !db_.has(d));
                for (const [lado, dias] of [['so_no_veiculo', soVeiculo], ['so_na_obra', soObra]]) {
                    for (const t of trechos(dias)) {
                        let horas = 0;
                        for (let d = t.de; d <= t.ate; d = proximoDia(d)) horas += horasDia.get(`${vid}|${oid}|${d}`) || 0;
                        const v = veiculo.get(vid) || {};
                        achados.push({
                            veiculoId: vid,
                            registroInterno: v.registroInterno || null,
                            placa: v.placa || null,
                            terceiro: Number(v.isOutsourced) === 1,
                            obraId: oid,
                            obraNome: obraNome.get(oid) || 'Obra não identificada',
                            lado,
                            de: t.de,
                            ate: t.ate,
                            dias: Math.round((Date.parse(`${t.ate}T12:00:00Z`) - Date.parse(`${t.de}T12:00:00Z`)) / 86400000) + 1,
                            horasLancadas: Math.round(horas * 10) / 10,
                        });
                    }
                }
            }
        }
        achados.sort((x, y) => y.horasLancadas - x.horasLancadas || y.dias - x.dias);

        if (process.argv.includes('--json')) {
            console.log(JSON.stringify(achados, null, 2));
            return;
        }

        const soV = achados.filter(x => x.lado === 'so_no_veiculo');
        const soO = achados.filter(x => x.lado === 'so_na_obra');
        const soma = (l, c) => Math.round(l.reduce((s, x) => s + x[c], 0) * 10) / 10;
        console.log(`Período: ${br(DESDE)} a ${br(hoje)}`);
        console.log(`Veículos com divergência: ${new Set(achados.map(x => x.veiculoId)).size}`);
        console.log(`  Só no histórico do VEÍCULO (a obra não conta esses dias): ${soV.length} trechos, ${soma(soV, 'dias')} dias, ${soma(soV, 'horasLancadas')}h lançadas`);
        console.log(`  Só no histórico da OBRA    (o veículo não mostra):        ${soO.length} trechos, ${soma(soO, 'dias')} dias, ${soma(soO, 'horasLancadas')}h lançadas`);
        const linha = (x) => `  ${(x.registroInterno || x.placa || x.veiculoId).padEnd(12)} ${x.obraNome.slice(0, 42).padEnd(42)} ${br(x.de)} a ${br(x.ate)}  ${String(x.dias).padStart(3)}d  ${String(x.horasLancadas).padStart(6)}h`;
        console.log('\n── Só no histórico do VEÍCULO ──');
        soV.forEach(x => console.log(linha(x)));
        console.log('\n── Só no histórico da OBRA ──');
        soO.forEach(x => console.log(linha(x)));
    } catch (err) {
        console.error('❌', err.message);
        process.exitCode = 1;
    } finally {
        if (conexao) await conexao.encerrar();
        process.exit();
    }
})();
