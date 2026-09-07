// data/partCatalogSeed.js
// ─────────────────────────────────────────────────────────────────────────────
// Dataset de REFERÊNCIA do Guia de Peças e Reposição.
//
// IMPORTANTE (leia antes de "corrigir" valores):
//  - Todos os itens entram com status_validacao = 'referencia'. São códigos e
//    equivalências PUBLICADAS em catálogos de autopeças (Tecfil, Wega, Mann,
//    Fleetguard, Donaldson, OEM), coletadas por pesquisa — NÃO são OEM garantido
//    por VIN/chassi. A oficina confirma pelo manual e muda para 'confirmado'.
//  - Filtros de caminhão/máquina variam MUITO por motor/ano/versão. Onde há essa
//    variação a `observacao` avisa "confirmar por motor/versão".
//  - Onde não há dado público confiável (algumas máquinas chinesas), o item fica
//    genérico com observacao "não confirmado" e SEM código — nunca inventado.
//  - Seed só roda quando part_catalog_models está vazia (ver server.js).
//  - Códigos coletados em ~2026-09 de catálogos de varejo/fabricante.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { normalizeText, normalizeMarca } = require('../utils/partCatalog');

const FONTE = 'Catálogos de autopeças/fabricante (referência) — validar na oficina';

// Helper de item. o = { espec, cap, qtd, oem, eq, km, h, meses, obs, fonte }
const it = (categoria, descricao, o = {}) => ({
    categoria,
    descricao,
    especificacao: o.espec ?? null,
    capacidade: o.cap ?? null,
    quantidade: o.qtd ?? null,
    codigo_oem: o.oem ?? null,
    codigos_equivalentes: o.eq ?? [],
    intervalo_km: o.km ?? null,
    intervalo_horas: o.h ?? null,
    intervalo_meses: o.meses ?? null,
    observacoes: o.obs ?? null,
    fonte: o.fonte ?? FONTE,
});
// eq(['Tecfil','PEL727'], ['Mann','W950']) → [{marca,codigo}, ...]
const eq = (...pairs) => pairs.map(([marca, codigo]) => ({ marca, codigo }));

// Óleo de motor: item de spec (sem código de peça).
const oleoMotor = (espec, cap, { km = null, h = null, meses = 6 } = {}) =>
    it('oleo_motor', `Óleo do motor ${espec}`, { espec, cap, km, h, meses });

// ─────────────────────────────────────────────────────────────────────────────
const MODELOS = [
    // =========================================================================
    // LEVES (melhor cobertura de equivalências públicas)
    // =========================================================================
    {
        marca: 'Fiat', modelo: 'Toro', categoria_veiculo: 'leve',
        obs: 'Diesel 2.0 (MultiJet). Flex 1.8/1.3T usa outros filtros — confirmar motorização.',
        itens: [
            oleoMotor('5W-30 (diesel)', '~4,5 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL727', { km: 10000, meses: 12, eq: eq(['Tecfil', 'PEL727'], ['Wega', 'WOE1030']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARL4157', { km: 20000, eq: eq(['Tecfil', 'ARL4157']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PEC3041', { km: 20000, eq: eq(['Tecfil', 'PEC3041'], ['Wega', 'FCD3041']) }),
            it('filtro_cabine', 'Filtro de cabine — Tecfil ACP907', { km: 15000, meses: 12, eq: eq(['Tecfil', 'ACP907']) }),
        ],
    },
    {
        marca: 'Chevrolet', modelo: 'S10', categoria_veiculo: 'leve',
        obs: 'Diesel 2.8 (Duramax) 2012+. Flex 2.4/2.5 usa outros filtros.',
        itens: [
            oleoMotor('5W-30 (diesel)', '~7,4 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL726', { km: 10000, meses: 12, eq: eq(['Tecfil', 'PEL726'], ['Wega', 'WOE314'], ['Vox', 'LE726'], ['Fram', 'PH11724']) }),
            it('filtro_ar', 'Filtro de ar do motor — Wega WR295', { km: 20000, eq: eq(['Wega', 'WR295']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PEC3029', { km: 15000, eq: eq(['Tecfil', 'PEC3029'], ['Wega', 'FCD0777']) }),
            it('filtro_cabine', 'Filtro de cabine — Wega AKX1993', { km: 15000, meses: 12, eq: eq(['Wega', 'AKX1993']) }),
        ],
    },
    {
        marca: 'Ford', modelo: 'Ranger', categoria_veiculo: 'leve',
        obs: 'Diesel 2.2/3.2 (2012–2022). Confirmar motorização.',
        itens: [
            oleoMotor('5W-30 (diesel)', '~7,5 L', { km: 15000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Mann HU7002z', { km: 15000, meses: 12, eq: eq(['Mann', 'HU7002z'], ['Tecfil', 'PEL309'], ['Wega', 'WOE131'], ['Vox', 'LE309']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARS7994', { km: 20000, eq: eq(['Tecfil', 'ARS7994'], ['Wega', 'WR191']) }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCD0812', { km: 15000, eq: eq(['Wega', 'FCD0812'], ['Wega', 'FCD0785']), obs: 'FCD0785 nas versões 2012–2018' }),
            it('filtro_cabine', 'Filtro de cabine — Wega AKX35177', { km: 15000, meses: 12, eq: eq(['Wega', 'AKX35177']) }),
        ],
    },
    {
        marca: 'Renault', modelo: 'Master', categoria_veiculo: 'leve',
        obs: 'Furgão diesel 2.3 dCi. Versão 136cv (2022+) troca alguns códigos.',
        itens: [
            oleoMotor('5W-30 (diesel)', '~7,0 L', { km: 15000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL678', { km: 15000, meses: 12, eq: eq(['Tecfil', 'PEL678']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARL5140', { km: 20000, eq: eq(['Tecfil', 'ARL5140']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PC947', { km: 15000, eq: eq(['Tecfil', 'PC947'], ['Tecfil', 'PEC874']), obs: 'PEC874 na 2.3 136cv (2022+)' }),
            it('filtro_cabine', 'Filtro de cabine — Tecfil ACP837', { km: 15000, meses: 12, eq: eq(['Tecfil', 'ACP837']) }),
        ],
    },
    {
        marca: 'Renault', modelo: 'Duster', categoria_veiculo: 'leve',
        obs: 'Flex 1.6 16V (K4M) e 2.0 16V. Filtro de ar 1.6: Renault 8660089507.',
        itens: [
            oleoMotor('5W-30 API SN (flex)', '~4,3 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Wega WO200', { km: 10000, meses: 12, oem: '8200768927', eq: eq(['Renault', '8200768927'], ['Wega', 'WO200'], ['Tecfil', 'PSL56']) }),
            it('filtro_ar', 'Filtro de ar do motor — Renault 8660089507', { km: 20000, oem: '8660089507', eq: eq(['Renault', '8660089507'], ['Wega', 'FAP9273'], ['Motrio', '8660089507']), obs: 'Aplicação 1.6 16V K4M' }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCI1630', { km: 20000, eq: eq(['Wega', 'FCI1630']) }),
            it('filtro_cabine', 'Filtro de cabine — Wega AKX1397', { km: 15000, meses: 12, eq: eq(['Wega', 'AKX1397']) }),
        ],
    },
    {
        marca: 'Toyota', modelo: 'Hilux', categoria_veiculo: 'leve',
        obs: 'Diesel 2.8 (1GD) 2016+. Flex 2.7 usa outros filtros.',
        itens: [
            oleoMotor('5W-30 (diesel)', '~7,5 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL127', { km: 10000, meses: 12, eq: eq(['Tecfil', 'PSL127'], ['Mann', 'W712/83'], ['Wega', 'JFO0211'], ['Bosch', '0986B00066']), obs: 'PSL916 em gerações anteriores (2.5/2.7/3.0)' }),
            it('filtro_ar', 'Filtro de ar do motor', { km: 20000, obs: 'Confirmar código do ar 2.8 no catálogo' }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PC953', { km: 10000, oem: '23390-0L070', eq: eq(['Tecfil', 'PC953'], ['Mann', 'PU9023z'], ['Wega', 'JFC2073'], ['Mahle', 'KX570D'], ['Toyota', '23390-0L070']) }),
        ],
    },
    {
        marca: 'Fiat', modelo: 'Strada', categoria_veiculo: 'leve',
        obs: 'Flex 1.4 Fire 8V (também 1.3 Firefly nos novos — confirmar).',
        itens: [
            oleoMotor('5W-30 API SN (flex)', '~3,0 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL55', { km: 10000, meses: 12, oem: '55259645', eq: eq(['Tecfil', 'PSL55'], ['Wega', 'WO120'], ['Fiat', '55259645']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARL4152', { km: 20000, eq: eq(['Tecfil', 'ARL4152'], ['Wega', 'FAP2831']) }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCI1660', { km: 20000, eq: eq(['Wega', 'FCI1660'], ['Tecfil', 'GI04/7']) }),
            it('filtro_cabine', 'Filtro de cabine — Tecfil ACP906', { km: 15000, meses: 12, eq: eq(['Tecfil', 'ACP906']) }),
        ],
    },
    {
        marca: 'Volkswagen', modelo: 'Saveiro', categoria_veiculo: 'leve',
        obs: 'Flex 1.6 MSI 8V (Gol/Voyage/Saveiro).',
        itens: [
            oleoMotor('5W-40 API SN (flex)', '~4,2 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL560', { km: 10000, meses: 12, eq: eq(['Tecfil', 'PSL560'], ['Mann', 'W7125'], ['Mahle', 'OC250'], ['Wega', 'WO545'], ['Fram', 'PH5548']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARL6080', { km: 20000, eq: eq(['Tecfil', 'ARL6080'], ['Wega', 'FAP7007']) }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCI1630', { km: 20000, eq: eq(['Wega', 'FCI1630'], ['Mann', 'WK612/1']) }),
            it('filtro_cabine', 'Filtro de cabine — Wega AKX35163', { km: 15000, meses: 12, eq: eq(['Wega', 'AKX35163']) }),
        ],
    },
    {
        marca: 'Volkswagen', modelo: 'Gol', categoria_veiculo: 'leve',
        obs: 'Flex 1.6 MSI 8V (mesma família Gol/Voyage/Saveiro).',
        itens: [
            oleoMotor('5W-40 API SN (flex)', '~3,5 L', { km: 10000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL560', { km: 10000, meses: 12, eq: eq(['Tecfil', 'PSL560'], ['Mann', 'W7125'], ['Mahle', 'OC250'], ['Wega', 'WO340']) }),
            it('filtro_ar', 'Filtro de ar do motor — Tecfil ARL6080', { km: 20000, eq: eq(['Tecfil', 'ARL6080'], ['Wega', 'FAP7007']) }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCI1630', { km: 20000, eq: eq(['Wega', 'FCI1630']) }),
            it('filtro_cabine', 'Filtro de cabine — Wega AKX35163', { km: 15000, meses: 12, eq: eq(['Wega', 'AKX35163']) }),
        ],
    },

    // =========================================================================
    // CAMINHÕES (filtros variam por motor/versão — confirmar)
    // =========================================================================
    {
        marca: 'Volkswagen', modelo: 'Constellation', categoria_veiculo: 'caminhao',
        obs: 'Varia por motor (MAN D08 / Cummins). Ex.: 24.280 motor MAN.',
        itens: [
            oleoMotor('15W-40 API CI-4/E7', '~28 L', { km: 30000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo (lubrificante) — motor MAN D08', { km: 30000, obs: 'Confirmar por motor', eq: eq(['Fleetguard', 'LF17356']) }),
            it('filtro_combustivel', 'Filtro de combustível — Wega FCD0500', { km: 30000, oem: '2U2127177', eq: eq(['VW', '2U2127177'], ['Wega', 'FCD0500']) }),
            it('filtro_separador_agua', 'Filtro separador de água — VW 2R0127177J', { km: 30000, oem: '2R0127177J', eq: eq(['VW', '2R0127177J'], ['Fleetguard', 'FS20223'], ['Tecfil', 'PSD981']) }),
            it('filtro_ar', 'Elemento do filtro de ar', { km: 30000, obs: 'Confirmar código por versão' }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241', obs: 'Reposição por consumo (~5% do diesel)' }),
        ],
    },
    {
        marca: 'Volkswagen', modelo: 'Delivery', categoria_veiculo: 'caminhao',
        obs: 'Linha nova com motor Cummins ISF 3.8 (Express/9.170/11.180/13.180).',
        itens: [
            oleoMotor('15W-40 API CI-4', '~12 L', { km: 20000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL283', { km: 20000, eq: eq(['Tecfil', 'PSL283'], ['Mann', 'W950/26'], ['Fleetguard', 'LF16015'], ['Fram', 'PH9453'], ['Mahle', 'OC502']) }),
            it('filtro_ar', 'Filtro de ar do motor — Mann C37480', { km: 30000, oem: '23B129620', eq: eq(['Mann', 'C37480'], ['VW', '23B129620']) }),
            it('filtro_combustivel', 'Filtro de combustível (racor) — Tecfil PEC7177', { km: 20000, oem: '23B127177', eq: eq(['Tecfil', 'PEC7177'], ['Wega', 'FCD0962'], ['Fleetguard', 'FS20221'], ['VW', '23B127177']) }),
            it('filtro_combustivel', 'Filtro de combustível (fino) — Tecfil PSC706', { km: 20000, eq: eq(['Tecfil', 'PSC706']) }),
        ],
    },
    {
        marca: 'Volkswagen', modelo: 'Worker', categoria_veiculo: 'caminhao',
        obs: 'Motor MWM (6.12 / 4.12). Ex.: 15.180 / 17.230.',
        itens: [
            oleoMotor('15W-40 API CI-4', '~18 L', { km: 20000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Wega WO610 / WO782', { km: 20000, eq: eq(['Wega', 'WO610'], ['Wega', 'WO782']), obs: 'WO610 no 15.180; WO782 no 17.230' }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PSC353', { km: 20000, eq: eq(['Tecfil', 'PSC353'], ['Wega', 'FCD30123']) }),
            it('filtro_ar', 'Elemento do filtro de ar', { km: 30000, obs: 'Confirmar código por versão' }),
        ],
    },
    {
        marca: 'Mercedes', modelo: 'Atego', categoria_veiculo: 'caminhao',
        obs: 'Motor OM926 LA (ex.: 2426/2430). Kit Tecfil ARS9841/4.',
        itens: [
            oleoMotor('15W-40 API CI-4', '~24 L', { km: 30000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL2002', { km: 30000, eq: eq(['Tecfil', 'PEL2002'], ['Mann', 'HU945/2x'], ['Mahle', 'OX174D'], ['Wega', 'WOE450']) }),
            it('filtro_ar', 'Filtro de ar — Tecfil ARS9841', { km: 30000, eq: eq(['Tecfil', 'ARS9841']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PEC3022', { km: 30000, eq: eq(['Tecfil', 'PEC3022'], ['Wega', 'FCD0768']) }),
            it('filtro_hidraulico', 'Filtro da direção hidráulica — Tecfil PH346', { eq: eq(['Tecfil', 'PH346']) }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241' }),
        ],
    },
    {
        marca: 'Mercedes', modelo: 'Accelo', categoria_veiculo: 'caminhao',
        obs: 'Motor OM924 LA (815/1016/1316). Kit Tecfil ARS9838.',
        itens: [
            oleoMotor('15W-40 API CI-4', '~11 L', { km: 20000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL2003', { km: 20000, eq: eq(['Tecfil', 'PEL2003'], ['Mann', 'HU931/5x'], ['Mahle', 'OX161D'], ['Wega', 'WOE440']) }),
            it('filtro_ar', 'Filtro de ar — Tecfil ARS9838', { km: 30000, eq: eq(['Tecfil', 'ARS9838'], ['Mann', 'C20457-7']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PEC3022', { km: 20000, eq: eq(['Tecfil', 'PEC3022']) }),
            it('filtro_separador_agua', 'Filtro separador de água (racor)', { km: 20000, obs: 'Accelo 815 OM924 LA 2011+' }),
            it('filtro_hidraulico', 'Filtro da direção hidráulica — Tecfil PH346', { eq: eq(['Tecfil', 'PH346']) }),
        ],
    },
    {
        marca: 'Mercedes', modelo: 'Actros', categoria_veiculo: 'caminhao',
        obs: 'NÃO CONFIRMADO — motor OM471/OM473; confirmar códigos no catálogo MB.',
        itens: [
            oleoMotor('10W-40 (baixo SAPS)', '~34 L', { km: 45000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { km: 45000, obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { km: 45000, obs: 'Confirmar código' }),
            it('filtro_ar', 'Elemento do filtro de ar', { obs: 'Confirmar código' }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241' }),
        ],
    },
    {
        marca: 'Mercedes', modelo: 'Axor', categoria_veiculo: 'caminhao',
        obs: 'Motor OM457 LA (ex.: 2544).',
        itens: [
            oleoMotor('15W-40 API CI-4', '~30 L', { km: 40000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PEL2004', { km: 40000, eq: eq(['Tecfil', 'PEL2004'], ['Mann', 'HU12110x'], ['Mahle', 'OX348D'], ['Wega', 'WOE451']) }),
            it('filtro_ar', 'Filtro de ar — Tecfil ARS9840', { km: 40000, eq: eq(['Tecfil', 'ARS9840'], ['Mann', 'C271340']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PEC3021', { km: 40000, eq: eq(['Tecfil', 'PEC3021'], ['Wega', 'FCD0769']) }),
            it('filtro_separador_agua', 'Filtro separador de água (racor) — FIRA23', { eq: eq(['Parker', 'FIRA23']) }),
        ],
    },
    {
        marca: 'Ford', modelo: 'Cargo', categoria_veiculo: 'caminhao',
        obs: 'Motor Cummins (ISB/ISF). Ex.: 1719. Varia por versão.',
        itens: [
            oleoMotor('15W-40 API CI-4', '~16 L', { km: 30000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Tecfil PSL282', { km: 30000, eq: eq(['Tecfil', 'PSL282']), obs: 'Confirmar por motor Cummins' }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PSC743', { km: 30000, eq: eq(['Tecfil', 'PSC743'], ['Fleetguard', 'FF5612'], ['Mann', 'WK9542']) }),
            it('filtro_separador_agua', 'Filtro separador de água (racor) — Tecfil PSD950/1', { km: 30000, eq: eq(['Tecfil', 'PSD950/1']) }),
            it('filtro_ar', 'Filtro de ar — Fleetguard (Cargo 1319/1519/1719 Euro5)', { km: 30000, eq: eq(['Fleetguard', 'ARS5673']) }),
        ],
    },
    {
        marca: 'Iveco', modelo: 'Tector', categoria_veiculo: 'caminhao',
        obs: 'Motor NEF (Tector). Ex.: 240E28. Códigos OEM Iveco.',
        itens: [
            oleoMotor('15W-40 API CI-4', '~14 L', { km: 30000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Iveco 2992242', { km: 30000, oem: '2992242', eq: eq(['Iveco', '2992242'], ['Iveco', '503120785'], ['Tecfil', 'PSL283'], ['Mann', 'W950/26']) }),
            it('filtro_combustivel', 'Filtro de combustível — Iveco 503120786', { km: 30000, oem: '503120786', eq: eq(['Iveco', '503120786']) }),
            it('filtro_separador_agua', 'Pré-filtro/separador — Iveco 5801403243', { km: 30000, oem: '5801403243', eq: eq(['Iveco', '5801403243']) }),
            it('filtro_ar', 'Filtro de ar — Iveco 5802773390', { km: 30000, oem: '5802773390', eq: eq(['Iveco', '5802773390'], ['Iveco', '5802926259']) }),
        ],
    },
    {
        marca: 'Iveco', modelo: 'Daily', categoria_veiculo: 'caminhao',
        obs: 'Motor FPT F1C 3.0 (ex.: 35S14).',
        itens: [
            oleoMotor('5W-30 / 15W-40 (conforme motor)', '~14 L', { km: 25000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo — Mann W940/69', { km: 25000, eq: eq(['Mann', 'W940/69'], ['Tecfil', 'PSL655']) }),
            it('filtro_ar', 'Filtro de ar — Tecfil ARS8234', { km: 30000, eq: eq(['Tecfil', 'ARS8234'], ['Tecfil', 'ARS8236']) }),
            it('filtro_combustivel', 'Filtro de combustível — Mann WK854/2', { km: 25000, eq: eq(['Mann', 'WK854/2'], ['Tecfil', 'PSC455'], ['Wega', 'FCD3029']) }),
        ],
    },
    {
        marca: 'Volvo', modelo: 'VM', categoria_veiculo: 'caminhao',
        obs: 'Motor MWM (VM 220/270/330).',
        itens: [
            oleoMotor('15W-40 API CI-4', '~22 L', { km: 30000, meses: 6 }),
            it('filtro_oleo', 'Filtro de óleo — Volvo 478736', { km: 30000, oem: '478736', eq: eq(['Volvo', '478736'], ['Mann', 'WP11102']) }),
            it('filtro_separador_agua', 'Filtro separador de água — Mann WK1060/1', { km: 30000, oem: '21438854', eq: eq(['Volvo', '21438854'], ['Mann', 'WK1060/1'], ['Racor', 'R90-30M'], ['Wega', 'FCD0818'], ['Mahle', 'KC636']) }),
            it('filtro_combustivel', 'Filtro de combustível — Tecfil PSC89', { km: 30000, eq: eq(['Tecfil', 'PSC89'], ['Wega', 'FCD2054']) }),
            it('filtro_ar', 'Elemento do filtro de ar', { km: 30000, obs: 'Confirmar código' }),
        ],
    },
    {
        marca: 'Volvo', modelo: 'FH', categoria_veiculo: 'caminhao',
        obs: 'Motor D13. Cavalo pesado.',
        itens: [
            oleoMotor('15W-40 / 10W-40 (VDS)', '~38 L', { km: 60000, meses: 12 }),
            it('filtro_ar', 'Filtro de ar — Mann C331460/1', { oem: '21115483', eq: eq(['Mann', 'C331460/1'], ['Volvo', '21115483'], ['Fleetguard', 'AF27834'], ['Donaldson', 'P951102']) }),
            it('filtro_combustivel', 'Filtro de combustível + separador — Fleetguard (D13)', { km: 60000, eq: eq(['Fleetguard', 'FS20223']), obs: 'Racor FIRA12C nos 2006–2014' }),
            it('filtro_oleo', 'Filtros de óleo (full + by-pass)', { km: 60000, obs: 'Confirmar códigos por ano' }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241' }),
        ],
    },
    {
        marca: 'Scania', modelo: 'Série P/R', categoria_veiculo: 'caminhao',
        obs: 'Motor DC13 (série 5/6).',
        itens: [
            oleoMotor('15W-40 / 10W-40 (LDF)', '~36 L', { km: 60000, meses: 12 }),
            it('filtro_ar', 'Filtro de ar — Fleetguard AF27940', { oem: '1869993', eq: eq(['Fleetguard', 'AF27940'], ['Scania', '1869993'], ['Mann', 'C31014/1']) }),
            it('filtro_combustivel', 'Filtro de combustível — Mann PU10034-2x', { km: 60000, oem: '2779190', eq: eq(['Mann', 'PU10034-2x'], ['Fleetguard', 'FK11007'], ['Scania', '2779190']) }),
            it('filtro_oleo', 'Filtro de óleo (elemento) — Scania 2625884', { km: 60000, oem: '2625884', eq: eq(['Scania', '2625884']) }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241' }),
        ],
    },
    {
        marca: 'DAF', modelo: 'XF', categoria_veiculo: 'caminhao',
        obs: 'NÃO CONFIRMADO — motor PACCAR MX; confirmar códigos no catálogo DAF.',
        itens: [
            oleoMotor('10W-40 (baixo SAPS)', '~36 L', { km: 60000, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { obs: 'Confirmar código' }),
            it('filtro_ar', 'Elemento do filtro de ar', { obs: 'Confirmar código' }),
            it('arla32', 'ARLA 32 (AdBlue)', { espec: 'ISO 22241' }),
        ],
    },

    // =========================================================================
    // MÁQUINAS PESADAS (intervalos em horas)
    // =========================================================================
    {
        marca: 'XCMG', modelo: 'LW300', variante: 'Pá carregadeira', categoria_veiculo: 'maquina',
        obs: 'LW300KV (motor Weichai/Deutz). Códigos OEM XCMG.',
        itens: [
            oleoMotor('15W-40 CI-4', '~14 L', { h: 250, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — Fleetguard FF185', { h: 500, oem: '860141000', eq: eq(['XCMG', '860141000'], ['XCMG', '860149482'], ['Fleetguard', 'FF185'], ['Mann', 'WK950/13']) }),
            it('filtro_separador_agua', 'Filtro separador de combustível — XCMG 860139777', { h: 500, oem: '860139777', eq: eq(['XCMG', '860139777']) }),
            it('filtro_ar', 'Filtro de ar (primário) — XCMG 860118455', { h: 1000, oem: '860118455', eq: eq(['XCMG', '860118455']) }),
            it('filtro_cabine', 'Filtro de cabine — XCMG (SK1151)', { h: 1000, eq: eq(['XCMG', 'SK1151']) }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 HVI', cap: '~120 L', h: 2000 }),
            it('filtro_hidraulico', 'Filtro hidráulico', { h: 1000, obs: 'Confirmar código XCMG' }),
        ],
    },
    {
        marca: 'XCMG', modelo: 'LW500', variante: 'Pá carregadeira', categoria_veiculo: 'maquina',
        obs: 'LW500FN/BR (motor Weichai). Códigos OEM XCMG.',
        itens: [
            oleoMotor('15W-40 CI-4', '~20 L', { h: 250, meses: 12 }),
            it('filtro_ar', 'Filtro de ar (interno+externo) — XCMG 860121499', { h: 1000, oem: '860121499', eq: eq(['XCMG', '860121499']) }),
            it('filtro_combustivel', 'Filtro tanque de combustível — XCMG 803164228', { h: 500, oem: '803164228', eq: eq(['XCMG', '803164228'], ['Mann', 'WK-63X100-J'], ['Sakura', 'SH77620A']) }),
            it('filtro_cabine', 'Filtro de cabine (ar-cond.) — XCMG 803589892', { h: 1000, oem: '803589892', eq: eq(['XCMG', '803589892']) }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 HVI', cap: '~180 L', h: 2000 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código Weichai' }),
            it('filtro_hidraulico', 'Filtro hidráulico', { h: 1000, obs: 'Confirmar código XCMG' }),
        ],
    },
    {
        marca: 'XCMG', modelo: 'XE215', variante: 'Escavadeira', categoria_veiculo: 'maquina',
        obs: 'NÃO CONFIRMADO — confirmar códigos por motor (Cummins/Isuzu) no catálogo XCMG.',
        itens: [
            oleoMotor('15W-40 CI-4', '~22 L', { h: 500, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { h: 500, obs: 'Confirmar código' }),
            it('filtro_ar', 'Filtro de ar (primário + segurança)', { h: 1000, obs: 'Confirmar código' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 HVI', cap: '~220 L', h: 2000 }),
            it('filtro_hidraulico', 'Filtro hidráulico', { h: 1000, obs: 'Confirmar código' }),
        ],
    },
    {
        marca: 'XCMG', modelo: 'GR215', variante: 'Motoniveladora', categoria_veiculo: 'maquina',
        obs: 'NÃO CONFIRMADO — confirmar códigos no catálogo XCMG.',
        itens: [
            oleoMotor('15W-40 CI-4', '~18 L', { h: 500, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { h: 500, obs: 'Confirmar código' }),
            it('filtro_ar', 'Filtro de ar (primário + segurança)', { h: 1000, obs: 'Confirmar código' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 HVI', cap: '~90 L', h: 2000 }),
        ],
    },
    {
        marca: 'Caterpillar', modelo: '416', variante: 'Retroescavadeira', categoria_veiculo: 'maquina',
        obs: '416E/420E. Códigos OEM CAT.',
        itens: [
            oleoMotor('15W-40 CI-4 (CAT DEO)', '~13 L', { h: 500, meses: 12 }),
            it('filtro_ar', 'Filtro de ar (externo+interno) — CAT 2277448 / 2277449', { h: 1000, oem: '2277448', eq: eq(['Caterpillar', '2277448'], ['Caterpillar', '2277449']) }),
            it('filtro_hidraulico', 'Filtro hidráulico — CAT 3621163', { h: 1000, oem: '3621163', eq: eq(['Caterpillar', '3621163']) }),
            it('filtro_cabine', 'Filtro de cabine — CAT 211-2660', { h: 1000, oem: '211-2660', eq: eq(['Caterpillar', '211-2660']) }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código CAT' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { h: 500, obs: 'Confirmar código CAT' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 (CAT HYDO)', cap: '~95 L', h: 2000 }),
        ],
    },
    {
        marca: 'Caterpillar', modelo: '420', variante: 'Retroescavadeira', categoria_veiculo: 'maquina',
        obs: '416E/420E compartilham vários filtros. Códigos OEM CAT.',
        itens: [
            oleoMotor('15W-40 CI-4 (CAT DEO)', '~13 L', { h: 500, meses: 12 }),
            it('filtro_ar', 'Filtro de ar (externo+interno) — CAT 2277448 / 2277449', { h: 1000, oem: '2277448', eq: eq(['Caterpillar', '2277448'], ['Caterpillar', '2277449']) }),
            it('filtro_hidraulico', 'Filtro hidráulico — CAT 3621163', { h: 1000, oem: '3621163', eq: eq(['Caterpillar', '3621163']) }),
            it('filtro_cabine', 'Filtro de cabine — CAT 211-2660', { h: 1000, oem: '211-2660', eq: eq(['Caterpillar', '211-2660']) }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 (CAT HYDO)', cap: '~100 L', h: 2000 }),
        ],
    },
    {
        marca: 'Caterpillar', modelo: '320', variante: 'Escavadeira', categoria_veiculo: 'maquina',
        obs: '320D (motor CAT C6.4/3066). Códigos OEM CAT.',
        itens: [
            oleoMotor('15W-40 CI-4 (CAT DEO)', '~24 L', { h: 500, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — CAT 1R-0739', { h: 500, oem: '1R-0739', eq: eq(['Caterpillar', '1R-0739']) }),
            it('filtro_oleo', 'Filtro de óleo do motor — CAT 1R-1807', { h: 500, oem: '1R-1807', eq: eq(['Caterpillar', '1R-1807'], ['Caterpillar', '1R-0714']) }),
            it('filtro_ar', 'Filtro de ar (primário + segurança)', { h: 1000, obs: 'CAT 6I-2503 / 6I-2504 — confirmar' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 (CAT HYDO)', cap: '~240 L', h: 2000 }),
            it('filtro_hidraulico', 'Filtro hidráulico (retorno)', { h: 1000, obs: 'Confirmar código CAT' }),
        ],
    },
    {
        marca: 'Komatsu', modelo: 'PC200', variante: 'Escavadeira', categoria_veiculo: 'maquina',
        obs: 'PC200-8 (motor SAA6D107 / Cummins QSB6.7). Códigos OEM Komatsu.',
        itens: [
            oleoMotor('15W-40 CI-4', '~24 L', { h: 500, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — Komatsu 6754-79-6140', { h: 500, oem: '6754-79-6140', eq: eq(['Komatsu', '6754-79-6140'], ['Komatsu', '6754-79-6130']) }),
            it('filtro_combustivel', 'Pré-filtro de combustível — Komatsu 600-311-3750', { h: 500, oem: '600-311-3750', eq: eq(['Komatsu', '600-311-3750']) }),
            it('filtro_oleo', 'Filtro de óleo do motor — Komatsu 600-319-3610', { h: 500, oem: '600-319-3610', eq: eq(['Komatsu', '600-319-3610']) }),
            it('filtro_ar', 'Filtro de ar (externo) — Komatsu 600-185-4100', { h: 1000, oem: '600-185-4100', eq: eq(['Komatsu', '600-185-4100'], ['Komatsu', '600-185-1010']) }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 46/68', cap: '~230 L', h: 2000 }),
            it('filtro_hidraulico', 'Filtro hidráulico', { h: 1000, obs: 'Confirmar código Komatsu' }),
        ],
    },
    {
        marca: 'Sany', modelo: 'SY215', variante: 'Escavadeira', categoria_veiculo: 'maquina',
        obs: 'SY215C/SY215C-9 (motor Cummins/Isuzu). Códigos OEM Sany.',
        itens: [
            oleoMotor('15W-40 CI-4', '~22 L', { h: 500, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — Sany 60310823', { h: 500, oem: '60310823', eq: eq(['Sany', '60310823'], ['Sany', '60282026']) }),
            it('filtro_hidraulico', 'Filtro de óleo hidráulico — Sany 60167841', { h: 1000, oem: '60167841', eq: eq(['Sany', '60167841']) }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código por motor' }),
            it('filtro_ar', 'Filtro de ar (primário + segurança)', { h: 1000, eq: eq(['Fleetguard', 'AF25557']), obs: 'Confirmar aplicação SY215C' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 46/68', cap: '~220 L', h: 2000 }),
        ],
    },
    {
        marca: 'Case', modelo: '580', variante: 'Retroescavadeira', categoria_veiculo: 'maquina',
        obs: '580N/580SN (motor FPT F5C). Códigos OEM Case.',
        itens: [
            oleoMotor('15W-40 CI-4', '~13 L', { h: 500, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — Case 87803444', { h: 500, oem: '87803444', eq: eq(['Case', '87803444'], ['Donaldson', 'P550760'], ['JCB', '32/925915']) }),
            it('filtro_hidraulico', 'Filtro hidráulico — Donaldson P576047', { h: 1000, oem: 'P576047', eq: eq(['Donaldson', 'P576047']) }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código FPT' }),
            it('filtro_ar', 'Filtro de ar (primário + secundário)', { h: 1000, eq: eq(['Fleetguard', 'AF25557']), obs: 'Confirmar aplicação 580N' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68', cap: '~95 L', h: 2000 }),
        ],
    },
    {
        marca: 'JCB', modelo: '3CX', variante: 'Retroescavadeira', categoria_veiculo: 'maquina',
        obs: 'Motor JCB Dieselmax. Códigos OEM JCB.',
        itens: [
            oleoMotor('15W-40 CI-4', '~14 L', { h: 500, meses: 12 }),
            it('filtro_combustivel', 'Filtro de combustível — JCB 32/925994', { h: 500, oem: '32/925994', eq: eq(['JCB', '32/925994'], ['JCB', '320/07155'], ['JCB', '320/07394'], ['Donaldson', 'P550588']) }),
            it('filtro_combustivel', 'Filtro de combustível (kit) — JCB 32/925694', { h: 500, oem: '32/925694', eq: eq(['JCB', '32/925694']) }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código JCB' }),
            it('filtro_ar', 'Filtro de ar (primário + secundário)', { h: 1000, obs: 'Confirmar código JCB' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68', cap: '~100 L', h: 2000 }),
        ],
    },
    {
        marca: 'Liugong', modelo: '856', variante: 'Pá carregadeira', categoria_veiculo: 'maquina',
        obs: 'NÃO CONFIRMADO — motor Weichai/Cummins; confirmar códigos no catálogo Liugong.',
        itens: [
            oleoMotor('15W-40 CI-4', '~18 L', { h: 250, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { h: 500, obs: 'Confirmar código' }),
            it('filtro_ar', 'Filtro de ar (primário + segurança)', { h: 1000, obs: 'Confirmar código' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68 HVI', cap: '~160 L', h: 2000 }),
        ],
    },
    {
        marca: 'New Holland', modelo: 'B95', variante: 'Retroescavadeira', categoria_veiculo: 'maquina',
        obs: 'NÃO CONFIRMADO — motor FPT; muitos filtros iguais ao Case 580 (mesma base). Confirmar.',
        itens: [
            oleoMotor('15W-40 CI-4', '~12 L', { h: 500, meses: 12 }),
            it('filtro_oleo', 'Filtro de óleo do motor', { h: 500, obs: 'Confirmar código' }),
            it('filtro_combustivel', 'Filtro de combustível + separador', { h: 500, obs: 'Provável comum ao Case 580N — confirmar' }),
            it('filtro_ar', 'Filtro de ar (primário + secundário)', { h: 1000, obs: 'Confirmar código' }),
            it('oleo_hidraulico', 'Óleo hidráulico', { espec: 'ISO VG 68', cap: '~90 L', h: 2000 }),
        ],
    },
];

// ─────────────────────────────────────────────────────────────────────────────
async function seedPartCatalog(db) {
    let nModels = 0;
    let nItems = 0;

    for (const m of MODELOS) {
        const modelId = crypto.randomUUID();
        await db.query(
            `INSERT INTO part_catalog_models
                (id, marca, marca_norm, modelo, modelo_norm, variante, categoria_veiculo,
                 ano_inicio, ano_fim, observacoes, fonte)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                modelId, m.marca, normalizeMarca(m.marca), m.modelo, normalizeText(m.modelo),
                m.variante ?? null, m.categoria_veiculo ?? null,
                m.ano_inicio ?? null, m.ano_fim ?? null, m.obs ?? null, FONTE,
            ]
        );
        nModels++;

        for (const item of (m.itens || [])) {
            await db.query(
                `INSERT INTO part_catalog_items
                    (id, model_id, categoria, descricao, especificacao, capacidade, quantidade,
                     codigo_oem, codigos_equivalentes, intervalo_km, intervalo_horas, intervalo_meses,
                     status_validacao, fonte, observacoes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'referencia', ?, ?)`,
                [
                    crypto.randomUUID(), modelId, item.categoria, item.descricao,
                    item.especificacao, item.capacidade, item.quantidade,
                    item.codigo_oem, JSON.stringify(item.codigos_equivalentes || []),
                    item.intervalo_km, item.intervalo_horas, item.intervalo_meses,
                    item.fonte ?? FONTE, item.observacoes,
                ]
            );
            nItems++;
        }
    }

    return { models: nModels, items: nItems };
}

module.exports = { seedPartCatalog, MODELOS };
