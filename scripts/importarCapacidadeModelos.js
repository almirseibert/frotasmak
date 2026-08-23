// Aplica o CSV preenchido por scripts/exportarModelosVeiculos.js: replica
// capacidade de tanque, média esperada e tolerância para TODOS os veículos de
// cada família de modelo.
//
// Uso:
//   node scripts/importarCapacidadeModelos.js --simular          # não grava nada
//   node scripts/importarCapacidadeModelos.js
//   node scripts/importarCapacidadeModelos.js --arquivo outro.csv
//   node scripts/importarCapacidadeModelos.js --sobrescrever     # troca valores já preenchidos
//   node scripts/importarCapacidadeModelos.js --producao          # banco de produção
//
// SEMPRE rode com --simular primeiro. Sem --sobrescrever, veículos que já têm
// valor cadastrado são preservados: o preenchimento em massa não deve apagar um
// ajuste que alguém fez à mão para um veículo específico.
//
// A média é gravada em vehicles.media_consumo, na UNIDADE DO GRUPO do veículo
// (Km/L para leves e Caminhões de Trecho, L/h para o resto) — a mesma unidade
// que o VehicleModal mostra e que utils/consumo espera.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { obterConexao, anunciar } = require('../utils/conexaoAlvo');
const consumo = require('../utils/consumo');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valorFlag = (f, padrao) => {
    const i = args.indexOf(f);
    return (i === -1 || i === args.length - 1) ? padrao : args[i + 1];
};

const ARQUIVO = valorFlag('--arquivo', path.resolve('docs', 'capacidades_por_modelo.csv'));
const SIMULAR = flag('--simular');
const SOBRESCREVER = flag('--sobrescrever');

/** Mesma regra de família do script de exportação — precisa bater exatamente. */
const familiaDoModelo = (modelo) => {
    const limpo = String(modelo || '').trim().replace(/\s+/g, ' ');
    if (!limpo) return '(sem modelo)';
    const tokens = limpo.split(' ');
    if (tokens[0].length <= 2 && tokens[1]) return `${tokens[0]} ${tokens[1]}`;
    return tokens[0];
};

// Excel brasileiro salva com ';' e pode manter o BOM. Aceita ',' decimal.
const numeroBR = (v) => {
    if (v == null) return null;
    const limpo = String(v).trim().replace(/\s/g, '').replace(/\./g, '#').replace(',', '.');
    // '1.234,56' -> '1#234.56' -> remove os '#' de milhar
    const n = parseFloat(limpo.replace(/#/g, ''));
    return isNaN(n) ? null : n;
};

const parseCsv = (texto) => {
    const linhas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (linhas.length < 2) return [];
    const cab = linhas[0].split(';').map((c) => c.trim());

    return linhas.slice(1).map((linha) => {
        // Campos podem vir entre aspas se contiverem ';'
        const campos = [];
        let atual = '';
        let dentroAspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (ch === '"') {
                if (dentroAspas && linha[i + 1] === '"') { atual += '"'; i++; }
                else dentroAspas = !dentroAspas;
            } else if (ch === ';' && !dentroAspas) {
                campos.push(atual); atual = '';
            } else {
                atual += ch;
            }
        }
        campos.push(atual);

        const obj = {};
        cab.forEach((c, i) => { obj[c] = (campos[i] ?? '').trim(); });
        return obj;
    });
};

(async () => {
    if (!fs.existsSync(ARQUIVO)) {
        console.error(`Arquivo não encontrado: ${ARQUIVO}`);
        console.error('Gere primeiro com: node scripts/exportarModelosVeiculos.js');
        process.exit(1);
    }

    const conexao = await obterConexao();
    anunciar(conexao);
    const db = conexao.db;

    const linhas = parseCsv(fs.readFileSync(ARQUIVO, 'utf8'));
    console.log(`${linhas.length} linha(s) lidas de ${ARQUIVO}`);
    if (SIMULAR) console.log('MODO SIMULAÇÃO — nada será gravado.');
    console.log('');

    const [veiculos] = await db.query(
        `SELECT id, registroInterno, placa, marca, modelo, tipo,
                fuelCapacity, media_consumo, percentual_tolerancia
           FROM vehicles
          WHERE ativo IS NULL OR ativo = 1`
    );

    // Indexa a frota por marca|familia|tipo, a mesma chave da exportação.
    const porChave = new Map();
    // E também por modelo|tipo, para o casamento de reserva (ver abaixo).
    const porModelo = new Map();
    for (const v of veiculos) {
        const chave = `${((v.marca || '').trim() || '(sem marca)').toUpperCase()}|`
            + `${familiaDoModelo(v.modelo).toUpperCase()}|${(v.tipo || '').toUpperCase()}`;
        if (!porChave.has(chave)) porChave.set(chave, []);
        porChave.get(chave).push(v);

        const chaveModelo = `${String(v.modelo || '').trim().toUpperCase()}|${(v.tipo || '').toUpperCase()}`;
        if (!porModelo.has(chaveModelo)) porModelo.set(chaveModelo, []);
        porModelo.get(chaveModelo).push(v);
    }

    // CASAMENTO DE RESERVA pelos modelos exatos da coluna `modelos_incluidos`.
    //
    // A chave primária (marca|familia|tipo) é frágil a duas coisas que acontecem
    // de verdade ao editar a planilha:
    //
    //  1. Excel transforma códigos de modelo em notação científica. O IVECO
    //     "240E25" virou "2,40E+27" e a família deixou de casar.
    //  2. Quem preenche corrige cadastro errado. O RE517 tem marca "16" no banco;
    //     corrigir para "VOLKSWAGEN" na planilha é o certo do ponto de vista do
    //     dado, mas quebra a junção.
    //
    // `modelos_incluidos` guarda os modelos exatos que o export encontrou, então
    // serve de âncora estável. O casamento de reserva é reportado, nunca silencioso.
    const casarPorModelos = (linha) => {
        const brutos = String(linha.modelos_incluidos || '').split('/');
        const tipo = (linha.tipo || '').toUpperCase();
        const encontrados = new Map();
        for (const m of brutos) {
            const chave = `${m.trim().toUpperCase()}|${tipo}`;
            for (const v of (porModelo.get(chave) || [])) encontrados.set(v.id, v);
        }
        return [...encontrados.values()];
    };

    let familiasAplicadas = 0;
    let veiculosTanque = 0;
    let veiculosMedia = 0;
    let preservados = 0;
    const semCorrespondencia = [];
    const avisos = [];

    for (const linha of linhas) {
        const capacidade = numeroBR(linha.capacidade_tanque_L);
        const media = numeroBR(linha.media_esperada);
        const tolerancia = numeroBR(linha.tolerancia_pct);

        if (!(capacidade > 0) && !(media > 0)) continue; // linha não preenchida

        const chave = `${(linha.marca || '').toUpperCase()}|`
            + `${(linha.familia || '').toUpperCase()}|${(linha.tipo || '').toUpperCase()}`;
        let alvo = porChave.get(chave);

        if (!alvo || alvo.length === 0) {
            alvo = casarPorModelos(linha);
            if (alvo.length > 0) {
                avisos.push(`${linha.marca} ${linha.familia} (${linha.tipo}): marca/família não `
                    + `casaram, mas os modelos sim — aplicado a ${alvo.length} veículo(s) `
                    + `[${alvo.map((v) => v.registroInterno || v.placa).join(', ')}].`);
            }
        }

        if (!alvo || alvo.length === 0) {
            semCorrespondencia.push(`${linha.marca} ${linha.familia} (${linha.tipo})`);
            continue;
        }

        // Conferência de unidade: a média foi preenchida na unidade certa?
        const unidadeReal = await consumo.getUnidadeDoTipo(alvo[0].tipo, db);
        if (linha.unidade && linha.unidade !== unidadeReal) {
            avisos.push(`${linha.marca} ${linha.familia}: CSV diz ${linha.unidade}, `
                + `mas o grupo do veículo usa ${unidadeReal}. Média NÃO aplicada.`);
        }
        const podeAplicarMedia = media > 0 && (!linha.unidade || linha.unidade === unidadeReal);

        familiasAplicadas++;
        const detalhes = [];

        for (const v of alvo) {
            const campos = [];
            const valores = [];

            if (capacidade > 0) {
                if (!(v.fuelCapacity > 0) || SOBRESCREVER) {
                    campos.push('fuelCapacity = ?'); valores.push(capacidade);
                    veiculosTanque++;
                } else { preservados++; }
            }
            if (podeAplicarMedia) {
                if (!(v.media_consumo > 0) || SOBRESCREVER) {
                    campos.push('media_consumo = ?'); valores.push(media);
                    veiculosMedia++;
                } else { preservados++; }
            }
            if (tolerancia > 0 && (SOBRESCREVER || !(v.percentual_tolerancia > 0))) {
                campos.push('percentual_tolerancia = ?'); valores.push(tolerancia);
            }

            if (campos.length === 0) continue;
            detalhes.push(v.registroInterno || v.placa || v.id);

            if (!SIMULAR) {
                valores.push(v.id);
                await db.query(`UPDATE vehicles SET ${campos.join(', ')} WHERE id = ?`, valores);
            }
        }

        if (detalhes.length > 0) {
            console.log(`  ${linha.marca} ${linha.familia} (${linha.tipo}) — ${detalhes.length} veículo(s)`
                + `${capacidade > 0 ? `  tanque=${capacidade}L` : ''}`
                + `${podeAplicarMedia ? `  média=${media} ${unidadeReal}` : ''}`);
        }
    }

    console.log('');
    console.log('─'.repeat(60));
    console.log(`Famílias aplicadas:        ${familiasAplicadas}`);
    console.log(`Capacidade de tanque:      ${veiculosTanque} veículo(s)`);
    console.log(`Média esperada:            ${veiculosMedia} veículo(s)`);
    if (preservados > 0) {
        console.log(`Preservados (já tinham):   ${preservados}  — use --sobrescrever para trocar`);
    }

    if (avisos.length > 0) {
        console.log('');
        console.log('AVISOS:');
        avisos.forEach((a) => console.log('  ! ' + a));
    }

    if (semCorrespondencia.length > 0) {
        console.log('');
        console.log(`${semCorrespondencia.length} linha(s) sem veículo correspondente `
            + '(marca/família/tipo foram editados no CSV?):');
        semCorrespondencia.slice(0, 15).forEach((s) => console.log('  - ' + s));
        if (semCorrespondencia.length > 15) console.log(`  ... e mais ${semCorrespondencia.length - 15}`);
    }

    if (SIMULAR) {
        console.log('');
        console.log('Nada foi gravado. Rode sem --simular para aplicar.');
    } else if (veiculosTanque > 0 || veiculosMedia > 0) {
        console.log('');
        console.log('Aplicado. As médias esperadas passam a valer no portão G2 imediatamente;');
        console.log('a capacidade de tanque, no G3 (pedidos de tanque cheio).');
    }

    process.exit(0);
})().catch((e) => {
    console.error('Falha:', e.message);
    console.error(e.stack);
    process.exit(1);
});
