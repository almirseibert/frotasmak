// scripts/auditar-sobreposicoes-obra.js
//
// Lista os veículos que aparecem em duas obras no mesmo dia
// (obras_historico_veiculos). Somente leitura — a correção é feita no
// histórico de cada obra. Regra de "dia" em utils/periodosObra.js.
//
//   node scripts/auditar-sobreposicoes-obra.js          # tabela
//   node scripts/auditar-sobreposicoes-obra.js --json   # JSON bruto
require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.local', override: true, quiet: true });

const db = require('../database');
const { listarSobreposicoes } = require('../utils/periodosObra');

const br = (d) => (d ? d.split('-').reverse().join('/') : 'em aberto');

(async () => {
    try {
        const lista = await listarSobreposicoes(db);
        if (process.argv.includes('--json')) {
            console.log(JSON.stringify(lista, null, 2));
        } else if (lista.length === 0) {
            console.log('✅ Nenhum veículo em duas obras no mesmo dia.');
        } else {
            console.log(`⚠️  ${lista.length} sobreposição(ões) em ${new Set(lista.map(s => s.veiculoId)).size} veículo(s):\n`);
            for (const s of lista) {
                console.log(`${s.placa || '-'} (${s.registroInterno || '-'}) — ${s.diasEmComum} dia(s) em comum`);
                console.log(`   ${s.a.obraNome}: ${br(s.a.dataEntrada)} → ${br(s.a.dataSaida)}`);
                console.log(`   ${s.b.obraNome}: ${br(s.b.dataEntrada)} → ${br(s.b.dataSaida)}\n`);
            }
        }
    } catch (err) {
        console.error('❌', err.message);
        process.exitCode = 1;
    } finally {
        await db.end();
        process.exit();
    }
})();
