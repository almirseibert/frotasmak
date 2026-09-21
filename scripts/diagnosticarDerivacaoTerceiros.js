// Diagnóstico da derivação máquina ↔ contrato de terceiro (somente leitura).
//
// Depois que a máquina deixou de ser digitada no contrato, ela passa a ser derivada de
//   terceiro (vehicles.locadorId) × obra do lançamento × subgrupo × data na vigência.
// Quando um contrato vigente aparece com "0 máquina(s)" na tela, o elo quebrado está
// no CADASTRO — e este script diz exatamente qual.
//
// Uso:  node scripts/diagnosticarDerivacaoTerceiros.js

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../database');
const { STATUS_ENCERRADOS, veiculoElegivel, subgruposDoContrato } = require('../utils/terceirosCusto');

const linha = (n = 78) => console.log('─'.repeat(n));

(async () => {
    const [contratos] = await db.query(
        `SELECT c.id, c.numero, c.locadorId, c.obraId, c.itensContratados, c.maquinas,
                c.vigenciaInicio, c.vigenciaFim, c.status,
                p.razaoSocial, p.nomeFantasia, o.nome AS obraNome
           FROM terceiro_contratos c
           LEFT JOIN partners p ON p.id = c.locadorId
           LEFT JOIN obras    o ON o.id = c.obraId
          WHERE c.status NOT IN (${STATUS_ENCERRADOS.map(() => '?').join(',')})
          ORDER BY p.razaoSocial`, STATUS_ENCERRADOS);

    const [veiculos] = await db.query(
        `SELECT id, registroInterno, placa, locadorId, isOutsourced, tipo, sub_tipo, obraAtualId
           FROM vehicles WHERE isOutsourced = 1 OR locadorId IS NOT NULL`);

    const porLocador = new Map();
    veiculos.forEach((v) => {
        const k = String(v.locadorId || '—');
        if (!porLocador.has(k)) porLocador.set(k, []);
        porLocador.get(k).push(v);
    });

    // Vocabulário: o que os contratos pedem vs. o que os veículos declaram. É aqui que
    // o descasamento aparece — "Escavadeira 20t" no contrato vs. "Escavadeira 20T" no
    // veículo não casa, e o diesel inteiro fica sem abater.
    const tiposContratados = new Set();
    contratos.forEach((c) => subgruposDoContrato(c).forEach((t) => tiposContratados.add(t)));
    const tiposVeiculos = new Set();
    veiculos.forEach((v) => tiposVeiculos.add(String(v.sub_tipo || v.tipo || '(vazio)').trim()));

    let zerados = 0;
    const causas = {};
    const conta = (k) => { causas[k] = (causas[k] || 0) + 1; };

    console.log('\nCONTRATOS VIGENTES SEM NENHUMA MÁQUINA ELEGÍVEL');
    linha();
    contratos.forEach((c) => {
        const candidatos = porLocador.get(String(c.locadorId)) || [];
        const elegiveis = candidatos.filter((v) => veiculoElegivel(v, c));
        if (elegiveis.length > 0) return;
        zerados += 1;

        const nome = c.nomeFantasia || c.razaoSocial || '(sem terceiro)';
        const subs = subgruposDoContrato(c);
        console.log(`\n${c.numero || c.id} · ${nome} · ${c.obraNome || c.obraId}`);
        console.log(`   contrato pede: ${subs.length ? subs.join(' | ') : '(nenhum subgrupo declarado)'}`);

        if (candidatos.length === 0) {
            console.log('   ✗ o terceiro não tem NENHUM veículo no cadastro com este locadorId');
            conta('terceiro sem veículo cadastrado');
            return;
        }
        candidatos.forEach((v) => {
            const id = v.registroInterno || v.placa || v.id;
            const decl = String(v.sub_tipo || v.tipo || '').trim();
            if (!v.isOutsourced) { console.log(`   ✗ ${id}: não está marcado como terceirizado`); conta('veículo sem isOutsourced'); }
            else if (!decl)      { console.log(`   ✗ ${id}: sem tipo/subgrupo no cadastro`);       conta('veículo sem subgrupo'); }
            else                 { console.log(`   ✗ ${id}: declara "${decl}", fora do contrato`); conta('subgrupo não bate'); }
        });
    });

    console.log(`\n\nRESUMO — ${zerados} de ${contratos.length} contrato(s) vigente(s) sem máquina elegível`);
    linha();
    Object.entries(causas).sort((a, b) => b[1] - a[1])
        .forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}  ${k}`));

    console.log('\n\nVOCABULÁRIO — subgrupo pedido em contrato que NENHUM veículo declara');
    linha();
    const orfaos = [...tiposContratados].filter((t) => !tiposVeiculos.has(t));
    if (orfaos.length === 0) console.log('   (nenhum: todo subgrupo contratado existe em algum veículo)');
    orfaos.forEach((t) => {
        // Sugere o parecido: quase sempre é caixa/acento/espaço, não conceito diferente.
        const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
        const perto = [...tiposVeiculos].filter((x) => norm(x) === norm(t));
        console.log(`   "${t}"${perto.length ? `   → existe como: ${perto.map((x) => `"${x}"`).join(', ')}` : ''}`);
    });

    // ── Collation real DESTE banco ───────────────────────────────────────────
    // A derivação compara subgrupo e status em JavaScript, onde a comparação é sempre
    // exata. O MySQL pode não ser: numa collation `_ai_ci` (accent/case-insensitive),
    // "Escavadeira 20T" e "Escavadeira 20t" são a MESMA string para o banco — toda
    // query casa e ninguém percebe, até um cálculo em JS perder a linha.
    // Não dá para assumir pelo DDL: cada tabela herdou a collation padrão do servidor
    // na época em que foi criada, e produção pode diferir do ambiente de desenvolvimento.
    console.log('\n\nCOLLATION DAS COLUNAS QUE A DERIVAÇÃO COMPARA EM JS');
    linha();
    try {
        const [cols] = await db.query(`
            SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND ((TABLE_NAME = 'vehicles'             AND COLUMN_NAME IN ('tipo','sub_tipo'))
                 OR (TABLE_NAME = 'terceiro_contratos'   AND COLUMN_NAME = 'itensContratados')
                 OR (TABLE_NAME = 'refuelings'           AND COLUMN_NAME = 'status')
                 OR (TABLE_NAME = 'comboio_transactions' AND COLUMN_NAME = 'status'))
             ORDER BY TABLE_NAME, COLUMN_NAME`);
        cols.forEach((c) => {
            const col = c.COLLATION_NAME || '(não textual)';
            const ai = /_ai_|_general_ci$|_unicode_ci$/.test(col);
            const ci = /_ci$/.test(col);
            const nota = c.COLLATION_NAME
                ? `   ${ai ? 'ignora acento' : 'DIFERENCIA acento'} · ${ci ? 'ignora caixa' : 'DIFERENCIA caixa'}`
                : '';
            console.log(`   ${c.TABLE_NAME}.${c.COLUMN_NAME}`.padEnd(46) + col + nota);
        });
        console.log('\n   Banco IGNORA acento/caixa e o JS não → o JS perde linhas que toda');
        console.log('   query enxerga. Banco DIFERENCIA → normalizar no JS criaria o problema');
        console.log('   inverso. A correção depende desta saída.');
    } catch (e) {
        console.log('   não foi possível ler information_schema:', e.message);
    }

    // Grafias realmente gravadas. O BINARY é essencial: sem ele, numa collation
    // accent-insensitive o próprio GROUP BY juntaria "Concluída" e "Concluida" numa
    // linha só — o problema ficaria invisível justamente na consulta que o procura.
    console.log('\n\nGRAFIAS DE STATUS REALMENTE GRAVADAS (comparação binária)');
    linha();
    for (const tabela of ['refuelings', 'comboio_transactions']) {
        try {
            const [rows] = await db.query(
                `SELECT status AS v, COUNT(*) AS n FROM ${tabela} GROUP BY BINARY status ORDER BY n DESC`);
            console.log(`\n   ${tabela}.status:`);
            rows.forEach((r) => console.log(`      ${String(r.n).padStart(7)}  "${r.v}"`));
        } catch (e) {
            console.log(`   ${tabela}: ${e.message}`);
        }
    }

    // Mesma checagem para o vocabulário de subgrupo: variantes que só diferem em
    // acento/caixa são o suspeito número um dos contratos com "0 máquina(s)".
    console.log('\n\nSUBGRUPOS GRAVADOS EM vehicles (comparação binária)');
    linha();
    try {
        const [rows] = await db.query(`
            SELECT COALESCE(NULLIF(sub_tipo, ''), tipo) AS v, COUNT(*) AS n
              FROM vehicles WHERE isOutsourced = 1
             GROUP BY BINARY COALESCE(NULLIF(sub_tipo, ''), tipo) ORDER BY v`);
        const norm = (x) => String(x || '').toLowerCase().normalize('NFD')
            .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
        const vistos = new Map();
        rows.forEach((r) => {
            const k = norm(r.v);
            if (!vistos.has(k)) vistos.set(k, []);
            vistos.get(k).push(`"${r.v}" (${r.n})`);
        });
        const variantes = [...vistos.values()].filter((g) => g.length > 1);
        variantes.forEach((g) => console.log(`   ⚠ iguais para o banco, diferentes para o JS: ${g.join(' · ')}`));
        if (variantes.length === 0) console.log('   (nenhuma variante: cada subgrupo tem uma grafia só)');
    } catch (e) {
        console.log('   falhou:', e.message);
    }

    console.log('');
    process.exit(0);
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
