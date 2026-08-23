# Aceite e Baixa Automáticos de Abastecimento com IA

Documento **vivo**: atualizado ao final de cada fase, no mesmo commit da fase.

Objetivo: usar o Claude (visão) para ler a **foto do painel** (odômetro/horímetro) na abertura
da solicitação e a **foto do cupom/NF** na baixa, liberando automaticamente a ordem quando todos
os critérios passam e pré-preenchendo a baixa quando o cupom chega.

**Princípio inegociável:** a IA nunca nega nada. Ela decide apenas entre *liberar automaticamente*
e *encaminhar ao setor de abastecimento*. As regras de negócio já existentes são soberanas — quem
decide são os portões em código, o modelo só devolve leitura + confiança num schema fechado.

---

## Status por fase

| Fase | Escopo | Status | Conclusão |
|---|---|---|---|
| **A** — Segurança | Autorização nas rotas de abastecimento/comboio/solicitações | ✅ Concluída | 2026-08-21 |
| **1** — Fundação | Média unit-aware, parâmetros, migrações, fila | ✅ Concluída | 2026-08-21 |
| **B** — Correções | Travas de leitura no comboio, saldo, 20%, NF | ✅ Concluída | 2026-08-23 |
| **2** — Visão + motor | aiVisionService + abastecimentoAutoService (modo sombra) | ✅ Concluída | 2026-08-23 |
| **3** — Interface | Parecer no admin e no app, pré-preenchimento da baixa, tela de parâmetros | ✅ Concluída | 2026-08-23 |
| **4** — Modo ativo | Núcleo único de emissão, liberação automática real | ✅ Concluída | 2026-08-23 |
| **Implantação** | Backup, deploy, cadastro em produção, correção do 500, comunicação | ✅ Concluída | 2026-08-23 |

**Situação atual:** código em produção, cadastro aplicado, motor **desligado**. Falta ligar em modo
sombra numa obra piloto — ver "Próximo passo" no fim deste documento.

---

## Fase A — Segurança (concluída em 2026-08-21)

### O problema

`middlewares/authMiddleware.js` só barra URLs que contenham `/supervisor`. Nenhuma rota de
abastecimento, comboio ou solicitações tinha verificação de papel — o controle de acesso existia
apenas no menu do frontend. Na prática:

- `PUT /api/solicitacoes/:id/avaliar` — qualquer usuário autenticado aprovava ou negava qualquer
  solicitação, **inclusive a própria**. `ROLE_PAGE_ACCESS` define `operador: ['admin_solicitacoes_app']`,
  ou seja, o operador nunca deveria alcançar a tela de aprovação.
- `PUT /api/solicitacoes/:id/confirmar-baixa` — qualquer usuário marcava `CONCLUIDO` e destravava
  o veículo sem nenhum lançamento financeiro.
- `PUT /api/solicitacoes/:id/comprovante` — sem checar dono nem status: dava para enviar cupom na
  solicitação de outra pessoa (IDOR) e sobrescrever o de uma já concluída.
- `POST/PUT/DELETE /api/refuelings/*` e as rotas de comboio — idem, sem restrição.

Isso é pré-requisito do modo ativo: automação que promete "passou pelas regras" não vale nada
enquanto qualquer token consegue liberar por fora.

### O que foi feito

**`utils/permissions.js`** — novo `requireAnyPage(pageIds)`, irmão do `requirePage` que já existia
(e era usado em um único arquivo de rotas, `relatoRoutes.js`). Necessário porque algumas rotas
servem tanto o app do operador quanto o desktop do gestor.

**`routes/solicitacaoRoutes.js`**
- `requireGestor` — replica a condição que o `GET /` já usava (`admin` | `gestor` |
  `canAccessRefueling` | página `admin_solicitacoes`), agora aplicada a `/avaliar`,
  `/confirmar-baixa`, `/rejeitar-comprovante` e `/upload-pdf`. Reaproveitar a condição existente
  garante que ninguém que hoje consegue ver a lista perca a capacidade de agir.
- `requireApp` (`admin_solicitacoes_app` **ou** `admin_solicitacoes`) em `POST /` e `PUT /:id/comprovante`.
- `GET /` mantido aberto: ele já ramifica internamente entre gestor e operador.

**`routes/refuelingRoutes.js`** — `podeOperar` (`refueling` **ou** `admin_solicitacoes`) em todas as
mutações: `POST /`, `PUT /:id`, `DELETE /:id`, `/confirm`, `/liberar`, `/negar`, `/revelar`,
`/upload-pdf`, `/send-email`. Os `GET` seguem abertos a qualquer autenticado — já passam pelo
`HIDDEN_VISIBILITY_CLAUSE` e alimentam o `DataContext` de várias telas; guardá-los quebraria
dashboards de papéis como `rh` e `faturamento`.

**`routes/comboioTransactionRoutes.js`**
- `POST /saida` → `comboio` **ou** `admin_solicitacoes_app` (a distribuição é feita no desktop e
  também pelo operador do comboio na `ComboioMobilePage`).
- `POST /entrada`, `POST /drenagem`, `PUT /:id`, `DELETE /:id` → `comboio` (exclusivos do desktop).
- `GET` abertos.

**`controllers/solicitacaoAppController.js`**
- `enviarComprovante` agora carrega a solicitação antes de gravar e recusa com **404** se não
  existir, **403** se quem envia não é o dono (nem gestor) e **409** se o status não for
  `LIBERADO`/`AGUARDANDO_BAIXA`.
- Novo helper `descartarUpload(req)` substituindo cinco `fs.unlinkSync` — três deles sem
  `existsSync`, capazes de derrubar o handler e mascarar o erro real.

### Verificar em produção

Confirmar que continuam funcionando após o deploy:
1. Operador abre solicitação e envia cupom pelo app (`admin_solicitacoes_app`).
2. Operador do comboio faz uma distribuição com fotos (`POST /saida`).
3. Setor de abastecimento aprova/nega e dá baixa.
4. Usuário com `page_permissions` individual contendo só `admin_solicitacoes` consegue emitir ordem.

Se algum papel legítimo tomar 403, o ajuste é acrescentar a página na lista do `requireAnyPage`
correspondente — não remover a trava.

---

## Fase 1 — Fundação (concluída em 2026-08-21)

### `utils/consumo.js` (novo) — fonte única de consumo no backend

Gêmeo CommonJS de `frontend/src/utils/vehicleRules.js`, com duas diferenças em relação ao
`backend/utils/vehicleRules.js` que já existia:

1. **Hidrata a taxonomia do banco** (`vehicle_groups` + `vehicle_types`, cache de 5 min com
   fallback estático). O frontend já fazia isso via `hydrateVehicleTaxonomy`; o backend usava
   mapa hard-coded e divergia sempre que a taxonomia era editada no admin.
2. **`resolveMediaEsperada(vehicle, { conn, toleranciaPadrao })`** resolve média e tolerância em
   cascata, normalizando unidades: `vehicles.media_consumo` → `vehicle_type_configs(tipo, sub_tipo)`
   → `(tipo, NULL)` → `avg_last_3` → `avg_by_subtipo` → `avg_by_tipo` → `null`.

Também expõe `computeConsumption`, `converter` (só entre recíprocos: Km/L ↔ L/Km e L/h ↔ h/L;
Km/L → L/h devolve `null` porque são grandezas de leitura diferentes), `dentroDaTolerancia` e
`litrosEsperados`.

Decisão relevante: linha de `vehicle_fuel_averages` **sem** `unidade` preenchida é tratada como
`historico_sem_unidade` → média indeterminada. É formato antigo, cujo número não é confiável;
devolver indeterminado manda a solicitação para conferência humana, que é o lado seguro.

### `utils/recalcFuelAverage.js` — correção do bug de unidade

A versão anterior fazia `parseFloat(newer.odometro || newer.horimetro || 0)` e devolvia sempre
`diff / litros`:

- escolhia o odômetro sempre que ele fosse diferente de zero, ignorando o tipo de leitura real
  (máquinas costumam ter os dois campos preenchidos);
- para grupos em L/h gravava o **inverso** (h/L) — uma motoniveladora de 17,5 L/h aparecia como
  0,057, e toda a interface rotula o campo como "L/h";
- `avg_by_tipo` fazia `AVG()` misturando Km/L com h/L. O tipo `Cavalo` tinha `avg_last_1 = 2,958`
  ao lado de `avg_by_tipo = 0,094`.

Agora: leitura escolhida pela unidade do grupo, cálculo via `computeConsumption`, `unidade` gravada
na linha (valor auto-descritivo e marcador de migração), e `avg_by_tipo`/`avg_by_subtipo` filtrando
por unidade igual. Novas colunas `intervalos_validos` e `intervalos_tanque_cheio` (intervalos com
`isFillUp` nos **dois** extremos) — esta última é indicador de confiabilidade, não muda o cálculo.

**Filtro de plausibilidade.** Um erro de digitação de leitura envenenava a média em silêncio. O
RE616 tinha odômetro gravado como `161795162280` (o valor anterior concatenado com o novo):
intervalo de 161 bilhões de km, média de 3,98 bilhões de Km/L, estouro do `DECIMAL(10,3)` e UPSERT
abortado. Intervalos fora da faixa plausível por unidade (Km/L 0,1–100 · L/h 0,1–500 e recíprocos)
passam a ser descartados com aviso no log. No backfill isso pegou **35 intervalos ruins** na frota
inteira. Se todos os intervalos de um veículo forem descartados, a média fica indeterminada — e o
portão de média manda para o humano, que é o desfecho correto.

### Migrações (`server.js`)

**`utils/migrations.js` (novo)** — `addColumnIfMissing` / `addIndexIfMissing`.

Motivo: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` é sintaxe do **MariaDB**; o MySQL 8 responde
`ER_PARSE_ERROR`. O loop geral do `server.js` já tinha esse fallback embutido, mas ele não estava
disponível para blocos novos — o primeiro bloco escrito nesta fase reproduziu o padrão sem o retry,
e as três colunas de `vehicle_fuel_averages` não seriam criadas em produção (a falha só apareceu ao
rodar contra o MySQL real). O helper elimina a armadilha; o loop geral foi migrado para ele também.

Colunas acrescentadas:

| Tabela | Colunas |
|---|---|
| `vehicle_fuel_averages` | `unidade`, `intervalos_validos`, `intervalos_tanque_cheio` |
| `refuelings` | `createdFromSolicitacaoId` (+ índice `idx_from_solicitacao`), `liberacao_automatica`, `baixa_sugerida_ia` |
| `solicitacoes_abastecimento` | `ia_status`, `ia_decisao`, `ia_leitura_extraida`, `ia_confianca`, `ia_motivos`, `ia_analisado_em`, `liberacao_automatica` |

Tabelas criadas: `abastecimento_auto_config` (linha única, semeada com `INSERT IGNORE`),
`solicitacao_ia_analises` (auditoria de cada análise), `abastecimento_ia_fila` (fila espelhando
`erp_sync_queue`).

`refuelings.createdFromSolicitacaoId` passou a ser **gravada** em `createRefuelingOrder`. Ela já era
lida na baixa e na exclusão, mas nunca existiu no schema — só o fallback
`createdBy.linkedSolicitacaoId` funcionava. Os dois seguem gravados, para não quebrar as ordens
antigas.

### `scripts/recalcMediasConsumo.js` (novo)

```bash
node scripts/recalcMediasConsumo.js --listar
```

```bash
node scripts/recalcMediasConsumo.js --todos
```

Sem argumento, recalcula só os pendentes (`unidade IS NULL`). Ao final faz uma passada SQL única
consolidando `avg_by_tipo` / `avg_by_subtipo`: esses agregados são um retrato do momento do
recálculo, então num backfill em massa os primeiros veículos do lote enxergam a tabela quase vazia.

**Desvio do plano:** o backfill ficou como script, não como IIFE de boot. Percorrer 447 veículos
linha a linha a cada boot é caro e difícil de observar. Nada quebra sem ele — `recalcFuelAverage`
roda a cada baixa e as linhas se corrigem sozinhas; o script só antecipa a correção.

### Resultado do backfill (banco de teste)

447 veículos recalculados, 0 erros. Médias por tipo depois da correção:

| Tipo | Unidade | Média | n |
|---|---|---|---|
| Automóvel | Km/L | 11,71 | 18 |
| Camionete | Km/L | 11,55 | 65 |
| Moto | Km/L | 32,23 | 2 |
| Caminhão Prancha | Km/L | 2,23 | 4 |
| Escavadeira | L/h | 14,28 | 35 |
| Motoniveladora | L/h | 18,04 | 47 |
| Rolo | L/h | 11,41 | 30 |
| Retroescavadeira | L/h | 5,96 | 18 |
| Trator Esteira | L/h | 5,34 | 8 |

Todos fisicamente coerentes. Antes da correção esses mesmos tipos apareciam com valores como 0,035
e 0,282 (h/L disfarçado de L/h).

**Observação de qualidade de dado, não corrigida aqui:** `Caminhão Carroceria` (0,16 L/h) e
`Caminhão Pipa` (1,05 L/h) continuam implausíveis. O grupo `Caminhões` está configurado em L/h — o
que é intencional nesta frota (caçambas medidas por horímetro) — mas esses veículos específicos
parecem ter leitura de km gravada no campo de horímetro. Vale conferir o cadastro antes de
habilitá-los no piloto.

---

## Fase B — Correções que a automação depende (concluída em 2026-08-23)

**B1 — Saída de comboio não validava leitura nenhuma.** `createSaidaTransaction` grava uma linha em
`refuelings` já como `Concluída`, com odômetro/horímetro e litros, e essa linha alimenta
`recalcFuelAverage`. Não passava por `checkLeituraBloqueada` nem por regressão/salto, enquanto a
emissão de ordem normal passa. Uma leitura digitada errada na obra corrompia a média em silêncio —
justamente o insumo do portão G2. Agora usa `checkReadingConsistency` (a mesma função do frontend,
com a exceção de 2000 km dos Caminhões de Trecho) e devolve **409 `READING_BLOCK`**. Terceirizados e
veículos fictícios seguem isentos, como no fluxo de ordem.

**B2 — Saldo do comboio era clampado em zero.** `GREATEST(0, saldo - litros)` absorvia distribuição
maior que o disponível: o tanque zerava e ninguém ficava sabendo. Agora confere antes e recusa com
**409 `INSUFFICIENT_COMBOIO_BALANCE`**, informando saldo e litros pedidos. Tolerância de 1 L para
arredondamento de medidor. Comboio cujo nível **nunca foi rastreado** (`fuelLevels` sem a chave) não
bloqueia — comboio não inicializado não pode travar a operação.

**B3 — `checkLeituraBloqueada` engolia exceção.** O `catch` devolvia `null`, ou seja, falha de query
virava "leitura aprovada" e a ordem passava sem validação. Agora falha para o lado seguro: retém a
ordem e registra o erro.

**B4 — Três bases diferentes para a regra dos 20%.** Descoberta pior que a esperada: o banco de teste
**não tem a coluna `valorContrato`** — só `valorTotalContrato`. O código fazia `SELECT valorContrato`,
que estourava `ER_BAD_FIELD_ERROR`, e o `catch { return false; }` engolia: **a trava dos 20% nunca
disparava**, sem nenhum sinal no log. Agora `resolverColunasContrato` descobre via `information_schema`
quais colunas existem (uma vez, memorizado) e usa a precedência do frontend
(`valorTotalContrato || valorContrato`). Vale conferir se produção tem o mesmo formato.

**B5 — `utils/vehicleRules.js` com limite fixo de 1000 km.** O arquivo se declara "cópia FIEL" do
frontend mas tinha perdido a exceção de 2000 km dos Caminhões de Trecho. Corrigido e verificado:
prancha +1500 km passa, +2500 km bloqueia; automóvel +1500 km bloqueia.

**B6 — NF sem constraint.** O plano previa `UNIQUE (partnerId, invoiceNumber)`, mas o banco tem
**8 pares já duplicados e legítimos** — uma nota cobre mais de uma ordem (diesel + arla, ou dois
veículos na mesma nota). Um `UNIQUE` rejeitaria o caso válido. Em vez disso: índice não-único
`idx_partner_invoice` + `FOR UPDATE` na checagem de duplicidade da baixa, o que dá gap lock em
REPEATABLE READ e serializa duas baixas concorrentes com a mesma NF. Fecha a corrida sem quebrar o
caso legítimo.

### Refatoração que sustenta tudo isso

As quatro travas soberanas viviam soltas em `refuelingController.js` — duas como funções privadas e
duas inline no meio de `createRefuelingOrder`, misturadas com `rollback` e `res.status()`. Foram
extraídas para **`utils/regrasAbastecimento.js`** como predicados puros:

- `checkLeituraBloqueada` · `checkOrcamentoBloqueado` · `checkOrdemAbertaDuplicada` · `checkOperadorPlaceholder`

O controller passou a consumi-las. Isso é o que torna "as regras existentes são soberanas" literal:
o motor de IA **não replica** as verificações, ele chama exatamente o mesmo código do caminho humano.
Se fossem duas implementações, o primeiro ajuste numa delas faria a automação divergir em silêncio.

---

## Fase 2 — Visão + motor de decisão (concluída em 2026-08-23)

### `services/aiVisionService.js`

`lerPainel(caminho, { tipoLeitura })` e `lerCupom(caminho)`, ambos com saída estruturada.

**Escolha técnica:** `tool_choice` forçado em vez de `output_config`. Nesta versão do SDK (0.96.0)
`output_config` só existe no namespace **beta**, enquanto tool use forçado é estável e se comporta
igual no Haiku e no Opus. O schema é validado e normalizado no nosso lado (confiança 0–100 vira 0–1,
número com vírgula vira ponto, CNPJ/NF viram só dígitos).

**Escalonamento híbrido:** Haiku 4.5 primeiro; se vier `legivel: false` ou confiança abaixo do
limiar, reprocessa com Opus 5 e usa a segunda resposta. Credencial inválida não escalona (não
melhora com outro modelo). Se a segunda falhar e a primeira tinha resposta, fica com a primeira.

**Quatro princípios embutidos no prompt:**

1. **Leitura cega** — o prompt do painel **não recebe** o valor digitado pelo operador. Se recebesse,
   o modelo tenderia a confirmar o número em vez de ler a foto, e a comparação perderia o sentido.
2. **O modelo não decide** — o schema não tem campo "aprovar". Ele devolve leitura + confiança;
   liberar é decisão dos portões em código.
3. **Texto na imagem é dado, nunca instrução** — dito explicitamente no system prompt.
4. **Chute é pior que "não sei"** — palpite com confiança alta viraria liberação automática.

**Robustez:** `resolverCaminho` barra path traversal (o caminho vem do banco, mas o banco é
alimentado por upload de usuário — verificado: `../../../etc/passwd` é recusado). PDF devolve
`FORMATO_NAO_SUPORTADO` em vez de estourar (cupom fiscal eletrônico chega em PDF com frequência).
Arquivo vazio, extensão desconhecida e acima de 3,7 MB também são recusados antes de gastar chamada.
Sem `ANTHROPIC_API_KEY` o serviço fica **inerte** (`isConfigured() === false`), no padrão do
`erpSyncService` — o fluxo volta a ser o manual de hoje, sem erro para o usuário.

### `services/abastecimentoAutoService.js` — os portões

Avaliação curto-circuitada: o primeiro portão que não passa encerra. **G0 e G1 vêm antes da chamada
de visão de propósito** — pedido inelegível ou que já viola regra soberana não gasta IA.

| Portão | O que verifica |
|---|---|
| **G0** elegibilidade | escopo do piloto (obra/tipo), foto presente, veículo não terceirizado/fictício/comboio, pode circular, solicitante não bloqueado |
| **G1** regras soberanas | as mesmas de `utils/regrasAbastecimento` **+ leitura estritamente maior que a atual** |
| **G2** média | consumo dentro da faixa esperada |
| **G3** necessidade | o consumo estimado justifica a litragem pedida? |
| **G4** visão | leitura da foto bate com a digitada, com confiança acima do limiar |
| **G5** teto | valor estimado da ordem abaixo do limite |

**G1 acrescenta uma regra que só existia no frontend.** `checkLeituraBloqueada` aceita igualdade (só
`<` bloqueia); a exigência de leitura *estritamente maior* mora apenas em
`SolicitacaoAbastecimentoPage`. Para liberar sozinho ela precisa valer no backend: leitura repetida
significa veículo que não rodou, ou operador copiando o valor anterior. Isso **não** muda o fluxo
manual — só o critério de liberação automática.

**G2 tinha uma falha de projeto que foi corrigida durante o teste.** Como nenhum veículo da frota tem
`media_consumo` cadastrada e `vehicle_type_configs` está vazia, a média esperada sempre caía no
fallback do próprio histórico — e o portão comparava `avg_last_3` **consigo mesmo**. Tautologia: passava
sempre, virando no-op justamente no caso mais comum. Agora a comparação muda conforme a fonte:

- média vinda de **cadastro** → compara `avg_last_3` (histórico recente) contra o parâmetro;
- média vinda do **próprio histórico** → compara `avg_last_1` (último abastecimento) contra
  `avg_last_3` (linha de base do veículo). A pergunta útil vira "o último abastecimento destoou?".

Verificado: RE583 passa (8,17 vs 8,43 L/h), RE530 falha (5,39 vs 9,71 Km/L — exatamente o caso que
um humano deve olhar).

**G3 ganhou fallback de capacidade de tanque.** Só **2% da frota** tem `fuelCapacity` cadastrada e
**70% das solicitações pedem tanque cheio** — sem fallback este portão sozinho mandaria ~69% de tudo
para conferência manual e a automação nunca sairia do papel. O maior abastecimento já registrado no
veículo é um piso razoável para a capacidade (ninguém pôs mais litros do que cabe). Subestima o
tanque real, o que empurra o percentual estimado para cima: **erra liberando de menos**, que é a
direção certa. Verificado numa Caçamba Truckado (tanque derivado 263 L): gastou 15% → retém,
35% e 70% → libera, 120% → retém por exceder o tanque.

### Fila e gatilhos

Três pontos de entrada disparam a análise **depois do commit** (`setImmediate`, sem afetar a resposta
ao operador): `criarSolicitacao` (app), `criarSolicitacaoDB` (WhatsApp) e `enviarComprovante` (cupom).

A tabela `abastecimento_ia_fila` é rede de segurança, não o caminho principal: enfileira antes de
disparar, e um worker no cron (a cada 2 min, mecânica do `erpSyncService` — trava de reentrância,
claim otimista, `MAX_TENTATIVAS = 3`) pega o que ficou para trás em restart ou queda da API.

### Auditoria

Toda análise grava em `solicitacao_ia_analises`: modelo usado, se escalonou, resposta crua do
modelo, confiança, todos os portões com veredito, tokens, latência e erro. É o que permite calibrar
limiares e provar por que uma ordem foi (ou não foi) liberada.

`solicitacoes_abastecimento.alerta_media_consumo` — que existia desde a migração do chatbot e era
gravada com `0` fixo nos dois pontos de INSERT, sem nunca ser lida — finalmente carrega significado:
marca quando o portão de média reprovou.

### O que foi verificado

- Funções puras de `consumo.js` (12 asserções) e normalização do `aiVisionService`
- Path traversal recusado; PDF, arquivo vazio e extensão inválida recusados
- Travas soberanas contra dados reais: regressão, salto, exceção 2000 km, ordem aberta,
  fim de semana, orçamento, Pátio
- G2 discriminando entre veículo dentro e fora do padrão
- G3 nos quatro cenários (litragem compatível, triplo do justificado, leitura parada, tanque cheio
  em 15/35/70/120%)
- Caminho completo com persistência: colunas da solicitação + linha de auditoria
- Sintaxe de todos os arquivos alterados

**Não verificado:** a leitura de imagem de ponta a ponta. `ANTHROPIC_API_KEY` não está no `.env`
local (é injetada pelo Easypanel em produção), então G4 devolve `indeterminado` aqui. O primeiro
teste real de visão precisa rodar em ambiente com a chave, via
`node scripts/testarIaAbastecimento.js --imagem <foto> --tipo odometro`.

### Pré-requisitos de dado antes do piloto

A automação depende de cadastro que hoje está vazio:

| Item | Situação | Efeito |
|---|---|---|
| `vehicles.fuelCapacity` | 8 de 426 (2%) | tanque cheio usa fallback pelo histórico; cadastrar melhora a precisão |
| `vehicles.media_consumo` | 0 | G2 compara contra a linha de base do próprio veículo |
| `vehicle_type_configs` | tabela vazia | idem |
| Veículos com ≥3 intervalos | 233 de 447 (52%) | os outros 48% ficam `indeterminado` no G2 → conferência humana |

Nada disso impede ligar o modo sombra — só limita quantas solicitações chegariam a "liberaria".

---

## Fase 3 — Interface (concluída em 2026-08-23)

### API — `/api/abastecimento-auto`

`controllers/abastecimentoAutoController.js` + `routes/abastecimentoAutoRoutes.js`, protegidas por
`requireAnyPage(['refueling','admin_solicitacoes'])` — configurar quem libera abastecimento sozinho
exige o mesmo papel das demais ações do setor.

| Rota | Uso |
|---|---|
| `GET /config` | parâmetros + flag `credencial_ia_configurada` (nunca a chave) |
| `PUT /config` | whitelist explícita de campos; `id` e `updated_at` ficam de fora |
| `GET /metricas?dias=N` | concordância, quebra por portão, custo e estado da fila |
| `GET /analises/:id` | histórico de análises de uma solicitação |
| `POST /reprocessar/:id` | reanalisa após ajuste de limiar; **409** se não houver credencial |

Dois cuidados na conversão de entrada: a tela pode mandar confiança como `0,9` **ou** `90` (ambos
viram 0.9), e `parseFloat('2,5')` devolve `2` — para na vírgula. Como a interface é em português e o
usuário digita vírgula decimal, há um `numeroBR()` normalizando antes de converter. Sem isso,
"tolerância 2,5 km" seria gravada como 2.

### Componentes compartilhados

**`components/refueling/IaParecer.js`** — `resumoIa()` normaliza as colunas `ia_*` num estado único,
consumido por três apresentações: `IaBadge` (chip para listas), `IaPainel` (detalhe com os portões,
só para o gestor) e `IaFaixaOperador` (faixa do app, sem motivos).

**`components/refueling/SugestaoCupomIa.js`** — painel da leitura do cupom, usado nos **dois**
formulários de baixa. `BaixaForm` e `ConfirmRefuelingModal` já são quase idênticos, com as cinco
validações duplicadas verbatim entre eles; o painel nasceu compartilhado para não agravar isso.
(Primeiro escrevi inline no `BaixaForm` e extraí em seguida — duplicar seria incoerente com a
revisão que aponta essa duplicação como problema.)

### Tela do gestor — `AdminSolicitacoesPage`

- Chip do parecer no card, ao lado do status.
- Bloco "Análise da IA" no modal: leitura da foto × leitura digitada, confiança e cada portão com
  veredito e motivo, com nomes traduzidos (`G2_media` vira "Média de consumo").
- Nova aba **"IA liberaria"** ao lado de Pendentes / Baixas / Histórico.
- Botão **Reprocessar análise**, útil depois de ajustar um limiar ou quando a API estava fora.
- Em modo sombra, faixa roxa explicando que nada foi liberado e que o registro alimenta a
  taxa de concordância.

### Tela do operador — `SolicitacaoAbastecimentoPage`

Faixa no card e no modal de detalhe, com três regras de conteúdo deliberadas:

1. **Nunca "negado" ou "reprovado".** Esses termos ficam reservados ao status `NEGADO`, que é decisão
   humana e traz `motivo_negativa`. A IA não nega — ela só deixa de liberar sozinha.
2. **O motivo detalhado não vai para o operador.** Ele vê "enviado ao setor de abastecimento para
   conferência"; os portões que falharam ficam só na tela do gestor. Dizer "sua leitura não bateu com
   a foto" ensina a contornar o portão.
3. **Em modo sombra o operador não vê nada.** A decisão ainda é simulada; anunciar "liberado pela IA"
   enquanto um humano ainda vai decidir seria mentira na tela. Implementado em `IaFaixaOperador`,
   que devolve `null` quando `ia_decisao = AUTO_LIBERADO_SIMULADO`.

A barra lateral colorida do card também reflete o encaminhamento (âmbar).

### Baixa pré-preenchida

`SugestaoCupomIa` mostra litros, R$/litro, total e NF lidos do cupom, cada um com marca de
`confere ✓` / `diverge ✕` / `não lido`, e um botão **"Preencher com estes valores"**. O submit
continua sendo o `confirmRefuelingOrder` de sempre, com as mesmas travas e `PasswordConfirmationModal`
— a IA elimina a digitação, não a conferência.

### Tela de parâmetros — `AbastecimentoIaTab`

Nova aba "Aceite Automático" em Admin → Frota e em Admin. Contém liga/desliga, escolha sombra/ativo,
seleção de obras do piloto, todos os limiares e o painel de concordância.

**O botão do modo ativo é bloqueado por regra, não por disciplina:** exige pelo menos 20 solicitações
resolvidas e **zero falsos positivos** (casos em que a IA teria liberado algo que o setor negou).
Enquanto houver qualquer um, o botão fica desabilitado e explica o motivo. Deixar isso na mão de
alguém lembrar seria o ponto mais provável de falha do piloto.

A quebra "o que mais retém" mostra qual portão barra mais, separando `reprovou` de `sem dados` — e a
tela diz explicitamente que "sem dados" costuma ser cadastro faltando, não erro da IA.

### O que foi verificado

- API contra o banco: leitura, gravação com whitelist, conversões (85 → 0.85; `'2,5'` → 2.5; modo
  inválido → sombra; `id` não sobrescrito), recusa de corpo vazio, métricas, 409 sem credencial
- Build de produção do frontend compila; os três arquivos novos ficaram **sem nenhum aviso** de lint
- Os arquivos editados não ganharam avisos novos (os existentes são BOM, imports não usados e
  dependências de hook, todos anteriores)
- Cadeia de `require` do backend íntegra após a extração das regras soberanas

**Não verificado:** a interface com dados reais de IA. Sem `ANTHROPIC_API_KEY` no ambiente local não
há parecer para renderizar, então os componentes foram exercitados apenas pelo caminho "sem análise".

---

## Fase 4 — Modo ativo (concluída em 2026-08-23)

### `criarOrdem` — núcleo único de emissão

O miolo de `createRefuelingOrder` foi separado do handler HTTP e exportado como
`criarOrdem(data, { actor, io })`, devolvendo `{ ok, status, body }` em vez de escrever na resposta.
O handler virou um wrapper de três linhas.

Agora **três** caminhos emitem ordem pelo mesmo código:

| Caminho | Como chega |
|---|---|
| Gestor pela tela | `POST /api/refuelings` → wrapper → `criarOrdem` |
| `PUT /solicitacoes/:id/avaliar` | agora chama `criarOrdem` (antes: `INSERT` cru) |
| Liberação automática (modo ativo) | `abastecimentoAutoService` → `criarOrdem` |

**Desvio do plano, deliberado:** ficou em `controllers/refuelingController.js` e não num
`services/refuelingOrderService.js`. A função depende de três helpers privados do controller
(`dispatchOrderToPartner`, `updateMonthlyExpense`, `safeNum`) com 11 pontos de uso; movê-los daria um
import mais bonito, nenhum ganho funcional e risco real de regressão. O objetivo do plano — uma
implementação só, compartilhada — está cumprido.

### O `INSERT` cru de `avaliarSolicitacao`

Aquele caminho montava a linha de `refuelings` à mão e pulava **tudo**: ordem já aberta para o
veículo, operador placeholder há mais de 7 dias, regressão/salto de leitura, o limite de 20% do
contrato, o empenho de saldo pré-pago e o envio da ordem ao posto.

Na prática a tela não o usava (ela abre o `RefuelingOrderModal` e emite pelo `POST /api/refuelings`),
mas o endpoint seguia aberto e era uma porta lateral em volta das regras — exatamente o tipo de
brecha que a Fase A fechou no nível de autorização. Agora chama `criarOrdem`.

Detalhe de transação: `criarOrdem` abre a própria conexão, então o fluxo de aprovação encerra a dele
antes de chamar, com uma flag `liberouConexao` para o `finally` não liberar duas vezes.

### Bug encontrado na extração: release duplo de conexão

Dois caminhos de `createRefuelingOrder` (`DUPLICATE_OPEN_ORDER` e `PLACEHOLDER_OPERATOR_BLOCK`)
chamavam `connection.release()` e caíam no `finally`, que liberava **de novo**. No pool do mysql2
isso devolve a mesma conexão duas vezes à lista livre: dois requests podem receber a mesma conexão
física e intercalar transações.

Bug pré-existente, em dois dos caminhos mais comuns. Corrigido deixando só o `finally`, e o teste
confirma que 12 chamadas seguidas nos caminhos de erro não degradam o pool.

### Segundo achado: `undefined` nos binds

`refuelingData.partnerId` recebia `data.partnerId` sem normalizar. Um chamador que omitisse o campo
em vez de mandar `null` levava um 500 (`Bind parameters must not contain undefined`). Era tolerável
enquanto só o frontend chamava e sempre enviava tudo; deixou de ser agora que código emite ordem.
Todos os valores do INSERT passam por uma normalização `undefined → null`.

### A liberação automática

Com `modo = 'ativo'` e todos os portões aprovados, o motor chama `criarOrdem` com
`createdBy = { id: null, name: 'Liberação Automática (IA)', ia: true }`, marca
`liberacao_automatica = 1` na ordem e na solicitação, e avisa o solicitante por WhatsApp
(reaproveitando o padrão da negativa manual). A ordem segue para o posto pelo
`dispatchOrderToPartner` de sempre.

**As travas rodam duas vezes, de propósito.** O portão G1 avalia as regras soberanas na análise;
`criarOrdem` as avalia de novo, dentro da própria transação e com `FOR UPDATE`. Entre a análise e a
emissão passam segundos, e nesse intervalo outra ordem pode ter sido aberta para o mesmo veículo. Se
`criarOrdem` recusar, a decisão vira `MANUAL`, o motivo entra nos portões como `emissao` e a
solicitação segue para o humano — nunca insistir.

### O que foi verificado

Teste da extração contra o banco, com limpeza do que criou:

- ordem reservada sem permissão → 403
- veículo com ordem aberta → 409 `DUPLICATE_OPEN_ORDER`
- mesmo veículo no sábado → permite (exceção de fim de semana preservada)
- criação normal → 201, com `authNumber` e linha gravada corretamente
- `createdFromSolicitacaoId` gravado e solicitação marcada `LIBERADO`
- 12 chamadas nos caminhos de erro sem degradar o pool (confirma a correção do release duplo)
- sintaxe e cadeia de `require` de todo o backend íntegras

**Não verificado:** a emissão automática de ponta a ponta. Ela só dispara quando os seis portões
passam, e o G4 depende de `ANTHROPIC_API_KEY`, ausente no ambiente local. O caminho foi exercitado
até a decisão; a chamada a `criarOrdem` a partir do motor não chegou a executar.

### Como ligar, quando chegar a hora

1. `ANTHROPIC_API_KEY` no ambiente (a tela de parâmetros avisa se faltar).
2. Admin → Frota → Aceite Automático: ligar o motor, deixar em **sombra**, marcar **uma** obra.
3. Rodar 2–4 semanas. O botão do modo ativo destrava sozinho quando houver 20+ solicitações
   resolvidas e **zero falsos positivos** — não é disciplina, é regra na tela.
4. Ao virar para ativo, acompanhar as primeiras ordens pela aba "IA liberaria".

Para voltar atrás: desmarcar "Motor ligado" na mesma tela. Nada mais precisa ser desfeito — o que já
foi emitido é ordem normal, indistinguível das demais exceto pela marca `liberacao_automatica`.

---

## Implantação (2026-08-23)

### Backup

`F:\Backup_15-03\backups_frotasmak\2026-08-23_1249\`

| Arquivo | Conteúdo |
|---|---|
| `codigo/FrotasMak_codigo.tar.gz` | 240 MB — código sem node_modules |
| `banco/producao_frotasmak_COMPLETO.sql(.gz)` | 717 MB / 103 MB — 113 tabelas, 5,54 M linhas |
| `banco/producao_vehicles_ANTES.sql` | 340 KB — só `vehicles`, para rollback rápido do cadastro |
| `banco/db-teste.sql(.gz)` | 233 MB / 35 MB — 117 tabelas, 1,65 M linhas |

Não havia `mysqldump` na máquina, daí `scripts/backupBanco.js`. A primeira versão travou em
`sigasul_positions` (1,27 milhão de linhas) por paginar com `OFFSET`, que relê tudo a cada lote —
O(n²). Trocado por paginação por chave: 1min18s contra mais de 30 minutos.

### Deploy

Backend `almirseibert/frotasmak` e frontend `almirseibert/frontend`, ambos em `main`. As migrações
rodam no boot, então as colunas e tabelas novas só passam a existir depois do deploy — o import do
CSV funcionou antes disso porque toca apenas colunas de `vehicles` que já existiam.

### Erro 500 ao salvar a configuração — corrigido no mesmo dia

Primeiro uso real da tela de parâmetros em produção devolveu 500 em
`PUT /api/abastecimento-auto/config`, com a mensagem genérica "Erro ao salvar configuração.".

Diagnóstico: as tabelas existiam, as colunas existiam e o `UPDATE` cru funcionava. Reproduzindo o
handler inteiro contra produção (via cwd temporário contendo só o `.env` de produção), o caminho
passava. A causa estava em `updateConfig`, que fazia `config.ativo` no log logo depois de recarregar
a configuração — e `carregarConfig` devolve `null` quando a leitura falha. O `TypeError` caía no
catch genérico.

**O `UPDATE` já tinha gravado antes de estourar**: a tela mostrava erro enquanto o banco já estava
alterado. O pior dos dois mundos, porque convida a repetir a operação.

Por que a leitura falhava: `carregarConfig` cacheava resultado **vazio** por 30 s. As migrações do
boot são IIFEs assíncronas que rodam em paralelo com o servidor já atendendo requisições; uma leitura
nesse intervalo encontra a tabela ainda sem a linha e congela "sem configuração" por meio minuto,
mesmo depois de a semente ter sido gravada.

Correções:
- `carregarConfig` não cacheia mais resultado vazio;
- `updateConfig` relê direto da tabela como plano B e só falha com `CONFIG_SALVA_SEM_LEITURA` se nem
  isso funcionar;
- blindagem de `req.body` e `req.user` ausentes (400/200 em vez de 500);
- a resposta de erro passa a trazer `code`, para diagnosticar pelo navegador sem reproduzir às cegas.

### O 500 que sobrou: `updated_by INT` — corrigido em 2026-08-23

Depois do redeploy o erro voltou, agora com o código que a correção acima passou a expor:
**`ER_TRUNCATED_WRONG_VALUE_FOR_FIELD`**. Foi o `code` na resposta que resolveu — sem ele o
diagnóstico teria sido outra rodada de reprodução às cegas.

A causa: `abastecimento_auto_config.updated_by` foi declarada `INT`, mas **`users.id` é
`VARCHAR(255)`** — UUID herdado do Firebase, não inteiro. Todo `UPDATE` da tela grava
`updated_by = <uuid>`, e o MySQL em modo estrito recusa. Ou seja: a tela **nunca** conseguiu salvar;
o defeito anterior mascarava este.

Exatamente a mesma armadilha já tinha acontecido em `partner_fuel_credit_entries.created_by`, que
carrega um `MODIFY COLUMN ... VARCHAR(64)` de conversão no `server.js`. A correção segue esse
precedente: o `CREATE TABLE` passa a declarar `VARCHAR(64)` e um `ALTER TABLE ... MODIFY` idempotente
converte a tabela que já existe em produção, no boot.

Lição para as próximas tabelas: neste banco **nenhuma coluna que aponta para `users.id` pode ser
`INT`**. Vale conferir `solicitacao_erros_log.usuario_id`, declarada `INT NOT NULL` no `server.js`.

### Cadastro de capacidade e média

Aplicado em produção por família de modelo, em duas rodadas:

| | Antes | Depois |
|---|---|---|
| Capacidade de tanque | 8 (2%) | **403 (86%)** |
| Média esperada | 6 (1%) | **438 (94%)** |
| Tolerância | — | **466 (100%)**, todos em 20% |

Primeira rodada: 160 famílias preenchidas à mão, cobrindo 380 veículos. Segunda: pesquisa web dos 76
modelos restantes, com 15 famílias preenchidas por especificação de fabricante.

Ficaram deliberadamente em branco 11 semirreboques (reboque não tem motor nem tanque), 16 famílias de
cadastro genérico sem modelo identificável, e os modelos cuja busca só devolveu faixa ampla demais
(Mercedes Axor 130–590 L, Volvo VM 280–560 L) — escolher um número dentro de faixa assim seria chute.

A **média de consumo não veio da web**: L/h é operacional, não é especificação de fabricante, e
número de catálogo não teria relação com a operação em obra. Foi usada a convenção já adotada nas
famílias preenchidas à mão, por tipo de veículo. A coluna `origem` em
`docs/capacidades_FALTANTES_preenchido.csv` registra a procedência de cada valor.

**Dois problemas de dado que a importação expôs**, e que vão se repetir a cada rodada:

1. O Excel converteu o modelo IVECO `240E25` em notação científica (`2,40E+27`) ao salvar o CSV.
2. A marca do RE517 no banco é literalmente `16`; corrigi-la na planilha para `VOLKSWAGEN` é o certo
   do ponto de vista do dado, mas quebra a chave de junção `marca|família|tipo`.

Por isso `importarCapacidadeModelos.js` ganhou casamento de reserva pelos modelos exatos da coluna
`modelos_incluidos` — sempre reportado, nunca silencioso. Os dois casos foram recuperados.

### Comunicação

- `docs/guia-equipe-abastecimento.md` — para quem aprova ordens e faz baixas.
- `docs/post-whatsapp-divulgacao.md` — avisos aos grupos das obras, em **duas fases**.

A divulgação foi dividida porque o texto inicial prometia liberação imediata, o que só é verdade no
modo ativo. Enviá-lo durante o treinamento faria o operador concluir que o sistema falhou e voltar a
ligar para o escritório — exatamente o que a mudança quer evitar.

- **Fase 1**, ao habilitar a obra em sombra: a obra foi sorteada para começar, todos os veículos
  passam a pedir pelo site, e os 15 dias seguintes são de treinamento.
- **Fase 2**, ao virar para ativo: a ordem sai na hora, a qualquer dia e horário.

Os 15 dias são o mínimo, não uma promessa: a virada também depende de zero falsos positivos e de 20+
pedidos resolvidos, então obra que pede pouco leva mais tempo. O arquivo orienta a não prometer data.

---

## Ajustes de escopo (2026-08-23)

### Escopo por veículo, não só por obra

O piloto nasceu com escopo só por **obra**, e isso não sobrevive a esta operação: veículo é
remanejado entre obras o tempo todo. A cada remanejamento o veículo sairia do piloto e só
voltaria quando alguém lembrasse de marcar a obra nova — perdendo a liberação automática
justamente no momento em que ela mais vale.

`abastecimento_auto_config` ganhou **`veiculos_habilitados`** (JSON, mesma forma de
`obras_habilitadas`). O portão G0 passa a aceitar **obra marcada OU veículo marcado**:

| Situação | Resultado |
|---|---|
| Nenhuma das duas listas preenchida | fora do piloto (como antes) |
| Obra da solicitação marcada | dentro |
| Veículo marcado, em qualquer obra | dentro |

**O filtro `tipos_habilitados` não se aplica ao veículo marcado individualmente.** Escolher um
veículo a dedo é a instrução mais específica que a tela oferece; deixar um filtro genérico
derrubá-la faria a marcação não surtir efeito sem nenhuma pista do motivo. O mais específico
vence — e o parecer diz qual dos dois caminhos valeu ("Veículo marcado individualmente" ou
"Obra dentro do escopo").

### Só obras ativas na escolha

A lista de obras da tela passa a mostrar apenas `status = 'ativa'`. Exceção deliberada: obra que
**já está marcada** e encerrou depois continua aparecendo, rotulada `[encerrada]`, para poder ser
desmarcada. Escondê-la deixaria escopo ativo invisível na tela, que é pior do que uma linha a mais.

Os veículos oferecidos excluem terceirizado, fictício e comboio — o G0 recusa os três de qualquer
forma, e listá-los seria convidar a marcar um veículo que nunca seria liberado.

### As médias em produção ainda não foram recalculadas

O parecer da IA em produção mostra `Histórico insuficiente: 0 intervalo(s), mínimo 3` para
**toda** a frota. Não é falta de histórico: `vehicle_fuel_averages` existe e vem de `refuelings`,
mas as colunas `unidade` / `intervalos_validos` / `intervalos_tanque_cheio` (Fase 1) só são
preenchidas pelo recálculo novo, e o backfill dos 447 veículos registrado acima rodou no **banco
de teste**. Em produção nunca rodou, e `NULL` é lido como zero pelo G2.

Enquanto isso não for feito, o G2 devolve `indeterminado` para todas as solicitações e o piloto
não sai do lugar. Rodar **dentro do container** (na máquina local o `.env.local` desvia para o
banco de teste):

```bash
node scripts/recalcMediasConsumo.js --listar
```

```bash
node scripts/recalcMediasConsumo.js
```

**Não existe atalho invertendo h/L → L/h.** Inverter corrige o número mas não preenche `unidade`
nem `intervalos_validos`, que é o que o portão lê — e o recálculo já é feito a partir de
`refuelings`, a mesma fonte de onde a média antiga saiu, só que com a leitura certa por grupo e
com o filtro de plausibilidade. O caminho curto e o caminho certo são o mesmo.

Detalhe que vai importar na calibragem: a consulta do recálculo usa `LIMIT 4` ordens, ou seja, no
máximo **3 intervalos**. Com `min_intervalos_historico = 3` o mínimo é igual ao teto — basta um
intervalo descartado por implausibilidade para o veículo nunca passar no G2. Se depois do backfill
a maioria da frota ficar em 2, o ajuste é baixar o mínimo para 2 na tela, não mexer no código.

---

## Migrações aplicadas

Todas inline em `server.js`, idempotentes, via `utils/migrations.js`. Verificadas no banco de teste
(`db-teste`) em 2026-08-21, incluindo segunda passada para confirmar idempotência. Aplicadas em
produção (`frotasmak`) no deploy de 2026-08-23, pelo boot do servidor.
Ver a tabela na Fase 1 acima.

## Parâmetros em produção

`abastecimento_auto_config` nasce com `ativo = 0` e `modo = 'sombra'` — o motor fica inerte até
alguém ligar pela tela de admin (Fase 3). Defaults semeados:

| Campo | Valor |
|---|---|
| `ativo` / `modo` | 0 / sombra |
| `obras_habilitadas` / `tipos_habilitados` / `veiculos_habilitados` | NULL (vazio = nada no piloto) |
| `confianca_minima_painel` / `_cupom` | 0,90 / 0,90 |
| `tolerancia_leitura_km` / `_hr` | 1,00 / 1,00 |
| `tolerancia_media_padrao` | 20,00 % |
| `min_intervalos_historico` | 3 |
| `exigir_tanque_cheio_historico` | 0 |
| `percentual_minimo_tanque` | 30,00 % |
| `limite_valor_auto` | R$ 1.500,00 |
| `modelo_rapido` / `modelo_preciso` | claude-haiku-4-5 / claude-opus-5 |

Aplicado em produção no deploy de 2026-08-23, com esses mesmos defaults. **O motor está desligado**
(`ativo = 0`): nenhuma solicitação é analisada até alguém ligar e marcar ao menos uma obra.

Nenhum limiar foi alterado ainda — a primeira calibragem só faz sentido depois de ver a quebra "o que
mais retém" com dados reais.

## Registro de calibragem

_(cada mudança de limiar, com a métrica que motivou)_

## Diário do modo sombra

_(taxa de concordância por semana, falsos positivos com o id da solicitação, e a decisão de
virar ou não para o modo ativo)_

## Problemas conhecidos / adiados

- **`foto_painel` / `foto_cupom` aceitam `application/pdf`.** Mantido de propósito: cupom fiscal
  eletrônico (NFC-e) chega em PDF com frequência. A API de visão não lê PDF como imagem, então o
  tratamento fica no `aiVisionService` (Fase 2), devolvendo `ia_status = 'FORMATO_NAO_SUPORTADO'`
  em vez de estourar.
- **`ANTHROPIC_API_KEY`** foi documentada em `backend/CLAUDE.md` na Fase 2. Continua ausente dos
  `.env` locais (é injetada pelo Easypanel), então o portão de visão fica `indeterminado` em
  desenvolvimento — o primeiro teste real de leitura de imagem precisa rodar em ambiente com a chave.
- **Leitura de km gravada em campo de horímetro** em alguns caminhões — ver observação na Fase 1.
- **Cadastro restante.** 63 veículos ainda sem capacidade de tanque e 28 sem média. Destes, 11 são
  semirreboques (corretos: reboque não abastece) e o resto é cadastro genérico demais para valer
  qualquer número. Enquanto assim, esses pedidos continuam indo para conferência humana — que é o
  desfecho correto. `vehicle_type_configs` segue vazia; a média está no próprio veículo.
- **Marca do RE517 é `16`** no cadastro, e não `VOLKSWAGEN`. Vale corrigir. Outros veículos podem ter
  marca/modelo igualmente corrompidos — a coluna `modelos_incluidos` do export ajuda a localizar.
- **Dados de litragem com erro de digitação.** Há lançamentos de 4216 L numa Fiat Strada e 3169 L
  numa Oroch. Por isso a estimativa de tanque usa percentil 95 e não o máximo. Vale uma varredura
  desses outliers em `refuelings.litrosAbastecidos`.
- **`fuelCapacity` pré-existente suspeito**: uma S10 cadastrada com 300 L e um Foton com 1000 L
  apareceram no export. Eram parte dos 8 valores que já existiam antes; foram preservados pela
  importação (que não sobrescreve sem `--sobrescrever`) e continuam por conferir.
- **Excel corrompe códigos de modelo** ao salvar o CSV (`240E25` vira `2,40E+27`). O casamento de
  reserva por `modelos_incluidos` cobre isso, mas convém conferir a coluna `origem` depois de cada
  rodada de preenchimento.
- Demais itens: ver o grupo **C** da revisão no plano de implementação.

---

## Próximo passo

1. **Redeploy do backend** com a correção do `updated_by` — sem ela a tela de parâmetros
   não salva (ver "O 500 que sobrou" acima). O `ALTER TABLE` roda sozinho no boot.
2. **Rodar `node scripts/recalcMediasConsumo.js` no container** — sem isso o G2 fica
   `indeterminado` para a frota inteira (ver "Ajustes de escopo" acima).
3. Admin → Frota → Aceite Automático: ligar o motor, deixar em **sombra**, marcar **uma** obra
   e/ou os veículos que devem entrar independentemente de obra.
4. Enviar o aviso da **Fase 1** no grupo daquela obra.
5. Acompanhar por no mínimo 15 dias. O botão do modo ativo destrava sozinho com 20+ pedidos
   resolvidos e zero falsos positivos.
6. Ao virar para ativo, enviar o aviso da **Fase 2** e acompanhar as primeiras ordens pela aba
   "IA liberaria".

Para voltar atrás em qualquer momento: desmarcar "Motor ligado". O que já foi emitido é ordem comum,
indistinguível das demais exceto pela marca `liberacao_automatica`.
