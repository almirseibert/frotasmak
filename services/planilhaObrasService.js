// services/planilhaObrasService.js
// ─────────────────────────────────────────────────────────────────────────────
// Leitura da planilha oficial de obras (Google Sheets) → fila de aprovação.
//
// Fluxo (a cada 15 min, ver cronService):
//   1. Lê SÓ a aba SEAPI (lista completa de obras).
//   2. Cada linha é identificada por município + valor (`chave`). O sistema não
//      tem nº de contrato na obra, e há municípios com duas obras SEAPI
//      (Estrela 500.020 × 500.220) — o valor é o que as separa.
//   3. Linha que já existe como obra SEAPI (mesmo nome-base + mesmo valor) entra
//      'vinculada' em silêncio. As demais entram 'pendente'.
//   4. Para cada pendente, procura a aba do plano (`<Município>_RS`), lê o
//      primeiro bloco de itens até o TOTAL e monta o rascunho da obra.
//   5. Nada é criado sozinho: a obra nasce quando alguém aprova na tela de Obras
//      (POST /obras com planilha_import_id).
//
// INERTE POR PADRÃO: só age com PLANILHA_OBRAS_ID e GOOGLE_SERVICE_ACCOUNT_JSON
// (JSON da conta de serviço, puro ou em base64). No ambiente local elas não
// existem — integração externa fica sempre desligada no local.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { carregarTaxonomia } = require('../utils/planoItem');
const { dispatchAsync } = require('./notificationDispatcher');

const PLANILHA_ID = process.env.PLANILHA_OBRAS_ID;
const ABA_LISTA = 'SEAPI';
const ORGAO = 'SEAPI';

// Código da coluna A da aba SEAPI (legenda da própria planilha).
const SITUACOES = {
    1: 'trabalhando',
    2: 'prestacao_contas',
    3: 'finalizado',
    9: 'sem_ordem_inicio',
};

// Item do plano de trabalho → subgrupo do sistema. A descrição vem do catálogo
// da aba VALOR; a ordem importa (RETRO antes de ESCAVADEIRA, ROMPEDOR/LONGO
// ALCANCE antes da tonelagem).
const PRANCHA = '__prancha__';
const CATALOGO = [
    [/PRANCHA/, PRANCHA],
    [/RETRO/, 'Retroescavadeira'],
    [/ROMPEDOR/, 'Escavadeira Hidráulica + Rompedor'],
    [/LONGO ALCANCE/, 'Escavadeira Hidráulica Longo Alcance'],
    [/ESCAVADEIRA.*\b23\b/, 'Escavadeira Hidráulica 23T'],
    [/ESCAVADEIRA.*\b35\b/, 'Escavadeira Hidráulica 35T'],
    [/CACAMBA.*\b7\s*M/, 'Caminhão Caçamba Basculante 7m³'],
    [/CACAMBA.*\b10\s*M/, 'Caminhão Caçamba Basculante 10m³'],
    [/CACAMBA.*\b12\s*M/, 'Caminhão Caçamba Basculante 12m³'],
    [/CACAMBA.*\b14\s*M/, 'Caminhão Caçamba Basculante 14m³'],
    [/CACAMBA.*\b16\s*M/, 'Caminhão Caçamba Basculante 16m³'],
    [/MOTONIVELADORA/, 'Motoniveladora'],
    [/CARREGADEIRA/, 'Pá Carregadeira 11T'],
    [/ROLO/, 'Rolo Compactador'],
    [/ESTEIRA.*\b21\b/, 'Trator Esteira 21T'],
    [/ESTEIRA.*\b36\b/, 'Trator Esteira 36T'],
];

let _running = false;
let _token = null; // { value, exp }
const estado = { ultimaExecucao: null, ultimoErro: null, ultimoResumo: null };

function lerCredencial() {
    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;
    try {
        const texto = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const cred = JSON.parse(texto);
        return cred.client_email && cred.private_key ? cred : null;
    } catch {
        return null;
    }
}

function isConfigured() {
    return Boolean(PLANILHA_ID && lerCredencial());
}

// ── Google Sheets API (conta de serviço, sem SDK) ───────────────────────────
async function getToken() {
    if (_token && _token.exp > Date.now() + 60000) return _token.value;
    const cred = lerCredencial();
    const tokenUri = cred.token_uri || 'https://oauth2.googleapis.com/token';
    const assertion = jwt.sign(
        { iss: cred.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: tokenUri },
        cred.private_key,
        { algorithm: 'RS256', expiresIn: 3600 }
    );
    const { data } = await axios.post(tokenUri, new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    _token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return _token.value;
}

async function sheetsGet(path, params) {
    const token = await getToken();
    const { data } = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA_ID}${path}`, {
        params, headers: { Authorization: `Bearer ${token}` }, timeout: 30000,
    });
    return data;
}

// Fonte padrão (produção). Os testes trocam por outra com a mesma forma.
const fonteGoogle = {
    async listarAbas() {
        const data = await sheetsGet('', { fields: 'sheets.properties.title' });
        return (data.sheets || []).map(s => s.properties.title);
    },
    async lerAba(titulo, intervalo = 'A1:L300') {
        const range = `'${titulo.replace(/'/g, "''")}'!${intervalo}`;
        const data = await sheetsGet(`/values/${encodeURIComponent(range)}`, {
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'FORMATTED_STRING',
        });
        return data.values || [];
    },
};

// ── Helpers de texto/número ─────────────────────────────────────────────────
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();

// "Cruzeiro do Sul 2" / "Estrela (agricultura)" → "CRUZEIRO DO SUL" / "ESTRELA"
const nomeBase = (s) => norm(s).replace(/\(.*?\)/g, '').replace(/\s+\d+$/, '').trim();

// Aceita número (UNFORMATTED_VALUE) ou texto BR ("R$ 1.234,56").
const num = (v) => {
    if (typeof v === 'number') return v;
    const s = String(v ?? '').replace(/[R$\s]/g, '');
    if (!s || s === '-') return 0;
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10); // "1.000"
    const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? n : 0;
};

const ehInteiro = (v) => /^\d+$/.test(String(v ?? '').trim());

// "25/08/2026" → "2026-08-25"
const dataBR = (v) => {
    const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const MINUSCULAS = new Set(['DA', 'DAS', 'DE', 'DO', 'DOS', 'E']);
const titulo = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    .split(' ')
    .map((p, i) => (i > 0 && MINUSCULAS.has(norm(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');

// Distância de edição (Levenshtein) — tolera erro de grafia entre planilha e sistema.
const distancia = (a, b) => {
    let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        ant = cur;
    }
    return ant[b.length];
};

const chaveDe = (municipio, valor) => `${norm(municipio)}|${Math.round(valor * 100)}`;

// ── Aba SEAPI ───────────────────────────────────────────────────────────────
// Colunas posicionadas a partir do cabeçalho "MUNICIPIOS" (as de data/valor não
// têm título). Se o cabeçalho sumir, é mudança de layout: falha alto.
function lerListaSeapi(linhas) {
    const iCab = linhas.findIndex(l => l.some(c => norm(c) === 'MUNICIPIOS'));
    if (iCab < 0) throw new Error(`cabeçalho "MUNICIPIOS" não encontrado na aba ${ABA_LISTA} — layout da planilha mudou?`);
    const cMun = linhas[iCab].findIndex(c => norm(c) === 'MUNICIPIOS');
    const col = { cod: cMun - 1, mun: cMun, fiscal: cMun + 1, contrato: cMun + 2, plano: cMun + 3, valor: cMun + 5, local: cMun + 7, dataLocal: cMun + 8 };

    const obras = [];
    for (const l of linhas.slice(iCab + 1)) {
        const municipio = String(l[col.mun] ?? '').trim();
        if (!municipio || !ehInteiro(l[col.cod])) continue;
        const valor = num(l[col.valor]);
        if (!valor) continue;
        obras.push({
            chave: chaveDe(municipio, valor),
            municipio,
            fiscal: String(l[col.fiscal] ?? '').trim() || null,
            contrato: String(l[col.contrato] ?? '').trim() || null,
            planoOk: norm(l[col.plano]) === 'OK',
            valor,
            situacao: SITUACOES[parseInt(l[col.cod], 10)] || null,
            // "início 14/09/2026" ou "prev. início 03/11/2026"; para finalizadas a coluna é outra coisa.
            dataInicioPrevista: /INICIO/.test(norm(l[col.local])) ? dataBR(l[col.dataLocal]) : null,
        });
    }
    return obras;
}

// ── Aba do plano ────────────────────────────────────────────────────────────
const ABAS_IGNORADAS = /^(COPIA DE|SUGESTAO|PAGINA\s*\d*$|VALOR$|SEAPI$|H MAQ$)/;
const nomeDaAba = (t) => norm(t).replace(/_RS$/, '').trim();

// Candidatas: nome igual, ou nome + sufixo numérico ("Estrela 015_RS",
// "Cruzeiro do Sul 2_RS"). Quem decide entre elas é o TOTAL do plano.
function abasCandidatas(abas, municipio) {
    const alvo = norm(municipio);
    return abas.filter(t => {
        if (ABAS_IGNORADAS.test(norm(t))) return false;
        const n = nomeDaAba(t);
        return n === alvo || (n.startsWith(alvo + ' ') && /^\d+$/.test(n.slice(alvo.length + 1)));
    }).sort((a, b) => nomeDaAba(a).length - nomeDaAba(b).length); // nome exato primeiro
}

// Primeiro bloco de itens (linhas numeradas após "ITENS") até a linha de TOTAL.
// Blocos seguintes (divisão por metas) somam o mesmo valor e são ignorados.
function lerPlano(linhas) {
    let iCab = linhas.findIndex(l => norm(l[0]) === 'ITENS');
    const cUn = iCab >= 0 ? linhas[iCab].findIndex(c => norm(c) === 'UNIDADE') : -1;
    if (iCab < 0 || cUn < 0) return null;
    const col = { qtd: cUn - 1, unit: cUn + 1, total: cUn + 2 };

    const itens = [];
    let total = null;
    for (const l of linhas.slice(iCab + 1)) {
        if (ehInteiro(l[0]) && String(l[1] ?? '').trim()) {
            itens.push({
                descricao: String(l[1]).trim().replace(/\s+/g, ' '),
                quantidade: num(l[col.qtd]),
                valorUnitario: num(l[col.unit]),
                total: num(l[col.total]),
            });
            continue;
        }
        if (itens.length) { total = num(l[col.total]) || null; break; }
    }
    return itens.length ? { itens, total } : null;
}

// Converte os itens lidos no formato da obra (mesmo payload do ObraModal).
function montarRascunho(plano, subgruposValidos) {
    const horas = {};
    const valores = {};
    const semSubgrupo = [];
    let kmPrancha = 0;
    let valorKmPrancha = 0;

    for (const it of plano.itens) {
        const sub = (CATALOGO.find(([re]) => re.test(norm(it.descricao))) || [])[1];
        if (sub === PRANCHA) {
            kmPrancha += it.quantidade;
            valorKmPrancha = it.valorUnitario;
            continue;
        }
        if (!sub || !subgruposValidos.has(sub)) { semSubgrupo.push(it.descricao); continue; }
        if (!it.quantidade) continue;
        // Mesmo subgrupo duas vezes: soma horas e pondera o preço.
        const h0 = horas[sub] || 0;
        const h = h0 + it.quantidade;
        valores[sub] = Math.round((((valores[sub] || 0) * h0) + it.valorUnitario * it.quantidade) / h * 100) / 100;
        horas[sub] = h;
    }

    const somaItens = plano.itens.reduce((s, it) => s + (it.total || it.quantidade * it.valorUnitario), 0);
    return {
        itens: plano.itens,
        totalPlanilha: plano.total,
        somaItens: Math.round(somaItens * 100) / 100,
        horasContratadasPorSubTipo: horas,
        valoresPorSubTipo: valores,
        kmContratadoPrancha: kmPrancha,
        valorKmPrancha,
        semSubgrupo,
    };
}

async function prepararPlano(fonte, abas, linha, subgruposValidos) {
    const alertas = [];
    if (!linha.planoOk) alertas.push({ tipo: 'plano_pendente', msg: 'Coluna "P. TRABALHO" ainda não está como OK na planilha.' });

    const candidatas = abasCandidatas(abas, linha.municipio);
    if (!candidatas.length) {
        alertas.push({ tipo: 'sem_aba', msg: `Aba do plano de trabalho não encontrada (esperado "${titulo(linha.municipio)}_RS").` });
        return { aba: null, plano: null, alertas };
    }

    let escolhida = null;
    for (const aba of candidatas) {
        const plano = lerPlano(await fonte.lerAba(aba, 'A1:L120'));
        if (!plano) continue;
        const rascunho = montarRascunho(plano, subgruposValidos);
        const total = rascunho.totalPlanilha ?? rascunho.somaItens;
        if (!escolhida) escolhida = { aba, rascunho };
        if (Math.abs(total - linha.valor) < 0.5) { escolhida = { aba, rascunho }; break; }
    }
    if (!escolhida) {
        alertas.push({ tipo: 'plano_ilegivel', msg: `Aba "${candidatas[0]}" encontrada, mas sem a tabela de itens no formato esperado.` });
        return { aba: candidatas[0], plano: null, alertas };
    }

    const { aba, rascunho } = escolhida;
    const total = rascunho.totalPlanilha ?? rascunho.somaItens;
    if (Math.abs(total - linha.valor) >= 0.5) {
        alertas.push({ tipo: 'total_diverge', msg: `Total do plano (${fmtBRL(total)}) diferente do valor na aba SEAPI (${fmtBRL(linha.valor)}).` });
    }
    if (rascunho.semSubgrupo.length) {
        alertas.push({ tipo: 'sem_subgrupo', msg: `Itens sem subgrupo no sistema (incluir à mão): ${rascunho.semSubgrupo.join(', ')}.` });
    }
    return { aba, plano: rascunho, alertas };
}

const fmtBRL = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Sincronização ───────────────────────────────────────────────────────────
async function sincronizar({ fonte = fonteGoogle, relerPlanos = false } = {}) {
    if (fonte === fonteGoogle && !isConfigured()) return null;
    if (_running) return { emAndamento: true };
    _running = true;
    const resumo = { lidas: 0, novas: 0, vinculadas: 0, planosAtualizados: 0 };
    try {
        const lista = lerListaSeapi(await fonte.lerAba(ABA_LISTA));
        resumo.lidas = lista.length;

        const [existentes] = await db.query('SELECT chave, status, plano_json, alertas_json FROM obras_planilha');
        const porChave = new Map(existentes.map(r => [r.chave, r]));
        const [obras] = await db.query(
            "SELECT id, nome, valorTotalContrato FROM obras WHERE orgao_contratante = ? AND (tipo_registro IS NULL OR tipo_registro <> 'centro_custo')",
            [ORGAO]
        );
        const [jaVinculadas] = await db.query('SELECT obra_id FROM obras_planilha WHERE obra_id IS NOT NULL');
        const obrasUsadas = new Set(jaVinculadas.map(r => r.obra_id));

        let abas = null;
        let subgruposValidos = null;
        const carregarApoio = async () => {
            if (abas) return;
            abas = await fonte.listarAbas();
            subgruposValidos = new Set((await carregarTaxonomia(db)).keys());
        };

        for (const linha of lista) {
            const atual = porChave.get(linha.chave);

            if (!atual) {
                // Valor igual + nome parecido: igual, um prefixo do outro ("SANTA
                // CLARA" × "Santa Clara do Sul") ou até 2 letras de diferença
                // ("VALENTIN" × "Valentim").
                const a = nomeBase(linha.municipio);
                const mesma = obras.find(o => {
                    if (obrasUsadas.has(o.id) || Math.abs(Number(o.valorTotalContrato) - linha.valor) >= 0.5) return false;
                    const b = nomeBase(o.nome);
                    return a === b || b.startsWith(a + ' ') || a.startsWith(b + ' ') || distancia(a, b) <= 2;
                });
                if (mesma) {
                    obrasUsadas.add(mesma.id);
                    await inserir(linha, { status: 'vinculada', obraId: mesma.id, resolvidoPor: 'automático' });
                    resumo.vinculadas++;
                    continue;
                }
                await carregarApoio();
                const { aba, plano, alertas } = await prepararPlano(fonte, abas, linha, subgruposValidos);
                const homonimas = obras.filter(o => nomeBase(o.nome) === nomeBase(linha.municipio));
                if (homonimas.length) {
                    alertas.unshift({
                        tipo: 'homonima',
                        msg: `Já existe obra ${ORGAO} "${homonimas.map(o => `${o.nome} (${fmtBRL(o.valorTotalContrato)})`).join('", "')}". Pode ser aditivo — se for a mesma, use "Vincular".`,
                    });
                }
                await inserir(linha, { status: 'pendente', aba, plano, alertas });
                resumo.novas++;
                dispatchAsync('obra_planilha_nova', {
                    nome: titulo(linha.municipio),
                    valor: fmtBRL(linha.valor),
                    contrato: linha.contrato || '—',
                });
                continue;
            }

            // Pendente sem plano legível: a aba pode ter sido criada depois. Tenta de novo.
            // "Verificar agora" (relerPlanos) relê também os que já têm plano.
            if (atual.status !== 'pendente') continue;
            if (atual.plano_json && !relerPlanos) continue;
            await carregarApoio();
            const { aba, plano, alertas } = await prepararPlano(fonte, abas, linha, subgruposValidos);
            const homonima = (parseJson(atual.alertas_json) || []).find(a => a.tipo === 'homonima');
            if (homonima) alertas.unshift(homonima);
            await db.query(
                `UPDATE obras_planilha SET fiscal = ?, contrato = ?, situacao = ?, data_inicio_prevista = ?,
                        aba = ?, plano_json = ?, alertas_json = ? WHERE chave = ? AND status = 'pendente'`,
                [linha.fiscal, linha.contrato, linha.situacao, linha.dataInicioPrevista,
                 aba, plano ? JSON.stringify(plano) : null, JSON.stringify(alertas), linha.chave]
            );
            resumo.planosAtualizados++;
        }

        estado.ultimoErro = null;
        estado.ultimoResumo = resumo;
        if (resumo.novas || resumo.vinculadas || resumo.planosAtualizados) {
            console.log(`📄 [PLANILHA-OBRAS] ${resumo.lidas} linhas · ${resumo.novas} nova(s) · ${resumo.vinculadas} vinculada(s) · ${resumo.planosAtualizados} plano(s) relido(s)`);
            if (global.io) global.io.emit('server:sync', { targets: ['obras_planilha'] });
        }
        return resumo;
    } catch (e) {
        estado.ultimoErro = e.response?.data?.error?.message || e.message;
        throw e;
    } finally {
        estado.ultimaExecucao = new Date();
        _running = false;
    }
}

async function inserir(linha, { status, obraId = null, aba = null, plano = null, alertas = [], resolvidoPor = null }) {
    await db.query(
        `INSERT IGNORE INTO obras_planilha
            (chave, municipio, fiscal, contrato, valor, situacao, data_inicio_prevista, aba, plano_json, alertas_json,
             status, obra_id, resolvido_em, resolvido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [linha.chave, linha.municipio, linha.fiscal, linha.contrato, linha.valor, linha.situacao,
         linha.dataInicioPrevista, aba, plano ? JSON.stringify(plano) : null, JSON.stringify(alertas),
         status, obraId, status === 'pendente' ? null : new Date(), resolvidoPor]
    );
}

const parseJson = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

module.exports = {
    isConfigured,
    sincronizar,
    estado,
    titulo,
    nomeBase,
    parseJson,
    // expostos para teste
    lerListaSeapi,
    lerPlano,
    abasCandidatas,
};
