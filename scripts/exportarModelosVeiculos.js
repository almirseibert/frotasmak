// Exporta a lista de marca/modelo da frota para preenchimento de CAPACIDADE DE
// TANQUE e MÉDIA ESPERADA de uma vez por família de modelo, em vez de veículo a
// veículo.
//
// Uso:
//   node scripts/exportarModelosVeiculos.js
//   node scripts/exportarModelosVeiculos.js --saida C:/caminho/arquivo.csv
//   node scripts/exportarModelosVeiculos.js --todos     # inclui os já preenchidos
//   node scripts/exportarModelosVeiculos.js --producao  # banco de produção
//
// Depois de preencher, aplique com:
//   node scripts/importarCapacidadeModelos.js --arquivo <csv> --simular
//   node scripts/importarCapacidadeModelos.js --arquivo <csv>
//
// ─────────────────────────────────────────────────────────────────────────────
// AGRUPAMENTO POR FAMÍLIA
//
// A frota tem 246 combinações marca|modelo para 447 veículos, com variações que
// são o mesmo veículo na prática ("OROCH PRO 16" e "OROCH INTENSE16M"). Agrupar
// reduz muito o preenchimento manual.
//
// Mas o agrupamento é CONSERVADOR de propósito: "XE225BR 22,5T" e "XE150BR
// 14,5T" são escavadeiras de portes diferentes, com tanques diferentes. Fundir
// as duas produziria uma capacidade errada para as duas.
//
// Regra: a família é o primeiro token do modelo; se ele for muito curto (até 2
// caracteres, como em "D 416"), leva o segundo junto. Códigos de modelo com
// número ("XE225BR", "31.320") ficam inteiros e portanto não se misturam.
// A coluna `modelos_incluidos` mostra exatamente o que entrou em cada família —
// se algum agrupamento estiver errado, dá para ver ali e corrigir a mão.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { obterConexao, anunciar } = require('../utils/conexaoAlvo');
const consumo = require('../utils/consumo');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valor = (f, padrao) => {
    const i = args.indexOf(f);
    return (i === -1 || i === args.length - 1) ? padrao : args[i + 1];
};

const SAIDA = valor('--saida', path.resolve('docs', 'capacidades_por_modelo.csv'));
const TODOS = flag('--todos');

/** Primeiro token do modelo; se curto demais, leva o segundo junto. */
const familiaDoModelo = (modelo) => {
    const limpo = String(modelo || '').trim().replace(/\s+/g, ' ');
    if (!limpo) return '(sem modelo)';
    const tokens = limpo.split(' ');
    if (tokens[0].length <= 2 && tokens[1]) return `${tokens[0]} ${tokens[1]}`;
    return tokens[0];
};

// CSV para abrir no Excel brasileiro: separador ';' e BOM para acentuação.
const csvCampo = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
    const conexao = await obterConexao();
    anunciar(conexao);
    const db = conexao.db;

    const [veiculos] = await db.query(
        `SELECT id, registroInterno, placa, marca, modelo, tipo, sub_tipo,
                fuelCapacity, media_consumo, percentual_tolerancia
           FROM vehicles
          WHERE ativo IS NULL OR ativo = 1
          ORDER BY marca, modelo`
    );

    // Agrupa por marca + família + tipo. O tipo entra na chave porque a unidade
    // de consumo (Km/L vs L/h) vem dele — misturar tipos numa linha só tornaria
    // a coluna de média ambígua.
    const grupos = new Map();
    for (const v of veiculos) {
        const marca = (v.marca || '').trim() || '(sem marca)';
        const familia = familiaDoModelo(v.modelo);
        const chave = `${marca}|${familia}|${v.tipo || ''}`;

        if (!grupos.has(chave)) {
            grupos.set(chave, {
                marca, familia, tipo: v.tipo || '',
                modelos: new Set(),
                veiculos: [],
                capacidadesExistentes: new Set(),
                mediasExistentes: new Set(),
            });
        }
        const g = grupos.get(chave);
        if (v.modelo) g.modelos.add(String(v.modelo).trim());
        g.veiculos.push(v);
        if (v.fuelCapacity > 0) g.capacidadesExistentes.add(Number(v.fuelCapacity));
        if (v.media_consumo > 0) g.mediasExistentes.add(Number(v.media_consumo));
    }

    // Unidade e média histórica por família, para servir de referência.
    let avisouSemColunas = false;
    const linhas = [];
    for (const g of grupos.values()) {
        const unidade = await consumo.getUnidadeDoTipo(g.tipo, db);

        const ids = g.veiculos.map((v) => v.id);
        let mediaHistorica = null;
        let comHistorico = 0;
        if (ids.length > 0) {
            // `unidade` e `intervalos_validos` só existem depois que as migrações
            // rodaram no boot. Rodando este script contra um banco ainda no código
            // antigo (produção antes do deploy), a query estoura — e a referência
            // histórica é só apoio, não pode impedir a geração do arquivo.
            try {
                const [[agg]] = await db.query(
                    `SELECT ROUND(AVG(avg_last_3), 2) AS media,
                            SUM(intervalos_validos >= 3) AS maduros
                       FROM vehicle_fuel_averages
                      WHERE vehicle_id IN (${ids.map(() => '?').join(',')})
                        AND avg_last_3 IS NOT NULL AND unidade = ?`,
                    [...ids, unidade]
                );
                mediaHistorica = agg?.media ?? null;
                comHistorico = Number(agg?.maduros || 0);
            } catch (e) {
                if (!avisouSemColunas) {
                    console.warn('  ! vehicle_fuel_averages ainda sem as colunas novas '
                        + '(migrações não rodaram neste banco). Coluna ref_media_historica sai vazia.');
                    avisouSemColunas = true;
                }
            }
        }

        // Referência de tanque: percentil 95 dos abastecimentos da família.
        // NÃO o máximo — a frota tem lançamentos de 4216 L numa Fiat Strada
        // (tanque real ~55 L), erro de digitação que destruiria a referência.
        // O p95 acerta bem nos leves; em máquinas SUBESTIMA (elas raramente
        // enchem o tanque), então trate como piso e não como valor.
        let refTanque = null;
        if (ids.length > 0) {
            const [linhasLitros] = await db.query(
                `SELECT litrosAbastecidos AS litros
                   FROM refuelings
                  WHERE vehicleId IN (${ids.map(() => '?').join(',')})
                    AND status = 'Concluída' AND litrosAbastecidos > 0
                  ORDER BY litrosAbastecidos ASC`,
                ids
            );
            const valores = linhasLitros.map((l) => parseFloat(l.litros)).filter((n) => n > 0);
            if (valores.length >= 5) {
                refTanque = Math.round(valores[Math.min(valores.length - 1, Math.floor(valores.length * 0.95))]);
            }
        }

        const jaPreenchido = g.capacidadesExistentes.size > 0 && g.mediasExistentes.size > 0;
        if (!TODOS && jaPreenchido) continue;

        linhas.push({
            marca: g.marca,
            familia: g.familia,
            tipo: g.tipo,
            unidade,
            qtd: g.veiculos.length,
            // Colunas A PREENCHER
            capacidade_tanque_L: g.capacidadesExistentes.size === 1
                ? [...g.capacidadesExistentes][0] : '',
            media_esperada: g.mediasExistentes.size === 1
                ? [...g.mediasExistentes][0] : '',
            tolerancia_pct: '',
            // Colunas de APOIO (não são lidas na importação)
            ref_tanque_p95_L: refTanque ?? '',
            ref_media_historica: mediaHistorica ?? '',
            veiculos_com_historico: comHistorico,
            modelos_incluidos: [...g.modelos].sort().join(' / '),
            exemplos: g.veiculos.slice(0, 3)
                .map((v) => v.registroInterno || v.placa || v.id).join(' / '),
        });
    }

    // Mais veículos primeiro: preencher as famílias grandes já cobre a maior
    // parte da frota, e o resto é cauda longa de unidades isoladas.
    linhas.sort((a, b) => b.qtd - a.qtd || a.marca.localeCompare(b.marca));

    const colunas = [
        'marca', 'familia', 'tipo', 'unidade', 'qtd',
        'capacidade_tanque_L', 'media_esperada', 'tolerancia_pct',
        'ref_tanque_p95_L', 'ref_media_historica', 'veiculos_com_historico',
        'modelos_incluidos', 'exemplos',
    ];

    const csv = [
        colunas.join(';'),
        ...linhas.map((l) => colunas.map((c) => csvCampo(l[c])).join(';')),
    ].join('\r\n');

    fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
    fs.writeFileSync(SAIDA, '\ufeff' + csv, 'utf8');

    const totalVeiculos = linhas.reduce((s, l) => s + l.qtd, 0);
    console.log(`Arquivo gerado: ${SAIDA}`);
    console.log(`${linhas.length} famílias cobrindo ${totalVeiculos} veículo(s).`);
    console.log('');
    console.log('Preencha as colunas: capacidade_tanque_L, media_esperada, tolerancia_pct');
    console.log('  - media_esperada usa a UNIDADE da coluna `unidade` (Km/L para leves, L/h para máquinas)');
    console.log('  - tolerancia_pct em branco assume 20%');
    console.log('  - as colunas ref_* e modelos_incluidos são só apoio; a importação as ignora');
    console.log('');
    console.log('As 10 famílias com mais veículos:');
    linhas.slice(0, 10).forEach((l) => {
        console.log(`  ${String(l.qtd).padStart(3)}x  ${l.marca} ${l.familia}`.padEnd(38)
            + `${l.tipo} (${l.unidade})`.padEnd(34)
            + `ref. p95 ${l.ref_tanque_p95_L || '—'} L`);
    });

    process.exit(0);
})().catch((e) => {
    console.error('Falha:', e.message);
    console.error(e.stack);
    process.exit(1);
});
