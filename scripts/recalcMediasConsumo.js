// Recalcula vehicle_fuel_averages com a UNIDADE CORRETA por grupo de veículo.
//
// Uso:
//   node scripts/recalcMediasConsumo.js --listar          # só mostra o estado atual
//   node scripts/recalcMediasConsumo.js                   # recalcula os pendentes
//   node scripts/recalcMediasConsumo.js --todos           # recalcula tudo
//   node scripts/recalcMediasConsumo.js --limite 20       # limita o lote
//
// POR QUE ESTE BACKFILL EXISTE
// A versão anterior de utils/recalcFuelAverage.js escolhia a leitura por
// `odometro || horimetro` e devolvia sempre `diff / litros`. Resultado: para os
// grupos em L/h ficava gravado o INVERSO (h/L) — uma motoniveladora de 17,5 L/h
// aparecia como 0,057 — e avg_by_tipo fazia AVG() misturando Km/L com h/L.
//
// A correção grava a coluna `unidade` em cada linha. Por isso "pendente" aqui
// significa `unidade IS NULL`: linha ainda no formato antigo, cujo número não é
// confiável. Rodar de novo é seguro (UPSERT idempotente).
//
// Sem o backfill nada quebra: recalcFuelAverage roda a cada baixa e as linhas se
// corrigem sozinhas com o tempo. O backfill só antecipa isso — o que importa
// porque o portão de média do aceite automático trata linha sem `unidade` como
// indeterminada e manda a solicitação para conferência humana.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../database');
const { recalcFuelAverage } = require('../utils/recalcFuelAverage');
const consumo = require('../utils/consumo');

const args = process.argv.slice(2);
const temFlag = (f) => args.includes(f);
const valorFlag = (f, padrao) => {
    const i = args.indexOf(f);
    if (i === -1 || i === args.length - 1) return padrao;
    const n = parseInt(args[i + 1], 10);
    return isNaN(n) ? padrao : n;
};

const APENAS_LISTAR = temFlag('--listar');
const TODOS = temFlag('--todos');
const LIMITE = valorFlag('--limite', 0);

const fmt = (v) => (v == null ? '—' : Number(v).toFixed(3));

async function listar() {
    const [linhas] = await db.query(
        `SELECT v.id, v.registroInterno, v.placa, v.tipo,
                a.unidade, a.avg_last_1, a.avg_last_3,
                a.avg_by_tipo, a.intervalos_validos, a.intervalos_tanque_cheio
           FROM vehicles v
           LEFT JOIN vehicle_fuel_averages a ON a.vehicle_id = v.id
          WHERE a.vehicle_id IS NOT NULL
          ORDER BY (a.unidade IS NULL) DESC, v.tipo, v.registroInterno
          ${LIMITE > 0 ? 'LIMIT ' + LIMITE : ''}`
    );

    if (linhas.length === 0) {
        console.log('Nenhuma linha em vehicle_fuel_averages.');
        return;
    }

    console.log(
        'RE'.padEnd(10) + 'TIPO'.padEnd(22) + 'UNID'.padEnd(7)
        + 'ULT.1'.padStart(10) + 'ULT.3'.padStart(10) + 'TIPO'.padStart(10)
        + '  INT  CHEIO'
    );
    console.log('-'.repeat(85));
    for (const l of linhas) {
        console.log(
            String(l.registroInterno || l.placa || l.id).slice(0, 9).padEnd(10)
            + String(l.tipo || '').slice(0, 21).padEnd(22)
            + String(l.unidade || 'NULL').padEnd(7)
            + fmt(l.avg_last_1).padStart(10)
            + fmt(l.avg_last_3).padStart(10)
            + fmt(l.avg_by_tipo).padStart(10)
            + String(l.intervalos_validos ?? '—').padStart(5)
            + String(l.intervalos_tanque_cheio ?? '—').padStart(7)
        );
    }

    const [[resumo]] = await db.query(
        `SELECT COUNT(*) AS total,
                SUM(unidade IS NULL) AS pendentes
           FROM vehicle_fuel_averages`
    );
    console.log(`\n${resumo.total} linha(s); ${resumo.pendentes} ainda sem unidade (formato antigo).`);
}

async function recalcular() {
    // Veículos a processar. Por padrão, só os que ainda não têm `unidade`
    // (ou que nunca tiveram linha em vehicle_fuel_averages).
    const filtro = TODOS ? '' : 'WHERE a.vehicle_id IS NULL OR a.unidade IS NULL';
    const [veiculos] = await db.query(
        `SELECT v.id, v.registroInterno, v.placa, v.tipo
           FROM vehicles v
           LEFT JOIN vehicle_fuel_averages a ON a.vehicle_id = v.id
           ${filtro}
          ORDER BY v.tipo, v.registroInterno
          ${LIMITE > 0 ? 'LIMIT ' + LIMITE : ''}`
    );

    if (veiculos.length === 0) {
        console.log('Nada a recalcular.' + (TODOS ? '' : ' (use --todos para forçar)'));
        return;
    }

    const taxonomia = await consumo.carregarTaxonomia(db);
    console.log(`Taxonomia carregada de: ${taxonomia.origem} `
        + `(${taxonomia.unidadePorGrupo.size} grupos, ${taxonomia.tipoParaGrupo.size} tipos)`);
    console.log(`Recalculando ${veiculos.length} veículo(s)...\n`);

    let ok = 0;
    let erros = 0;
    for (const v of veiculos) {
        const rotulo = String(v.registroInterno || v.placa || v.id).slice(0, 12).padEnd(13);
        try {
            await recalcFuelAverage(db, v.id);
            const [[linha]] = await db.query(
                'SELECT unidade, avg_last_1, avg_last_3, intervalos_validos FROM vehicle_fuel_averages WHERE vehicle_id = ?',
                [v.id]
            );
            ok++;
            if (linha) {
                console.log(`  ok  ${rotulo}${String(v.tipo || '').slice(0, 20).padEnd(21)}`
                    + `${String(linha.unidade).padEnd(6)} ult1=${fmt(linha.avg_last_1)} `
                    + `ult3=${fmt(linha.avg_last_3)} int=${linha.intervalos_validos}`);
            } else {
                console.log(`  ok  ${rotulo}(sem histórico suficiente)`);
            }
        } catch (e) {
            erros++;
            console.log(`  ERRO ${rotulo}${e.message}`);
        }
    }

    console.log(`\n${ok} recalculado(s), ${erros} erro(s).`);
}

// avg_by_tipo / avg_by_subtipo são um RETRATO do momento em que cada veículo foi
// recalculado: os primeiros do lote enxergam a tabela ainda meio vazia. Depois de
// processar todo mundo, uma passada SQL única deixa todos com o mesmo agregado.
// (No dia a dia isso não importa — cada baixa recalcula um veículo só — mas num
// backfill em massa a diferença entre o primeiro e o último item é grande.)
async function consolidarAgregados() {
    const [rTipo] = await db.query(
        `UPDATE vehicle_fuel_averages a
           JOIN (SELECT vehicle_tipo, unidade, AVG(avg_last_1) AS media
                   FROM vehicle_fuel_averages
                  WHERE avg_last_1 IS NOT NULL AND unidade IS NOT NULL
                  GROUP BY vehicle_tipo, unidade) t
             ON t.vehicle_tipo = a.vehicle_tipo AND t.unidade = a.unidade
            SET a.avg_by_tipo = ROUND(t.media, 3)`
    );

    const [rSub] = await db.query(
        `UPDATE vehicle_fuel_averages a
           JOIN (SELECT vehicle_sub_tipo, unidade, AVG(avg_last_1) AS media
                   FROM vehicle_fuel_averages
                  WHERE avg_last_1 IS NOT NULL AND unidade IS NOT NULL
                    AND vehicle_sub_tipo IS NOT NULL
                  GROUP BY vehicle_sub_tipo, unidade) t
             ON t.vehicle_sub_tipo = a.vehicle_sub_tipo AND t.unidade = a.unidade
            SET a.avg_by_subtipo = ROUND(t.media, 3)`
    );

    console.log('');
    console.log('Agregados consolidados: ' + rTipo.affectedRows + ' por tipo, '
        + rSub.affectedRows + ' por sub-tipo.');
}

(async () => {
    try {
        if (APENAS_LISTAR) await listar();
        else {
            await recalcular();
            await consolidarAgregados();
            console.log('\n--- estado após o recálculo ---');
            await listar();
        }
        process.exit(0);
    } catch (e) {
        console.error('Falha:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
