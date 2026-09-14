# Subgrupo em vários grupos (vínculo N:N)

## O problema

`vehicle_sub_types.type_id` dava a cada subgrupo um único grupo dono. Mas o mesmo
equipamento serve grupos diferentes: "Caminhão Caçamba Basculante 12m³" é item de
Caçamba Truckado **e** de Caçamba Traçado. A única saída era duplicar o nome sob
cada grupo — e como todo vínculo downstream é feito por **string** (`vehicles.sub_tipo`,
chaves do plano de obra, `planoItemKey`), nomes duplicados fazem contrato e frota
pararem de se conversar.

Levantamento na base de produção em 11/09/2026, antes da mudança:

| | |
|---|---|
| Subgrupos cadastrados | 18, todos com nome distinto (0 duplicatas) |
| Grupos com subgrupo | 4 de 26 |
| `Caçamba Truckado` | 108 veículos, **0** com subgrupo |
| `Caçamba Traçado` | 41 veículos, **0** com subgrupo |
| Itens de plano de obras ativas com execução zero | 75 de 220 (34%) |
| Horas em chave fora do plano da própria obra | 17.108 de 64.893 (26%) |

A colisão de nomes ainda não tinha acontecido porque quase ninguém preenchia
subgrupo. Ela aconteceria no exato momento em que alguém fosse corrigir o cadastro
das 149 caçambas — daí a mudança vir **antes** da campanha de cadastro.

## O modelo

```
vehicle_groups      Categoria  — define a unidade de consumo (L/h, Km/L)
      │ 1:N
vehicle_types       Grupo
      │ N:N  ← vehicle_type_sub_types
vehicle_sub_types   Subgrupo
```

Os níveis 1→2 continuam hierárquicos. Só 2↔3 é N:N.

### A regra da Categoria

Um subgrupo só pode ser vinculado a grupos da **mesma categoria**. A razão é
técnica, não organizacional: a categoria define a unidade de consumo e o tipo de
leitura (`L/h` → horímetro, `Km/L` → odômetro). Um subgrupo em duas categorias
ficaria ambíguo sobre qual aplicar.

É **validação de aplicação**, não constraint de schema — `validarCategoriaUnica`
em `controllers/vehicleTaxonomyController.js`. Afrouxar não pode exigir migração.

Na tela, a regra aparece como filtro e não como erro: ao marcar o primeiro grupo,
as demais categorias são desabilitadas. A combinação inválida não chega a ser
oferecida.

## O que mudou

### Banco (`server.js`, migração inline)

- `vehicle_type_sub_types (type_id, sub_type_id)` — nova, com backfill idempotente.
- `vehicle_sub_types.nome` passa a ser único **global** (era único por tipo). Só
  aplica se não houver nome repetido; com repetido, registra aviso e segue.
- `vehicle_sub_types.type_id` vira nula e sem uso. **Não foi removida** — é a rede
  de reversão. Remover só numa limpeza posterior.

### Backend

| Arquivo | Mudança |
|---|---|
| `controllers/vehicleTaxonomyController.js` | `getTree` monta pelos vínculos e inclui contagem de veículos; novo `GET /sub-types`; `createSubType`/`updateSubType` aceitam `type_ids[]`; `updateType` bloqueia trocar de categoria com subgrupo compartilhado; `deleteSubType` recusa subgrupo em uso |
| `utils/planoItem.js` | `carregarTaxonomia` devolve `Map<sub, Set<grupo>>`; `resolverItemDaAlocacao` usa `.has()` |
| `controllers/planejamentoController.js` | mesma taxonomia N:N; `chave()` recebe o grupo do veículo como hint |
| `controllers/vehicleController.js` | `bulkSetSubTipo` — `PATCH /api/vehicles/bulk-sub-tipo` |

**O contrato da API não mudou.** A árvore de `GET /vehicle-taxonomy` mantém o
formato `grupos → tipos → subTipos`; com N:N o mesmo subgrupo apenas passa a
aparecer em mais de um tipo. `hydrateVehicleTaxonomy` no frontend continua
funcionando sem alteração, e os cinco componentes que leem `vehicleSubTypes`
(VehicleModal, ObraModal, AditivoModal, ContratoTerceiroModal,
VehicleTypeConfigModal) passam a oferecer a lista certa sem uma linha tocada.

### `chave()` do Panorama de Capacidade

Colapsa subgrupo em grupo enquanto o cadastro da frota daquele grupo está
incompleto — sem isso o gap apareceria dobrado. Com N:N, "o grupo" do subgrupo
deixa de ser único:

- **Chave vinda de veículo** — usa o grupo do próprio veículo (`grupoHint`). Só o
  veículo sabe em qual dos grupos ele está.
- **Chave vinda do plano** — sem hint. Colapsa apenas se **todos** os grupos
  daquele subgrupo estiverem incompletos, e o balde é o grupo com mais máquinas.

### Frontend

- `components/admin/VehicleTaxonomyTab.js` — reescrita. Três colunas independentes
  (Categoria · Grupo · Subgrupo), seleção filtra a coluna seguinte em vez de
  aninhar, contagem de veículos em cada linha, multi-select de grupos no
  formulário de subgrupo.
- `components/modals/BulkSubTipoModal.js` — novo. Cadastro de subgrupo em lote,
  aberto pelo botão "Subgrupo em lote" na listagem de veículos (admin/editor).

## Vocabulário

O banco fala `group`/`type`/`sub_type`; o negócio fala Categoria/Grupo/Subgrupo.
A tela nova usa o vocabulário do negócio. `VehicleTypeConfigModal` ainda chama
`tipo` de "grupo de equipamento" — pendência de unificação.

## O que continua em aberto

- **Renomear subgrupo quebra vínculo.** Veículos, plano e apontamento guardam a
  string. `updateSubType` recusa renomeação de subgrupo em uso; a solução
  definitiva (trocar string por id) ficou fora de escopo.
- **`planoItemKey` nunca é gravado.** 2.856 alocações e 22.448 apontamentos com o
  campo nulo, desde 2025-01. Bug separado, ainda não diagnosticado.
- **`Trator de Esteiras`** aparece em 119 obras e não existe na taxonomia
  (`Trator Esteira`, 25 obras). Origem desconhecida — o plano é select, não texto
  livre. Consolidação pendente.
- **Compensação de horas** entre portes de máquina não é registrada em lugar
  nenhum. Fora de escopo por decisão de negócio.
