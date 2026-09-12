# Implantação — Guia de Peças e Reposição

> Documento de implantação. Objetivo: adicionar ao Frotas MAK um módulo de **Guia de Peças e
> Reposição** por equipamento (marca, modelo, ano, chassi), com filtros, óleos, correias e demais
> itens, contendo **código OEM**, **equivalentes aftermarket**, intervalos de troca, fonte e status
> de validação. Começar a execução amanhã, na ordem das fases abaixo.

---

## 0. Contexto e decisões (leia antes de começar)

- Frota atual: **~416 equipamentos**. Marcas dominantes: XCMG (118), VW (72), Mercedes (22),
  Ford (20), Renault (19), Chevrolet (18), CAT/Caterpillar (27), Randon (13), Sany (10), Iveco (8),
  Volvo (6), Komatsu/Scania/Case/JCB/Liugong/Fiat/Toyota (demais).
- **Decisão de dados:** código OEM exato por VIN/chassi para os 416 equipamentos **não** é obtível de
  forma confiável por scraping (fica em catálogos proprietários — TecDoc/EPC). O dataset entra como
  **referência validável** (`status_validacao = 'referencia'`): specs de manutenção publicadas +
  equivalentes aftermarket. A oficina confirma/ajusta pelos manuais oficiais. Estrutura já preparada
  para importação CSV e integração paga (TecDoc) no futuro, sem retrabalho.
- **Localização:** módulo próprio ligado ao veículo (página em **Oficina** + aba na ficha do veículo).
- **Padrões a seguir:** `backend/CLAUDE.md` (migração inline idempotente, rotas→controller→db,
  `req.io.emit('server:sync', ...)`) e `frontend/CLAUDE.md` (roteamento por `currentPage`, apiClient,
  Sidebar, permissions, Tailwind — sem TypeScript, sem React Router).

---

## Fase 1 — Backend: banco de dados

### 1.1 Migração inline em `backend/server.js`
Adicionar IIFE `CREATE TABLE IF NOT EXISTS` (padrão de server.js:390), idempotente.

```sql
CREATE TABLE IF NOT EXISTS part_catalog_models (
  id            VARCHAR(36) PRIMARY KEY,
  marca         VARCHAR(80)  NOT NULL,
  marca_norm    VARCHAR(80)  NOT NULL,
  modelo        VARCHAR(120) NOT NULL,
  modelo_norm   VARCHAR(120) NOT NULL,
  variante      VARCHAR(120) NULL,
  categoria_veiculo VARCHAR(40) NULL,      -- caminhao | maquina | leve
  ano_inicio    INT NULL,
  ano_fim       INT NULL,
  observacoes   TEXT NULL,
  anexo_url     VARCHAR(500) NULL,         -- PDF do catálogo da montadora
  fonte         VARCHAR(300) NULL,
  createdAt     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pcm_busca (marca_norm, modelo_norm, ano_inicio, ano_fim)
);

CREATE TABLE IF NOT EXISTS part_catalog_items (
  id            VARCHAR(36) PRIMARY KEY,
  model_id      VARCHAR(36) NULL,          -- FK part_catalog_models ON DELETE CASCADE
  vehicle_id    VARCHAR(36) NULL,          -- override por chassi específico
  categoria     VARCHAR(50) NOT NULL,
  descricao     VARCHAR(200) NOT NULL,
  especificacao VARCHAR(200) NULL,
  capacidade    VARCHAR(60)  NULL,
  quantidade    VARCHAR(30)  NULL,
  codigo_oem    VARCHAR(80)  NULL,
  codigos_equivalentes JSON NULL,          -- [{ "marca":"Mann","codigo":"W950" }, ...]
  intervalo_km      INT NULL,
  intervalo_horas   INT NULL,
  intervalo_meses   INT NULL,
  status_validacao  ENUM('referencia','confirmado','revisar') NOT NULL DEFAULT 'referencia',
  fonte         VARCHAR(300) NULL,
  observacoes   TEXT NULL,
  createdAt     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pci_model (model_id),
  KEY idx_pci_vehicle (vehicle_id),
  KEY idx_pci_cat (categoria)
);
```

**Categorias previstas** (`categoria`): `filtro_oleo`, `filtro_ar`, `filtro_combustivel`,
`filtro_separador_agua`, `filtro_cabine`, `filtro_hidraulico`, `filtro_transmissao`, `oleo_motor`,
`oleo_hidraulico`, `oleo_transmissao`, `oleo_diferencial`, `fluido_arrefecimento`, `arla32`,
`correia`, `pastilha_freio`, `bateria`, `pneu`, `outro`.

- [ ] Tabelas criadas com sucesso no boot.
- [ ] Seed roda só quando `part_catalog_models` está vazio (não sobrescreve edições).

### 1.2 Util `backend/utils/partCatalog.js`
- [ ] `normalizeText(s)` — lowercase, sem acento, trim, colapsa espaços.
- [ ] `normalizeMarca(s)` — mapa de typos→canônico: `volkswagem→volkswagen`, `xcg→xcmg`,
      `liu gong→liugong`, `mitsubichi→mitsubishi`, `mercedes-benz→mercedes`, `fiat-allis→fiatallis`,
      `cat→caterpillar`.
- [ ] `resolveVehicleAno(vehicle)` — usa `anoFabricacao || ano_fabricacao || ano_modelo`.
- [ ] `anoMatch(ano, ini, fim)` — faixa aberta quando null.

---

## Fase 2 — Backend: API

### 2.1 `backend/controllers/partCatalogController.js`
CRUD + resolução (padrão `db.query`, emitir `req.io.emit('server:sync', { targets:['partCatalog'] })`
nas mutações):
- [ ] `getModels` — filtros `?marca=&modelo=&ano=&q=` (LIKE em `*_norm`).
- [ ] `getModelById` — modelo + itens.
- [ ] `createModel` / `updateModel` / `deleteModel` (gravar `marca_norm`/`modelo_norm`).
- [ ] `createItem` / `updateItem` / `deleteItem`.
- [ ] `getForVehicle` — `:vehicleId` → `{ vehicle, modelMatches:[{model,items}], overrides:[...] }`.

### 2.2 `backend/routes/partCatalogRoutes.js` + registro
- [ ] Endpoints: `GET /models`, `GET /models/:id`, `POST /models`, `PUT /models/:id`,
      `DELETE /models/:id`, `POST /items`, `PUT /items/:id`, `DELETE /items/:id`,
      `GET /for-vehicle/:vehicleId`.
- [ ] `require` em server.js (~1973) + `apiRouter.use('/part-catalog', partCatalogRoutes)` (~2144,
      abaixo do `authMiddleware`).

---

## Fase 3 — Backend: dataset de referência

### 3.1 `backend/data/partCatalogSeed.js`
Array de modelos + itens (`status_validacao:'referencia'`, `fonte` preenchida). Escopo mínimo:
- [ ] **Caminhões:** VW Constellation / Delivery / Worker, MB Atego / Accelo / Actros / Axor,
      Ford Cargo, Iveco Tector / Daily, Volvo VM / FH, Scania P/R, DAF.
- [ ] **Máquinas pesadas:** XCMG (pá LW300/LW500, escavadeira XE, motoniveladora), CAT (416/420 retro,
      320 escavadeira), Komatsu, Sany, Case, JCB, Liugong, New Holland.
- [ ] **Leves:** Fiat Strada / Toro, VW Saveiro / Gol, Ford Ranger, Chevrolet S10, Renault Master /
      Duster, Toyota Hilux.
- [ ] Cada item: categoria, descrição, especificação/capacidade, intervalo (km/h/meses),
      `codigos_equivalentes` aftermarket. OEM só quando amplamente publicado.

---

## Fase 4 — Frontend: serviço e página

### 4.1 `frontend/src/services/apiClient.js`
- [ ] Bloco `partCatalog`: `getModels(params)`, `getModel(id)`, `createModel`, `updateModel`,
      `deleteModel`, `createItem`, `updateItem`, `deleteItem`, `getPartsForVehicle(vehicleId)`.

### 4.2 `frontend/src/pages/GuiaPecasPage.js` (novo)
- [ ] Busca por marca/modelo/ano/texto.
- [ ] Lista de modelos → painel com itens agrupados (filtros / óleos / outros), spec, OEM,
      equivalentes (chips), intervalos e **badge de status** (referência=amarelo, confirmado=verde,
      revisar=vermelho — paleta do `frontend/CLAUDE.md`).
- [ ] CRUD de modelo e item em modais; editor de `codigos_equivalentes` (marca+código).
- [ ] Refetch após mutação + escutar `socket` `server:sync` target `partCatalog`.
- [ ] Aceitar `initialFilter = { vehicleId }` para abrir já filtrado.

### 4.3 Modais (novos, em `frontend/src/components/modals/`)
- [ ] `PartCatalogModelModal.js` e `PartCatalogItemModal.js`.

---

## Fase 5 — Frontend: integração e navegação

### 5.1 Ficha do veículo
- [ ] `frontend/src/utils/permissions.js` → `VEHICLE_ACTION_BUTTONS`: adicionar `'pecas'`
      (admin, gerencia, oficina, editor).
- [ ] `frontend/src/components/VehicleDetailModal.js` → aba **"Peças & Reposição"** usando
      `getPartsForVehicle(vehicle.id)`; link "abrir guia completo" navega com `initialFilter`.

### 5.2 Roteamento / menu / permissões
- [ ] `frontend/src/App.js`: `lazy import` de `GuiaPecasPage`, `case 'guia_pecas'` em `renderPage()`,
      entrada em `PAGE_RESOURCE_REQUIREMENTS` (precisa de `vehicles`).
- [ ] `frontend/src/components/Sidebar.js`: item `{ id:'guia_pecas', label:'Guia de Peças' }` no
      grupo **Oficina** (Sidebar.js:87-93).
- [ ] `frontend/src/utils/permissions.js`: incluir `'guia_pecas'` em `ROLE_PAGE_ACCESS` (gerencia,
      oficina, editor, supervisor, abastecimento) e em `PAGE_SECTIONS` (seção Oficina).

---

## Fase 6 — Verificação (end-to-end)

- [ ] **Backend:** `cd backend && npm start` → log confirma criação das tabelas + seed.
- [ ] `GET /api/part-catalog/models?marca=xcmg` retorna modelos.
- [ ] `GET /api/part-catalog/for-vehicle/<id real VW/XCMG>` retorna matches por modelo/ano.
- [ ] `POST/PUT/DELETE /items` (com token) refletem e emitem `server:sync`.
- [ ] **Frontend:** `cd frontend && npm start` → **Oficina → Guia de Peças**: buscar "XCMG", abrir
      modelo, ver filtros/óleos com badge "referência"; criar/editar item + equivalente; mudar status
      para "confirmado".
- [ ] **Ficha do veículo:** abrir um veículo → **Peças & Reposição** lista peças resolvidas por
      modelo/ano; "abrir guia completo" leva à página filtrada.
- [ ] **Permissão:** role `oficina` vê o menu; role sem a chave não vê.
- [ ] **Idempotência:** reiniciar o backend não duplica o seed (COUNT inalterado).

---

## Arquivos tocados

**Novos:** `backend/routes/partCatalogRoutes.js`, `backend/controllers/partCatalogController.js`,
`backend/utils/partCatalog.js`, `backend/data/partCatalogSeed.js`,
`frontend/src/pages/GuiaPecasPage.js`, `frontend/src/components/modals/PartCatalogModelModal.js`,
`frontend/src/components/modals/PartCatalogItemModal.js`.

**Alterados:** `backend/server.js`, `frontend/src/services/apiClient.js`, `frontend/src/App.js`,
`frontend/src/components/Sidebar.js`, `frontend/src/utils/permissions.js`,
`frontend/src/components/VehicleDetailModal.js`.

## Fora de escopo (próximas iterações)

- Números OEM garantidos por VIN/chassi para os 416 equipamentos (exige TecDoc/EPC pago) — estrutura
  já pronta para receber via importação CSV ou integração futura.
- Importação CSV em massa e baixa automática de estoque a partir da troca registrada.
