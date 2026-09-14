# Auditoria de código — setembro/2026

**Escopo:** aplicação inteira, ~103.000 linhas próprias (backend `frotasmak` + frontend), excluída a
biblioteca vendored do WhatsApp.
**Data:** 11/09/2026. **Base consultada:** produção (`frotasmak` @ 217.196.60.62), somente leitura.

**53 achados:** 17 da revisão do PR `feat/subgrupo-n-para-n` (16 corrigidos, 1 recusado
deliberadamente) e 36 da auditoria geral, ainda abertos.

---

## Sumário executivo

### Os três padrões que atravessam tudo

**1. Falha silenciosa.** Onze `catch` que só fazem `console.warn` em caminhos que movimentam
dinheiro, integridade ou permissão. A aplicação quase nunca falha alto — ela segue em frente com
um dado a menos. Nos endpoints financeiros isso acontece em **duas camadas**: a função que grava
o lançamento retorna calada quando o valor é inválido, e quem a chama engole a exceção quando a
gravação falha.

**2. Configuração ausente libera em vez de bloquear.** O webhook do chatbot sem segredo aceita
qualquer requisição; o HMAC das evidências cai num segredo versionado no repositório; o filtro de
upload confia no tipo declarado pelo cliente. Em todos, o caminho seguro exigiria uma linha a mais.

**3. Fonte de verdade duplicada.** A taxonomia de veículos existe em quatro lugares, "dia útil" tem
duas definições, capacidade tem duas constantes, e a detecção de 401 tem dois métodos — um certo e
um errado, no mesmo repositório.

### O que está genuinamente bem feito

Não é um sistema mal escrito. É um sistema onde as bordas não receberam a mesma atenção que o
caminho feliz.

- **Fila de análise por IA** (`abastecimentoAutoService:976`) — guarda em processo, *claim* atômico
  via `UPDATE ... AND status = 'pending'` com checagem de `affectedRows`, contador de tentativas,
  estado de erro terminal. É o único componente que posso afirmar ser seguro com múltiplas
  instâncias.
- **`aiVisionService`** — ferramenta obrigatória (`tool_choice`), sem `JSON.parse` de texto livre do
  modelo; erros tratados por classe da API; não desperdiça a segunda chamada quando a credencial é
  inválida; degrada para conferência humana.
- **HMAC das evidências** — `timingSafeEqual`, TTL, versão na assinatura, subárvore privada barrada
  antes do `express.static`.
- **Modo degradado offline do `AuthContext`** — distingue erro HTTP de falha de rede, preserva o
  token, restrito a operador.
- **Refresh token opaco** com hash no banco e revogação.
- **Fronteira do `authMiddleware`** no `server.js` — limpa; as 7 rotas sem middleware próprio estão
  cobertas pelo global.

### Prioridade sugerida

| # | Achado | Segmento | Por quê |
|---|---|---|---|
| 1 | Webhook do chatbot falha aberto | Segurança | `WEBHOOK_SECRET` ausente hoje — aberto agora, não hipótese |
| 2 | Índice único em `daily_work_logs` | Integridade | Uma linha de DDL fecha a cadeia das 411 horas infladas |
| 3 | Razão de crédito engolindo erro | Dinheiro | Valor sumindo sem rastro, sem conferência |
| 4 | Feriados no aproveitamento | Relatórios | Uma linha, ~5% de erro nos números da direção |
| 5 | Autorização opt-in por URL | Segurança | Não é bug: é a ausência do lugar onde autorizar |

---

## Dano medido em produção

Números levantados direto na base, não estimativas.

| Métrica | Valor |
|---|---|
| Horas de apontamento infladas por duplicata estrita | **411,1 h** em 36 grupos / 50 lançamentos excedentes |
| Concentração | **345 h** numa única obra (Cerro Grande / SEDUR Bettio) |
| Caso extremo | RE824 em 13/01/2026: **63,8 h** num único dia, 10 lançamentos, 7 idênticos |
| Estadias de veículo sobrepostas | **179 pares** — mesma máquina em duas obras ao mesmo tempo |
| Estadias com saída anterior à entrada | **22** |
| Estadias com `veiculoId` nulo | **8** |
| Apontamentos sem operador | **624** de 22.649 |
| Obras com item de plano órfão `Trator de Esteiras` | **119** |
| Itens de plano com execução zero (obras ativas) | **75 de 220 — 34%** |
| Horas em chave fora do plano da própria obra | **17.108 de 64.893 — 26%** |
| Alocações / apontamentos com `planoItemKey` gravado | **0 de 2.856 / 0 de 22.649** |

---

# Parte I — Revisão do PR `feat/subgrupo-n-para-n`

17 achados. **16 corrigidos** nos commits `df88ede`, `3a2152f` (backend) e `7b1253b`, `22c8654`
(frontend). 1 recusado deliberadamente.

## Corrigidos — backend

| # | Arquivo | Defeito |
|---|---|---|
| 1 | `controllers/vehicleController.js:1043` | `bulkSetSubTipo` sem checagem de papel: qualquer token válido reclassificava os 562 veículos. Agora exige admin/editor, faz dedup dos ids e limita a 500 por vez |
| 2 | `controllers/obraController.js:243` | Trava que impede remover item do plano com máquina alocada rodava em `catch` que só logava. Agora falha fechada com 500 |
| 3 | `controllers/obraController.js:116` | `planoItemKey` (subgrupo) casado contra mapas de grupo → hora sumia do realizado ou era valorada a R$ 0. Resolvido com `chaveNoNivelDoMapa`, aplicado também em `dashboardController:47` e `analiseGerencialController:469` |
| 4 | `controllers/vehicleTaxonomyController.js:46` | Contagem de veículos por nome de tipo duplicava entre categorias |
| 5 | `controllers/vehicleTaxonomyController.js:136` | Path JSON por concatenação: nome com barra invertida derrubava a guarda contra órfãos. Trocado por `JSON_CONTAINS` sobre `JSON_KEYS` |
| 6 | `controllers/vehicleTaxonomyController.js:265` | `deleteType` apagava vínculos N:N por CASCADE sem avisar. Agora 409 com `exigeConfirmacao` |
| 7 | `controllers/vehicleController.js:1051` | `ids` sem teto e falha parcial silenciosa |
| 8 | `server.js:486` | Falha da migração N:N virava warn entre dezenas de linhas de sucesso |
| 9 | `controllers/vehicleTaxonomyController.js:287` | Erro de banco convertido em 422 com mensagem crua do driver |
| 10 | `controllers/vehicleTaxonomyController.js:366` | Resposta informava `grupos: []` quando na verdade preservava os vínculos |

## Corrigidos — frontend

| # | Arquivo | Defeito |
|---|---|---|
| 11 | `components/ObraAllocationModal.js:280` | Falha ao buscar o plano degradava para legado em silêncio: o seletor sumia e a alocação passava gravando `planoItemKey` nulo. Agora falha fechada, com bloco de erro e botão de retentar |
| 12 | `components/planejamento/PanoramaCapacidade.jsx:246` | `carteira`, `totais` e `params` sem default: payload parcial derrubava a aba inicial em tela branca |
| 14 | `components/admin/VehicleTaxonomyTab.js:103` | Subgrupo sem grupo sumia de todas as visões filtradas, continuando a ocupar o nome no índice único |
| 15 | `components/admin/VehicleTaxonomyTab.js:130` | Confirmação de excluir categoria omitia a perda dos vínculos de subgrupo |
| 16 | `components/modals/BulkSubTipoModal.js:65` | Lote incluía sucata e inativos |
| 17 | `components/modals/BulkSubTipoModal.js:100` | Sucesso parcial reportado como total |

## Recusado deliberadamente

**13. `pages/PlanejamentoPage.js:456` — Panorama como aba inicial.**
Sinalizado pelo custo da consulta no caminho crítico de toda visita (varre `daily_work_logs`
agregado, frota inteira, todas as obras não finalizadas e contratos vigentes). **Não alterado:** é
decisão de produto documentada em `docs/panorama-capacidade-plano.md` ("como primeira aba"). Fica
como ponto de atenção, não como defeito.

---

# Parte II — Auditoria geral

36 achados, todos abertos.

## Segmento 1 — Segurança e autenticação

### 1.1 Webhook público do chatbot falha aberto — `controllers/chatbotController.js:9`

```js
if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) { ... }
```

A verificação inteira é pulada quando a variável não está definida — e **`WEBHOOK_SECRET` está
ausente no `.env` conferido**. `POST /api/whatsapp/webhook` é montado antes do `authMiddleware` de
propósito, então qualquer um na internet pode postar `{from, body}` arbitrários. O handler responde
200 e chama `chatbotService.processarMensagem`, que consome a `ANTHROPIC_API_KEY` e age em nome do
número informado em `from`, inclusive sobre solicitações de abastecimento.

**Correção:** recusar quando o segredo não está configurado.

### 1.2 Cadastro público aceita `role` e `user_type` do corpo — `controllers/authController.js:123`

`POST /api/auth/register` é público e grava `role` e `user_type` vindos de `req.body`. A escalação
não se completa hoje porque `status` é forçado a `'inativo'` e `approveRegistrationRequest`
sobrescreve o papel — mas **a defesa está no fluxo seguinte, não no endpoint**. Qualquer caminho que
ative a conta sem passar por aquele UPDATE entrega admin. São 240 contas nesse fluxo.

### 1.3 Upload valida só o mimetype declarado — `server.js:2304`

`fileFilterGlobal` confia em `file.mimetype`, que vem do `Content-Type` do cliente. Os arquivos são
servidos por `express.static` em `/uploads` (`server.js:2431`). Um HTML ou SVG com script declarado
como `image/png` é gravado e servido — XSS armazenado na origem da API, onde o token do frontend
está no `localStorage`. O nome é sanitizado, mas a extensão original é preservada.

### 1.4 Autorização é opt-in por substring de URL — `middlewares/authMiddleware.js:98`

```js
if (req.originalUrl && req.originalUrl.includes('/supervisor')) { ... }
```

É o **único** controle de papel global. Todo o resto da API trata autenticado como autorizado, salvo
checagem manual em 6 dos 51 arquivos de rotas. Foi exatamente assim que `PATCH /vehicles/bulk-sub-tipo`
entrou sem gate. A comparação ainda casa por substring na URL inteira, query string incluída.

**Não é um bug: é a ausência de um lugar onde autorização aconteça.** Enquanto for assim, cada
endpoint novo é uma chance de repetir o mesmo erro.

### 1.5 Login sem limite de tentativas — `routes/authRoutes.js:9`

`express-rate-limit` está no `package.json` e **não é usado em lugar nenhum** do código. A única
ocorrência de `rateLimit` no repositório é um controle por telefone dentro do `chatbotService`.

### 1.6 Segredo de fallback versionado — `utils/evidenciaRegras.js:102`

```js
const _segredo = () => process.env.JWT_SECRET || 'dev-secret-evidencias';
```

Sem `JWT_SECRET`, o HMAC das URLs públicas de evidência usa uma chave que está no repositório —
permitindo forjar assinaturas para qualquer id, variante e expiração, inclusive a variante `clean`
(sem carimbo). O login recusa subir sem `JWT_SECRET`, mas a rota pública de evidências não depende
de login.

### 1.7 Enumeração de contas no login — `controllers/authController.js:78`

Usuário inexistente → `'Credenciais inválidas ou usuário não encontrado.'`
Senha errada → `'Credenciais inválidas.'`
Conta pendente → 403 `'Cadastro pendente de aprovação'`

Três sinais distintos. Combinado com 1.5, reduz a força bruta a um alvo conhecido.

### 1.8 Gate de admin compara `user_type` cru — `routes/adminRoutes.js:16`

`req.user.user_type !== 'admin'` usa o valor bruto, enquanto o `authMiddleware` normaliza `role`
para minúsculas e repassa `user_type` sem tratar. **Latente:** as 240 contas da base têm `role`
igual a `user_type`, tudo em minúsculas. O que mantém o risco vivo é que `register` deixa o
solicitante escolher `user_type` livremente.

### 1.9 Erro de banco reportado como token inválido — `middlewares/authMiddleware.js:116`

O `catch` cobre também `fetchUserRow`. Pool saturado ou MySQL indisponível → todos os usuários
recebem 403 "Token inválido" ao mesmo tempo. Quem diagnostica vai atrás de JWT e relógio do
servidor. O 403 também não dispara a renovação silenciosa do frontend, que só reage a 401.

---

## Segmento 2 — Dinheiro

### 2.1 Falha no razão de crédito é engolida e a ordem comita — `controllers/refuelingController.js:795`

Os três pontos que movimentam o saldo pré-pago do posto — criar ordem (795), liberar ordem bloqueada
(1382) e dar baixa (1217) — estão em `try/catch` que só fazem `console.warn`, com o
`connection.commit()` logo depois. A ordem existe, o combustível sai do posto, o lançamento nunca
entra em `partner_fuel_credit_entries`.

Como tudo está na mesma transação, **bastaria deixar o erro subir** para o rollback desfazer a ordem
junto.

### 2.2 Release falhando pula o settle — `controllers/refuelingController.js:1201`

`releaseOrderReservation` e `settleOrder` estão no mesmo `try`. Se a primeira lança, a segunda nem é
chamada: empenho preso no extrato e baixa definitiva nunca lançada. As duas metades de uma mesma
operação contábil dependem de a primeira não falhar.

### 2.3 Ordem sem preço sai sem empenho — `utils/partnerFuelCredits.js:143`

`getLastPriceForPartner` devolve 0 quando o posto não tem abastecimento concluído anterior naquele
combustível nem preço em `partner_fuel_prices` — situação de posto recém-cadastrado. O valor do
empenho dá 0, `applyOrderReservation` retorna no `if (amount <= 0)`, e a ordem é liberada sem
nenhuma reserva. O saldo permanece integralmente disponível enquanto a ordem está na rua.

### 2.4 Nenhuma checagem de saldo antes de empenhar — `controllers/refuelingController.js:783`

Não existe verificação de `available >= amount`, nem bloqueio da linha do parceiro, nem
serialização. Duas ordens simultâneas de R$ 4.000 contra um saldo de R$ 5.000 passam as duas, e
`available` vai a −3.000. O sistema só mostra o negativo depois do fato.

> Este pode ser decisão de produto — talvez vocês *queiram* deixar a ordem sair e tratar depois.
> Mas então a tela deveria dizer isso, não descobrir por acidente.

### 2.5 `insertEntry` descarta lançamento inválido sem avisar — `utils/partnerFuelCredits.js:22`

```js
if (!partnerId || !entryType) return;
if (!Number.isFinite(numAmount)) return;
```

Um `amount` NaN não gera erro nem log. O chamador acredita que lançou, o commit acontece, o valor
desaparece do extrato. **Somado a 2.1, são duas camadas de silêncio sobre a mesma operação
financeira.**

### 2.6 `getConnection`/`beginTransaction` fora do `try` — `controllers/orderController.js:226`

Em **17 dos 18** pontos que abrem transação nos controllers de dinheiro e frota, as duas chamadas
ficam antes do `try`, então o `finally { release() }` não cobre uma falha ali. Conexão presa no pool
permanentemente; o pool tem 25. Afeta `refuelingController` (5), `comboioTransactionController` (5),
`vehicleController` (5) e `orderController` (3). O único correto é `vehicleController:240`.

### 2.7 O razão não tem conferência

Não existe nada que compare `SUM(entries)` com o que as ordens dizem, nem alerta de saldo negativo,
nem fechamento. Um lançamento perdido em março só apareceria quando alguém estranhasse o saldo — e
aí não haveria como saber qual ordem faltou.

> **O que está certo:** modelar o extrato como lançamentos imutáveis com `entry_type`, em vez de um
> campo `saldo` mutável. É o que torna a auditoria possível quando for feita.

---

## Segmento 3 — Integridade e transações

### 3.1 Apontamento duplicado: 411 horas infladas — `controllers/billingController.js:157`

A proteção contra duplicidade é um `SELECT ... LIMIT 1` (linha 157) seguido de `INSERT` (linha 202),
**sem transação e sem índice único na tabela**. Conferi os índices de `daily_work_logs`: não há
`UNIQUE (vehicleId, obraId, date)`.

Medido: 36 grupos com veículo, obra, dia, `totalHours` e os quatro horários **idênticos**, somando 50
lançamentos excedentes e **411,1 horas**. A obra Cerro Grande (SEDUR) Bettio concentra 345 delas.

O caso extremo — RE824 em 13/01/2026:

| # | Horas | Manhã | Tarde |
|---|---|---|---|
| 1 | 9,00 | 07:30–11:45 | 13:15–18:00 |
| 2 | 0,00 | — | — |
| 3 | 9,25 | 07:30–11:45 | 13:00–18:00 |
| 4 | 9,25 | 07:30–11:45 | 13:00–18:00 |
| 5 | 9,00 | 07:30–11:45 | 13:15–18:00 |
| 6 | 0,00 | 00:00–00:00 | 00:00–00:00 |
| 7 | 9,00 | 07:30–11:45 | 13:15–18:00 |
| 8 | 9,25 | 07:30–11:45 | 13:00–18:00 |
| 9 | 0,00 | 00:00–00:00 | 00:00–00:00 |
| 10 | 9,00 | 07:30–11:45 | 13:15–18:00 |

**63,8 h numa máquina em 24 h.** Nenhum dos 10 tem operador registrado.

### 3.2 Alocação não verifica nem fecha estadia anterior — `controllers/vehicleController.js:310`

`allocateToObra` insere estadia com `dataSaida: null` sem consultar se o veículo já tem outra em
aberto. O fechamento só existe em `deallocateFromObra` e `registrarEstadiaRetroativa` (linhas 666,
700, 744).

Medido: **179 pares sobrepostos.** Exemplos reais:

- **RE712** — Uruguaiana 2 de 23/08 a 24/09 **e** Barra do Quaraí de 24/08 a 11/09
- **RE821** — estadia **aberta** em Chiapetta desde 18/08 **e** Barra do Guarita até 25/08

Toda leitura que assume uma estadia por veículo conta a máquina duas vezes no período sobreposto.

### 3.3 Estadia aceita saída antes da entrada e data futura — `controllers/vehicleController.js:504`

22 estadias com `dataSaida < dataEntrada` e 1 com `dataEntrada` em 10/07/2027 — provável erro de
digitação de ano que nada barrou. Nenhum caminho compara as duas datas.

### 3.4 `upsertDailyLog` grava fora de transação — `controllers/billingController.js:146`

O INSERT/UPDATE do apontamento e a reconciliação da obra (`syncObraFromLogs`, que **ativa a obra** e
grava `dataInicio`) rodam em chamadas separadas no pool.

### 3.5 Reconciliação da obra falha em silêncio — `controllers/billingController.js:142`

`syncObraFromLogs` termina em `catch { console.warn }`. A obra pode ficar em "planejada" com horas
lançadas, e o único registro é um warn. Não há nova tentativa nem fila.

### 3.6 `veiculoId` aceita NULL na estadia — `controllers/vehicleController.js:396`

8 estadias com `veiculoId` nulo. **A FK existe e dá falsa sensação de integridade:**
`foreign_key_checks` está ligado, mas FK não barra nulo. A coluna deveria ser `NOT NULL`.

### 3.7 Apontamento gravado sem operador — `controllers/billingController.js:199`

624 dos 22.649. Nos 10 duplicados da RE824, **todos**. Sem operador não dá para distinguir turno
legítimo de duplicata — o critério que permitiria limpar os dados depois não existe.

> **A raiz é uma só:** o banco não protege nada; o código tenta, e falha nas bordas. Não há `UNIQUE`,
> não há `NOT NULL` onde deveria, não há constraint de ordem entre datas, nada impede duas estadias
> abertas. Todas as regras vivem em JavaScript, sem transação — e cada `check-then-act` é uma corrida
> esperando acontecer.

---

## Segmento 4 — Serviços assíncronos

### 4.1 Trava da rotina diária vive em memória — `services/cronService.js:129`

`getLastDailyRunDate()` devolve `_lastDailyRunDate`, cache local do processo. A linha em
`system_settings` é escrita mas **nunca lida na decisão**.

- **Restart:** se `initCronState` falhar, o catch só registra warn, o valor fica nulo e a rotina
  diária inteira roda de novo — RH, WhatsApp de manutenção e férias disparados em duplicidade.
- **Duas instâncias:** cada processo tem o seu, os dois executam. O `INSERT ... ON DUPLICATE KEY
  UPDATE` não é lock: é último-escreve-vence.

Como a rotina envia mensagem para pessoas, a duplicidade é visível fora do sistema.

### 4.2 Quarta cópia hardcoded da taxonomia — `services/chatbotService.js:51`

`TIPOS_HORIMETRO` é lista fixa de 20 nomes usada para decidir se o operador informa horímetro ou
odômetro. Grupo novo criado na tela de administração não entra: o chatbot pergunta a leitura errada,
e a validação de salto passa a comparar grandezas diferentes (1000 km vs 50 h).

As outras três cópias — `frontend/src/utils/vehicleRules.js`, o mesmo arquivo no backend, e o banco —
ao menos são hidratadas do banco no boot. Esta não.

### 4.3 `unhandledRejection` só registra log — `server.js:2786`

Instalar esse handler desliga o comportamento padrão do Node de encerrar. `uncaughtException`, logo
abaixo, faz `exit(1)` — tratamentos opostos para falhas igualmente graves. Uma transação que rejeitou
fora de `try` deixa o processo rodando com conexão presa e transação aberta. As dezenas de IIFEs de
migração no boot são exatamente esse formato.

### 4.4 Aviso de timeout do chatbot repete após restart — `services/cronService.js:112`

`chatbotTimeoutWarningsSent` é `Set` em memória — o comentário registra que foi feito assim para
evitar mudança de schema. Reiniciar esvazia, e todas as sessões abertas recebem o aviso de novo.

### 4.5 Limite de mensagens e trava de concorrência por processo — `services/chatbotService.js:23`

`rateLimitMap` e `processingPhones` são estruturas em memória. Com duas instâncias, o mesmo número
envia 20 mensagens/min e pode ter duas mensagens processadas ao mesmo tempo — e o fluxo monta uma
solicitação de abastecimento passo a passo.

> **Pergunta em aberto que muda a gravidade de 4.1, 4.4 e 4.5:** o Easypanel roda uma instância do
> backend ou mais?

---

## Segmento 5 — Relatórios e agregações

### 5.1 Aproveitamento ignora os 13 feriados cadastrados — `controllers/obraSupervisorController.js:595`

```js
const _isBusinessDay = (dateStr) => { const wd = new Date(...).getDay(); return wd !== 0 && wd !== 6; };
```

Só exclui sábado e domingo. Existem **13 feriados em `admin_holidays`**, e o Panorama os desconta
via `utils/businessDays.loadHolidaySet`. O Aproveitamento Produtivo conta esses dias como úteis no
**denominador**, inflando a capacidade esperada em ~5% ao ano — concentrado nos meses com feriado
(uma obra medida só em novembro pode perder 2 dias em ~20, 10%).

**As duas telas dão números diferentes para o mesmo período e ninguém sabe qual está certo.**

### 5.2 Comentário afirma que não há tabela de feriados — `controllers/obraSupervisorController.js:631`

A docstring registra como limitação conhecida que "Feriados não são removidos (não há tabela de
feriados)". A tabela existe, tem 13 registros e o helper `utils/businessDays.js` já encapsula a
leitura. O comentário transforma uma correção de uma linha numa tarefa aparentemente grande.

### 5.3 Denominador usa a frota de hoje sobre período passado — `controllers/obraSupervisorController.js:686`

`capDiariaLiquida` parte de `qtdVeiculos`, a contagem de máquinas alocadas **agora**, multiplicada
pelos dias úteis de um período que pode ser inteiramente passado.

O comentário reconhece que passar de 100% é esperado, mas **não menciona o caso inverso** — que é o
que penaliza gente: 10 máquinas chegaram ontem numa obra que teve 2 durante o mês, e o supervisor
aparece com aproveitamento péssimo por capacidade que nunca existiu.

O dado para fazer certo existe: `obras_historico_veiculos` tem `dataEntrada` e `dataSaida`.

### 5.4 Duas constantes de capacidade na mesma tela — `controllers/planejamentoController.js:13`

| Aba | Constante | Para 45 dias |
|---|---|---|
| Balanço | `HORAS_MES_MAQUINA: 175` | 262,5 h/máquina |
| Panorama | `HORAS_POR_DIA: 8` × dias úteis | ~256 h/máquina |

A escolha está documentada em `docs/panorama-capacidade-plano.md` ("Não usar os 175 h/mês"), então é
deliberada. O resultado é que a aplicação responde à mesma pergunta de dois jeitos, e qual régua vale
ficou implícito na aba que o usuário abriu.

---

## Segmento 6 — Estado do frontend

### 6.1 Detecção de 401 por substring na mensagem — `contexts/DataContext.js:291`

```js
if (err?.message && err.message.includes('401')) { logout?.(); }
```

O `apiClient` monta a mensagem como `errorData.message || errorData.error || 'Erro <status>: ...'` e
**já preenche `err.status`** (linha 94). Um 401 real do `authMiddleware` chega como
`{error: 'Token expirado.'}` — sem "401" — então o logout global **nunca dispara** e o usuário fica
preso numa tela que não carrega. O falso positivo também existe: qualquer mensagem de negócio
contendo "401" desloga no meio do trabalho.

`AuthContext.js:125` resolve o mesmo problema com `error?.status === 401`, **com comentário
explicando o discriminador**. As duas metades do mesmo sistema tratam o mesmo erro de formas opostas.

### 6.2 Origem do item de plano órfão `Trator de Esteiras` — `utils/vehicleRules.js:103`

```js
// Removido "Trator de Esteiras" duplicado/incorreto, mantido apenas o que bate
// com o grupo: "Trator Esteira"
```

Quando a lista hardcoded era a fonte do select, o nome errado era oferecido e gravado. Ao corrigir a
lista, **ninguém migrou os dados já gravados**: 119 obras ficaram com uma chave de plano que nenhuma
máquina consegue casar — execução zero para sempre, contra 25 obras com o nome correto.

É o custo de manter taxonomia em lista hardcoded: corrigir o código não corrige o passado.

---

## Segmento 7 — Telas de escrita

### 7.1 Erro ao salvar não recarrega e a retentativa duplica — `pages/BillingPage.js:814`

**Este é o mecanismo por trás das 411 horas duplicadas.**

`fetchDailyLogsForControl()` só é chamado no caminho de sucesso. No `catch`, o estado local fica
velho, `existingLog` continua indefinido, e a próxima tentativa reenvia tudo com `id: null` — caindo
no caminho de INSERT do servidor, cuja proteção é o `SELECT` sem transação (3.1).

Cada nova tentativa é outra chance de duplicar. Os 7 lançamentos idênticos da RE824 são exatamente
o padrão de várias retentativas.

### 7.2 `Promise.all` reporta falha parcial como total — `pages/BillingPage.js:811`

`Promise.all` rejeita na primeira falha, mas as demais requisições já foram disparadas e continuam.
O usuário altera 10 dias, a terceira falha, as outras nove gravam, a tela mostra erro — e ele salva
de novo, reenviando os nove com `id: null`. `Promise.allSettled` diria quais falharam de fato.

### 7.3 Operador vazio quando não há alocação correspondente — `pages/BillingPage.js:521`

`getDefaultOperator` busca a estadia do veículo em `obra.historicoVeiculos`; sem estadia
correspondente devolve `''`. O backend converte para NULL e grava. **Explica os 624 apontamentos sem
operador** — e, como há 179 estadias sobrepostas e 8 com `veiculoId` nulo, os casos em que a busca
falha não são raros.

---

# A cadeia que atravessa três segmentos

As 411 horas infladas não são um bug. São **três defeitos em série**, e qualquer um dos três
resolveria sozinho:

1. **7.1** — a tela não recarrega no erro, então a retentativa reenvia como INSERT
2. **3.1** — o servidor protege duplicata com `check-then-act` sem transação
3. **3.1** — o banco não tem índice único em `(vehicleId, obraId, date)`

E **3.7 / 7.3** (operador vazio) destroem o critério que permitiria limpar os dados depois.

---

# Correções que dependem de decisão sua

| Achado | Decisão necessária |
|---|---|
| 2.4 — saldo não cobre o empenho | Bloquear a ordem, ou deixar sair avisando na tela? |
| 2.3 — posto sem preço | Recusar a ordem, ou empenhar zero e sinalizar? |
| 3.1 — índice único | Exige limpar os 36 grupos antes. São 50 lançamentos e 345 horas saindo do progresso de uma obra possivelmente já reportada ao cliente |
| 5.3 — denominador do aproveitamento | Trocar snapshot por presença real muda números históricos já divulgados |
| 5.4 — duas constantes | Qual régua vale para a empresa? |
| 6.2 — 119 obras órfãs | Consolidar `Trator de Esteiras` → `Trator Esteira` altera plano de obras antigas |

---

**Metodologia.** Todos os achados marcados como medidos foram verificados por consulta direta à base
de produção, somente leitura, em 11/09/2026. Hipóteses que não se confirmaram foram descartadas e não
constam aqui — por exemplo, suspeita de erro de fuso em `updateMonthlyExpense` (o `Dockerfile` define
`TZ=America/Sao_Paulo` e o pool usa `-03:00`, batem) e suspeita de divergência entre as cópias de
`vehicleRules.js` no frontend e backend (o conteúdo é idêntico; a diferença era só formatação).
