# Implantação — Evidências de Campo

**Fotos georreferenciadas dos equipamentos · web-first · offline-first**

> **Status:** aguardando liberação. Este é o guia passo a passo para executar a implantação
> quando ela for autorizada. Nenhum código do módulo foi escrito — `backend/` e `frontend/`
> seguem intactos.
>
> _Revisão 2 (2026-09-06). Substitui integralmente a revisão 1, que continha um erro de tipo de
> coluna capaz de quebrar toda junção do banco, além de três decisões de arquitetura hoje
> invalidadas. Ver §14._

---

## 0. Objetivo e decisões travadas

**Hoje:** as equipes mandam por grupos de WhatsApp as fotos georreferenciadas dos equipamentos
trabalhando e a comprovação de horímetro de início e fim de expediente. No pico são **~800
fotos/dia** (equipamentos trabalhando × 4 fotos). O material não fica consultável, pesa o
WhatsApp, exige cobrança manual diária e não vira comprovação organizada para cobrar o cliente.

**Objetivo:** trazer isso para dentro do Frotas MAK, com as georreferências carimbadas na imagem,
arquivo pesquisável, cobrança automática e dossiê de comprovação para faturamento.

### Decisões fechadas — não reabrir sem alinhar

| Tema | Decisão |
|---|---|
| **Plataforma** | **Web primeiro** — captura pelo navegador do celular em frotamak.com, como já é feito com solicitação de abastecimento. App nativo **adiado**, não cancelado (§12, fase 10) |
| **Onde vive** | Dentro da **página do operador**, que hoje já faz abastecimento e comboio e ganha mais essa função |
| **Offline** | **Pré-requisito, não recurso.** É a fundação (§3) — sem ela a página não funciona em campo |
| **Capturas/dia por equipamento** | 4: **horímetro início** · **foto trabalhando manhã** · **foto trabalhando tarde** · **horímetro fim** |
| **Equipamentos no escopo** | Só **Caminhões** e **Máquinas Pesadas**. Fora: Veículos Leves e Caminhões de Trecho (§2) |
| **Coordenada** | **Obrigatória.** Sem coordenada a captura é **bloqueada**. Nunca gravar `0,0` falso. Só o *nome* do lugar pode faltar |
| **Carimbo** | **Nunca queimado no upload.** Original intacto + metadado editável, renderizado sob demanda (§5) |
| **Quem edita o carimbo** | **Admin + gerência**, com **motivo obrigatório** ao remover ou alterar data/GPS |
| **Vestígio de edição** | **Proibido na imagem.** A foto renderizada é idêntica tenha sido editada ou não. Auditoria só no banco e na tela administrativa |
| **Campos do carimbo** | Configuráveis em 3 níveis: global, por obra, por equipamento (§5.3) |
| **Dispensa ("anular")** | Operador justifica inatividade de dia ou turno, para 1, várias ou todas as máquinas da obra (§8) |
| **Arquivamento** | **Manual, com confirmação humana.** Nada é apagado por mudança de status de obra (§11) |
| **Download** | Sempre em **duas versões**: com e sem geolocalização |
| **Destino do offload** | Máquina de **TI / Desenvolvimento** |
| **Permanência no servidor** | ≈ **2 meses** (duração média da obra). 50 GB disponíveis |
| **Corte do WhatsApp** | 90% de aderência por 5 dias úteis seguidos — **proposta**, parametrizável em `system_settings` |

---

## 1. O que já existe — reusar, não reescrever

Antes de criar qualquer coisa, este módulo se apoia em infraestrutura pronta. Ignorar esta tabela
é a forma mais rápida de duplicar código que já funciona.

| Necessidade | Já existe em | Observação |
|---|---|---|
| **Captura de 4 fotos** | `frontend/src/components/modals/ComboioDistribuicaoModal.js:40-84` — componente `PhotoCapture` com câmera + galeria | **Já captura exatamente 4 fotos.** Extrair para `components/PhotoCapture.js` |
| Compressão client-side | mesmo arquivo, `:11-37` `compressImage` (canvas, 1280 px, JPEG q0.7) | Falta `onerror` — ver §3.7 |
| Câmera no navegador | `SolicitacaoAbastecimentoPage.js:1069` `<input capture="environment">` | Já funciona no web responsivo |
| Geolocalização | `SolicitacaoAbastecimentoPage.js:550-570` `getLocation()` | Reusar, mas **sem** o fallback para `'0'` |
| **Município offline** | `frontend/src/utils/geo.js:106` `cidadeDoPonto(lat,lng,geojson)` — point-in-polygon | Resolve o nome do lugar **sem internet** |
| **Fila offline** | `frontend/src/components/chat/Messenger.js:157-186` — outbox com `clientMsgId` | Único outbox que funciona hoje. É a forma a copiar |
| Escopo do operador | `backend/controllers/vehicleDocumentsController.js:43-75` | A junção "usuário → employeeId → obras ativas → veículos" já existe |
| **Grupos de veículo** | `backend/utils/vehicleRules.js` `getAllowedReadingTypes()` | Define o escopo do módulo (§2) |
| Upload multer | `backend/controllers/solicitacaoAppController.js:14-19` | Padrão de `diskStorage` |
| Path traversal | `backend/services/aiVisionService.js:71-79` `resolverCaminho()` | **Único** resolvedor com guarda. Copiar |
| Tarefas agendadas | `backend/services/cronService.js:117-129` | Padrão seguro quanto a fuso (§9) |
| Trava idempotente | `backend/services/cronService.js:68-104` — KV `system_settings` | Base do `claimSlot()` |
| Notificações | `backend/services/notificationDispatcher.js` + `whatsappService` / `emailService` / `pushService` | `notification_log` já tem coluna `obra_id` |
| Permissões por página | `backend/utils/permissions.js` `requireAnyPage` / `canUserAccessPage` | Padrão do par app/gestor em `routes/solicitacaoRoutes.js:29-35` |
| Ficha da Obra | `frontend/src/pages/FichaObraPage.js` — já tem abas | Recebe a aba Evidências (§10.3) |
| Tempo real | `req.io.emit('server:sync', { targets: [...] })` | Invalida cache no `DataContext` |
| Tema | `frontend/src/index.css` — Terroso Mineral (`--brand-amber #9E7A42`, `--sidebar-bg #1c1a17`, `--app-bg #f5f3ef`) | Não introduzir cor nova |

**Dependências novas:** `sharp` (render do carimbo) e `archiver` (ZIP do offload, JS puro).
`multer`, `node-cron` e `pdfkit` já existem.

---

## 2. Escopo — quais equipamentos exigem foto

Só os grupos **`Caminhões`** e **`Máquinas Pesadas`**. Ficam de fora **`Veículos Leves`** e
**`Caminhões de Trecho`**.

Isso coincide **exatamente** com os grupos que usam horímetro, e a regra já está codificada:

```js
const { getAllowedReadingTypes } = require('../utils/vehicleRules');
const exigeEvidencia = (tipo) => getAllowedReadingTypes(tipo).includes('horimetro');
```

Reusar a função em vez de escrever uma lista nova de tipos — uma lista paralela sairia do
sincronismo na primeira vez que alguém cadastrar um tipo de veículo, e o módulo passaria a
cobrar (ou deixar de cobrar) o equipamento errado em silêncio.

Faz sentido conceitual: são exatamente os equipamentos cuja comprovação **é** a leitura do
horímetro.

---

## 3. Fundação offline — a parte que decide o sucesso

A página do operador hoje **não funciona offline e mente sobre isso**:
`SolicitacaoAbastecimentoPage.js:160` mantém um estado `isOffline` e renderiza o banner
*"Offline: Salvo localmente"* — mas **nada é salvo**. O envio estoura no `catch` e a foto é
perdida. Corrigir isso é pré-requisito, e beneficia abastecimento e comboio antes da primeira
evidência existir.

### 3.1 Sessão que sobrevive à falta de sinal — **o bloqueador nº 1**

`frontend/src/contexts/AuthContext.js:71-90` chama `apiClient.getMe()` no boot e, em **qualquer**
falha — inclusive `TypeError: Failed to fetch` por falta de sinal — executa
`localStorage.removeItem('authToken')` e desloga. Abrir o app no mato sem sinal hoje já destrói a
sessão.

O discriminador necessário **já existe**: `apiClient.js:82-89` só anexa `.status` em erro HTTP;
falha de rede propaga um `TypeError` sem `.status`.

```js
// ao ter sucesso no getMe:
localStorage.setItem('authUserSnapshot', JSON.stringify({ user: userData, savedAt: Date.now() }));

// no catch do checkAuth:
const isAuthError = error?.status === 401 || error?.status === 403;
if (isAuthError) {
    // comportamento atual, inalterado: token inválido, desloga
} else {
    const snap = lerSnapshot();
    if (snap && Date.now() - snap.savedAt < SETE_DIAS) {
        setUserAndPermissions(snap.user);
        setDegraded(true);      // exposto no contexto
    } else { /* desloga */ }
}
```

Detalhes que importam:
- **Validade de 7 dias.** Cobre uma viagem de campo real; além disso força login novamente, para
  que um usuário revogado não fique com casca funcional para sempre.
- **Expor `degraded`** no valor do contexto e mostrar barra fixa *"Modo offline — dados de
  <data>"*. Sessão degradada nunca pode parecer normal.
- **`logout()` não pode limpar a fila de fotos.** São o trabalho do operador; perdê-las num
  logout acidental é inaceitável. A fila é indexada por `userId` e apenas fica invisível.
- **`forceLogout()` (`apiClient.js:14-18`) vira no-op quando `navigator.onLine === false`**, e a
  fila trata 401 como "pausa e tenta depois", não como "descarta".
- **Na fase 1, limitar o caminho degradado a `user_type === 'operador'`.** Telas de gestor chamam
  dezenas de endpoints e degradariam de forma imprevisível.

### 3.2 Service worker

Não existe nenhum hoje: `src/index.js` não registra nada e o CRA 5 só liga o Workbox se
`src/service-worker.js` existir. Criar `src/service-worker.js` + `src/serviceWorkerRegistration.js`
e registrar no `index.js`.

- **Precache** do build: JS/CSS, `index.html`, fontes, `favicon.png` — **e o chunk lazy do
  operador**, senão o reload offline cai num spinner eterno. Incluir também
  `public/data/rs-municipios.geojson`, necessário ao município offline.
- **NavigationRoute** → `index.html` do precache (espelha o `try_files` do nginx).
- **NetworkFirst** (3 s, 24 h) para `GET /api/evidencias/meu-escopo`.
- **CacheFirst** (300 entradas, 30 d) para `/api/public/evidencias/**`.
- **Nunca cachear** `/api/auth/**` nem qualquer não-GET. Login cacheado é falha de segurança.
- **`skipWaiting` só por mensagem**, nunca automático: trocar o bundle sob um formulário de
  captura pela metade perde a foto. Mostrar aviso *"Nova versão — atualizar"*.
- Google Fonts (`public/index.html:16-17`) é requisição externa que falha offline e pode travar o
  primeiro paint. **Auto-hospedar o Roboto** — resolve o offline e tira um terceiro do caminho de
  um app de campo em 2G.

### 3.3 nginx — exceções obrigatórias

`frontend/nginx.conf:85-88` fixa `\.(css|js|…|json)$` por **1 ano**. Esse regex congelaria
`service-worker.js` e `manifest.json` para sempre em todo celular que carregasse uma vez. Em
nginx o `location =` (exato) vence o `location ~*` (regex), então basta acrescentar:

```nginx
location = /service-worker.js { add_header Cache-Control "no-cache, no-store, must-revalidate"; expires off; }
location = /manifest.json     { add_header Cache-Control "no-cache"; expires off; }
location = /index.html        { add_header Cache-Control "no-cache"; expires off; }
```

`index.html` entra porque, com um SW ativo, um `index.html` velho apontando para chunks que não
existem mais é *hard-brick*. **Estas três exceções vão no mesmo commit do service worker, nunca
depois.**

### 3.4 Manifest e instalação

Criar `frontend/public/manifest.json` (`display: standalone`, `start_url: "/"`,
`theme_color: "#1c1a17"`, `background_color: "#f5f3ef"` — tokens do próprio tema) com ícones 192
e 512 px, e devolver as tags que `public/index.html:10-12` removeu — **criando os arquivos desta
vez**, já que foram retiradas por darem 404.

Instalar na tela de início não é só polimento: no iOS, um PWA instalado tem postura de retenção
de storage bem melhor que uma aba do Safari (§3.9).

### 3.5 Pacote de escopo

`GET /api/evidencias/meu-escopo` devolve num único JSON (~5–40 KB) tudo que a tela precisa:
obras do operador, equipamentos **no escopo do §2**, config de janelas e exigências, e o que já
foi enviado hoje. No servidor é a junção de `vehicleDocumentsController.js:43-75` trocando a
parte de documentos, com o mesmo escopo `obras_historico_veiculos … dataSaida IS NULL`.

Gravado em IndexedDB a cada sucesso; lido de lá sempre que a rede falhar. Atualiza na montagem,
no evento `online` e a cada 30 min em primeiro plano. O campo `hojeEnviado` é o que permite
mostrar "2 de 4 hoje" sem rede.

### 3.6 Fila em IndexedDB

Primeiro uso de IndexedDB no projeto — necessário porque fotos são `Blob` e não cabem em
`localStorage`, o único mecanismo usado hoje. Um banco `mak_evidencias` com três stores
(`fila`, `escopo`, `meta`), em `frontend/src/services/evidenciaDb.js`. **Não** adicionar `idb`
nem `dexie`: a API crua resolve três stores e o bundle já é grande.

Campo decisivo: **`clientId`** (`crypto.randomUUID()` gerado na captura, nunca regenerado). No
servidor, `evidencia_registro.client_id UNIQUE` transforma entrega "pelo menos uma vez" em
"exatamente uma vez" — sem isso, uma rede instável duplica upload e a aderência vira lixo.

### 3.7 Algoritmo de envio

Modelado em `Messenger.js:157-186`, com quatro endurecimentos porque foto é mais pesada e mais
valiosa que mensagem de chat:

1. **`break` na primeira falha transitória** — preserva ordem cronológica e não martela uma
   conexão agonizante com 12 uploads multipart.
2. **Backoff** `min(60s × 2^(n-1), 30min)` **com jitter de ±20%**. Sem jitter, 200 operadores
   recuperando sinal quando a torre volta sincronizam numa avalanche.
3. **Separação dura entre permanente e transitório.** 400/403/422 → para de tentar e vira item
   visível e descartável na página da fila. 5xx/rede → backoff. Um item envenenado tentando para
   sempre é a falha clássica de outbox, e queima bateria em silêncio.
4. **Um upload por vez**, nunca paralelo: 1,5 MB em 2G já leva ~30 s.

Gatilhos: montagem, evento `online`, `visibilitychange → visible`, após cada captura, e timer de
60 s em primeiro plano.

> **Acoplamento sutil, fácil de errar:** a mensagem de recusa do `fileFilter` do multer **precisa
> conter a palavra "arquivo"**, porque `server.js:2156-2181` só converte para 400 quando
> `err.message.includes('arquivo')`. Sem isso vem 500, e o classificador acima trata um arquivo
> permanentemente inválido como erro transitório — tentando para sempre.

**Background Sync fica fora do caminho crítico.** Só existe em Chromium; o iOS nunca teve.
Registrar dentro de `try/catch` como bônus, mas desenhar a UX para a ausência dele: dizer ao
operador *"mantenha o app aberto até terminar o envio"* e mostrar progresso ao vivo, para que a
instrução seja seguível em vez de misteriosa.

### 3.8 Página da fila

`EvidenciasFilaPage` — cabeçalho com online/offline, "N fotos aguardando", MB totais e última
sincronização. Por item: miniatura do `Blob`, equipamento, tipo, hora e chip de estado
(`⏳ na fila` / `⬆ enviando` / `⚠ erro (3 tentativas)` / `✕ recusado: obra finalizada`), botão
manual "Enviar agora" (operador não confia em coisa automática que não vê) e "Descartar" com
confirmação. Barra de armazenamento quando `navigator.storage.estimate()` passar de 70%.

**Badge de pendências visível em todas as abas** — quem trocou para abastecimento precisa
continuar sabendo que há 4 fotos presas.

### 3.9 Modos de falha, assumidos explicitamente

| Modo | Realidade | Mitigação |
|---|---|---|
| **Cota** | 4 fotos × ~300 KB ≈ 1,2 MB por equipamento/dia. O risco é uma pane de vários dias | Comprimir **antes** de enfileirar; checar `storage.estimate()` e recusar acima de 80% com mensagem clara, em vez de estourar `QuotaExceededError` no meio da escrita; chamar `navigator.storage.persist()` após a primeira captura |
| **iOS Safari** | Descarta storage após **7 dias sem interação** em site não instalado | Empurrar a instalação na tela de início; avisar quando a fila passar de 48 h; **e a própria cobrança traz o operador de volta ao app** — na prática a melhor mitigação. Risco residual aceito |
| **HEIC** | iPhone grava HEIC por padrão; `canvas.drawImage` falha, e `compressImage` **não tem `onerror`** — hoje falha em silêncio e o operador acha que mandou | Adicionar `reader.onerror` e `img.onerror`. Em falha, enfileirar os **bytes originais** e transcodificar no servidor. Perda silenciosa é o único desfecho inaceitável |
| **`navigator.onLine` mente** | Retorna "online" em wi-fi de portal cativo sem rota | Usar só como sinal negativo barato; a autoridade é o POST ter dado certo |
| **Relógio errado** | Captura offline carrega o relógio do aparelho | Enviar hora do aparelho **e** delta monotônico; servidor grava `dev_clock_skew_s`. Sinalizar `|skew| > 300 s` na tela administrativa; se `> 1 h`, o servidor recalcula o `data_ref` e registra ambos |
| **Duas abas** | Duas abas esvaziando a mesma fila duplicariam upload | O `client_id UNIQUE` torna inofensivo |

---

## 4. Armazenamento — onde a foto mora

**Restrição real:** o único volume montado é `mak_uploads → /usr/src/app/public/uploads`.
Qualquer coisa fora dele **é apagada a cada deploy**. Mas `server.js:2019-2022` serve `/uploads`
de forma **pública e sem autenticação**.

Solução: gravar dentro do volume e bloquear o acesso HTTP àquela subárvore, montando a guarda
**antes** do `express.static`:

```js
// ANTES da linha 2019
app.use('/uploads/evidencias', (req, res) => res.status(404).end());
app.use('/uploads', express.static(uploadDir, { maxAge: '1d', etag: false }));
```

```
public/uploads/                       ← volume mak_uploads
  evidencias/
    orig/<obraId>/<AAAA>/<MM>/<registroId>.jpg     ← imutável, nunca sobrescrito
    cache/<registroId>/<variante>_v<stampVersion>.jpg
    export/<offloadId>/<nome>.zip
    inbox/                                          ← multer tmp
```

Persistente ✔ · não público ✔ · fora da varredura semanal, que só toca `uploads/orders` e
`uploads/ordens` (`cronService.js:556-585`) ✔ · zero trabalho de infra ✔.

Raiz configurável: `EVIDENCIAS_ROOT` com default acima, para poder migrar de volume sem alterar
código. **Todo** acesso a disco passa pelo `resolverCaminho()` copiado de
`aiVisionService.js:71-79`. O banco guarda caminho **relativo**, nunca absoluto.

### Exibição: URL assinada

`<img src>` não carrega header `Authorization` e o JWT vive em `localStorage`. Cada listagem
devolve, por foto, URLs assinadas:

```
/api/public/evidencias/<id>/<variante>?v=<stampVersion>&exp=<unix>&s=<hmac>
```

`s = HMAC-SHA256(JWT_SECRET, "id|variante|versao|exp")`, `exp` de 8 h, rota montada **acima** do
`authMiddleware` (`server.js:2049`) porque se autentica sozinha. Como `stamp_version` entra na
assinatura, **editar o carimbo invalida sozinho todas as URLs antigas** — e por isso
`Cache-Control: private, max-age=31536000, immutable` é seguro. É uma superfície mais estreita do
que o `/uploads` público de hoje.

Download é rota separada, autenticada e auditada (`Content-Disposition`), como
`chatController.js:539-542`.

### Espaço

~800 fotos/dia × ~300 KB ≈ **240 MB/dia** ≈ 5 GB/mês útil. Com permanência de ~2 meses e obras
simultâneas, o regime fica em **~10–16 GB** — confortável nos 50 GB, com margem para crescer.
Capturas de horímetro em **1600 px** (o dígito precisa ser legível), fotos de trabalho em 1280 px.
O `cache/` é descartável por definição: cron semanal novo apaga o que não é lido há 60 dias.
**Os originais nunca são varridos por nada.**

> ⚠️ **O volume não tem backup.** É prova de cobrança em disco sem cópia. Até que isso seja
> resolvido, **o offload periódico para a máquina de TI é o backup de fato** — o que torna a
> fase 7 mais importante, não menos.

---

## 5. Carimbo

### 5.1 Não-destrutivo

O carimbo **nunca** é queimado no upload. O original é gravado uma vez e preservado para sempre;
o carimbo é metadado, renderizado sob demanda e cacheado por versão.

- Colunas **`dev_*`** = o que o aparelho capturou. Escritas uma vez, **nunca sofrem UPDATE**.
- Colunas **`ov_*`** = override do admin. `NULL` significa "usar o valor do aparelho".
- Valor efetivo = `COALESCE(ov_x, dev_x)`.
- Toda edição incrementa `stamp_version` e grava em `evidencia_stamp_audit`.

Queimar no upload seria estritamente pior: destrói o único artefato que pode ser rederivado, e
pixel queimado nunca esteve ligado criptograficamente a nada — quem quiser fraudar resolve no
editor de imagem em trinta segundos. A defensabilidade vem da **procedência** (hash + auditoria),
não do pixel.

**Três variantes**, com estratégias diferentes de geração:
- `thumb` (400 px) — gerada **na hora** do ingest e a cada edição de carimbo;
- `stamped` (1600 px) — **preguiçosa**, na primeira requisição, com mapa de promessas em voo para
  que dois cliques não rendam duas vezes;
- `clean` — o original só com `.rotate()` aplicado.

Sem isso, um admin abrindo um dia de 200 fotos dispara 200 renders simultâneos num contêiner que
também roda o serviço de WhatsApp.

### 5.2 Sem vestígio de edição

**A imagem renderizada é idêntica tenha sido editada ou não.** Nada de marca d'água "editado",
número de versão, data de alteração ou rodapé de auditoria. Exigência explícita do negócio.

O rastro existe — e é completo — mas vive **só** em `evidencia_stamp_audit` e na tela
administrativa. `motivo` é **obrigatório** para remover o carimbo e para alterar
`ov_capturado_em`, `ov_latitude` ou `ov_longitude` — as três edições que poderiam fabricar prova
de cobrança. É o que separa "corrigiram um GPS errado" de "manufaturaram evidência", e custa uma
caixa de texto.

### 5.3 Quais campos são impressos — configurável em 3 níveis

Tabela única `evidencia_carimbo_config` com `escopo ENUM('global','obra','veiculo')` +
`escopo_id` + `campos JSON`. Precedência: **equipamento > obra > global**.

| Campo | Configurável? |
|---|---|
| **Coordenadas (lat/long)** | **Não — sempre impressas.** Decisão do negócio |
| Data e hora | sim |
| Endereço / cidade | sim |
| Nome da obra | sim |
| Equipamento (registro interno / placa) | sim |
| Operador | sim |
| Horímetro | sim |
| Precisão do GPS | sim |
| Linha livre | sim |

### 5.4 Coordenada obrigatória, nome do lugar sem internet

GPS não depende de internet: qualquer celular com localização ativa entrega coordenada offline.
Portanto **sem coordenada a captura é bloqueada**, e coordenada ausente jamais grava `0,0`.

O que depende de rede é só *dar nome* ao ponto — e nem isso precisa: `frontend/src/utils/geo.js:106`
`cidadeDoPonto(lat, lng, geojson)` já faz point-in-polygon sobre `public/data/rs-municipios.geojson`,
cobrindo Lajeado e Santa Maria, as duas regiões de obra (`obras.regiao`). Fora do RS, cai para a
cidade mais próxima por haversine ou fica vazio, e o admin completa depois.

### 5.5 Duas armadilhas técnicas

- **Orientação EXIF.** Foto de celular chega girada por tag. Sem normalizar, o carimbo sai
  deitado. Sempre `.rotate()` (o sharp aplica a tag) antes de compor.
- **"Sem geolocalização" tem que significar também sem GPS no EXIF.** Entregar o "limpo" com a
  coordenada ainda no metadado seria uma mentira: o arquivo continuaria carregando a posição.
  Remover EXIF na saída das variantes renderizadas; o original preservado mantém tudo.

### 5.6 Fonte — a falha que realmente morde

Compondo o carimbo como SVG, o sharp renderiza via librsvg, que exige `fontconfig` **e uma fonte
instalada**. O `node:18-alpine` não tem nenhum dos dois, e o sintoma é texto sumindo ou virando
quadrado — justamente em português acentuado ("Início", "Horímetro", nomes de obra).

```dockerfile
RUN apk add --no-cache tzdata fontconfig ttf-dejavu
```

e fixar `font-family="DejaVu Sans"` no SVG. Usar **mono** na tarja: é o que faz a foto parecer
registro de equipamento, e não decoração.

---

## 6. Modelo de dados

Uma **IIFE nova** em `backend/server.js` após a última migração (~linha 1788), no estilo da casa:
`CREATE TABLE IF NOT EXISTS`, **sem FOREIGN KEY**, `try/catch` que só loga.

> ⚠️ **Tipos de ID.** `users.id`, `obras.id`, `vehicles.id` e `employees.id` são **`varchar(255)`**
> (conferido em `SQL/bancosql.sql`). O `backend/CLAUDE.md` afirma que `users` é `INT
> AUTO_INCREMENT` — **está errado**, e a revisão 1 deste guia herdou o erro. PK das tabelas novas
> é `VARCHAR(36)` (`crypto.randomUUID()`); **toda referência é `VARCHAR(255)`**.

| Tabela | Papel |
|---|---|
| `evidencia_config` | Exigências e janelas de horário por obra |
| `evidencia_carimbo_config` | Campos impressos — global / obra / equipamento |
| `evidencia_registro` | Registro central: arquivo, `sha256`, `dev_*`, `ov_*`, `stamp_version`, campos de offload |
| `evidencia_stamp_audit` | Append-only: toda alteração de carimbo, com motivo |
| `evidencia_dispensa` | Anulações por dia/turno |
| `evidencia_motivo_dispensa` | Catálogo editável de motivos |
| `evidencia_aderencia_dia` | Consolidação 4/4 |
| `evidencia_cobranca_log` | Dedupe de cobrança |
| `evidencia_offload` | Lotes de arquivamento |

```sql
CREATE TABLE IF NOT EXISTS evidencia_registro (
    id             VARCHAR(36)  PRIMARY KEY,
    client_id      VARCHAR(36)  NOT NULL,           -- idempotência da fila offline
    obra_id        VARCHAR(255) NOT NULL,
    veiculo_id     VARCHAR(255) NOT NULL,
    employee_id    VARCHAR(255) DEFAULT NULL,
    user_id        VARCHAR(255) DEFAULT NULL,
    tipo    ENUM('horimetro_inicio','horimetro_fim','foto_manha','foto_tarde','extra') NOT NULL,
    data_ref       DATE NOT NULL,
    turno          ENUM('manha','tarde','indefinido') NOT NULL DEFAULT 'indefinido',

    -- arquivo (imutável)
    arquivo_rel    VARCHAR(400) NOT NULL,           -- relativo a EVIDENCIAS_ROOT
    arquivo_bytes  BIGINT NOT NULL,
    arquivo_mime   VARCHAR(60) NOT NULL,
    sha256         CHAR(64) NOT NULL,               -- integridade + dedupe + chave de restauração
    largura_px     INT DEFAULT NULL,
    altura_px      INT DEFAULT NULL,

    -- capturado pelo aparelho (NUNCA sofre UPDATE)
    dev_capturado_em     DATETIME NOT NULL,
    dev_latitude         DECIMAL(10,7) DEFAULT NULL,
    dev_longitude        DECIMAL(10,7) DEFAULT NULL,
    dev_precisao_m       DECIMAL(8,2)  DEFAULT NULL,
    dev_local_texto      VARCHAR(200)  DEFAULT NULL,
    dev_obra_nome        VARCHAR(200)  DEFAULT NULL,
    dev_equip_label      VARCHAR(120)  DEFAULT NULL,
    dev_operador_nome    VARCHAR(150)  DEFAULT NULL,
    dev_exif_orientation TINYINT       DEFAULT NULL,
    dev_clock_skew_s     INT           DEFAULT NULL,
    dev_origem     ENUM('web_online','web_offline','mobile') NOT NULL DEFAULT 'web_online',

    -- override do carimbo (só via endpoint auditado)
    ov_capturado_em   DATETIME      DEFAULT NULL,
    ov_latitude       DECIMAL(10,7) DEFAULT NULL,
    ov_longitude      DECIMAL(10,7) DEFAULT NULL,
    ov_local_texto    VARCHAR(200)  DEFAULT NULL,
    ov_obra_nome      VARCHAR(200)  DEFAULT NULL,
    ov_equip_label    VARCHAR(120)  DEFAULT NULL,
    ov_operador_nome  VARCHAR(150)  DEFAULT NULL,
    ov_linha_extra    VARCHAR(200)  DEFAULT NULL,
    stamp_mode        ENUM('carimbado','limpo') NOT NULL DEFAULT 'carimbado',
    stamp_posicao     ENUM('inferior','superior') NOT NULL DEFAULT 'inferior',
    stamp_version     INT NOT NULL DEFAULT 1,

    horimetro      DECIMAL(12,2) DEFAULT NULL,
    odometro       DECIMAL(12,2) DEFAULT NULL,

    -- ciclo de vida / arquivamento (o rastro)
    estado          ENUM('ativo','arquivado','descartado') NOT NULL DEFAULT 'ativo',
    offload_id      VARCHAR(36)  DEFAULT NULL,
    offload_pasta   VARCHAR(300) DEFAULT NULL,
    offload_arquivo VARCHAR(200) DEFAULT NULL,
    offload_em      DATETIME     DEFAULT NULL,
    offload_por     VARCHAR(255) DEFAULT NULL,
    restaurado_em   DATETIME     DEFAULT NULL,
    restaurado_por  VARCHAR(255) DEFAULT NULL,
    historico       JSON         DEFAULT NULL,      -- guarda offloads anteriores após restaurar

    observacao     VARCHAR(500) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_evid_client (client_id),
    KEY idx_evid_obra_data (obra_id, data_ref),
    KEY idx_evid_veic_data (veiculo_id, data_ref, tipo),
    KEY idx_evid_emp (employee_id, data_ref),
    KEY idx_evid_estado (estado, obra_id),
    KEY idx_evid_sha (sha256),
    KEY idx_evid_offload (offload_id)
);

CREATE TABLE IF NOT EXISTS evidencia_stamp_audit (
    id            VARCHAR(36)  PRIMARY KEY,
    registro_id   VARCHAR(36)  NOT NULL,
    stamp_version_antes  INT NOT NULL,
    stamp_version_depois INT NOT NULL,
    acao          ENUM('editar','remover','restaurar_padrao') NOT NULL,
    campos_antes  JSON DEFAULT NULL,
    campos_depois JSON DEFAULT NULL,
    motivo        VARCHAR(300) DEFAULT NULL,        -- obrigatório em remover / data / GPS
    user_id       VARCHAR(255) NOT NULL,
    user_nome     VARCHAR(150) DEFAULT NULL,
    ip            VARCHAR(64)  DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_esa_registro (registro_id, created_at)
);

CREATE TABLE IF NOT EXISTS evidencia_aderencia_dia (
    id          VARCHAR(36)  PRIMARY KEY,
    obra_id     VARCHAR(255) NOT NULL,
    veiculo_id  VARCHAR(255) NOT NULL,
    employee_id VARCHAR(255) DEFAULT NULL,
    data_ref    DATE NOT NULL,
    tem_horimetro_inicio TINYINT(1) NOT NULL DEFAULT 0,
    tem_horimetro_fim    TINYINT(1) NOT NULL DEFAULT 0,
    tem_foto_manha       TINYINT(1) NOT NULL DEFAULT 0,
    tem_foto_tarde       TINYINT(1) NOT NULL DEFAULT 0,
    exigidas    TINYINT NOT NULL DEFAULT 4,          -- dispensas REDUZEM este número
    cumpridas   TINYINT NOT NULL DEFAULT 0,
    dispensadas TINYINT NOT NULL DEFAULT 0,
    completo    TINYINT(1) NOT NULL DEFAULT 0,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_evid_ader (veiculo_id, data_ref),
    KEY idx_ader_obra_data (obra_id, data_ref, completo)
);
```

> `uq_evid_ader` é **`(veiculo_id, data_ref)`** — não inclui `obra_id`. Um equipamento num dia
> pertence a exatamente uma obra; a chave mais larga permitiria que uma transferência no meio do
> dia criasse duas linhas pela metade.

As demais tabelas seguem o mesmo padrão. Destaques:
`evidencia_cobranca_log` com `UNIQUE (veiculo_id, data_ref, tipo_cobranca, canal)`;
`evidencia_carimbo_config` com `UNIQUE (escopo, escopo_id)`;
`evidencia_dispensa` conforme §8.

---

## 7. Endpoints

`backend/routes/evidenciaRoutes.js`, montado em `server.js` (~2145). Guardas no padrão de
`routes/solicitacaoRoutes.js:29-35`:

```js
const requireApp    = requireAnyPage(['evidencias_app', 'admin_solicitacoes_app']);
const requireGestor = requireAnyPage(['admin_evidencias', 'admin_solicitacoes']);
// edição de carimbo e offload exigem admin/gerência (ver §5.2)
```

| Método | Rota | Guarda | Função |
|---|---|---|---|
| GET | `/evidencias/meu-escopo` | app | Pacote offline (§3.5) |
| POST | `/evidencias` | app | Ingest multipart, idempotente em `client_id` |
| GET | `/evidencias/minhas` | app | Últimos 7 dias do operador |
| POST | `/evidencias/dispensa` | app | Registrar anulação (§8) |
| GET | `/evidencias` | gestor | Arquivo: filtros obra/equipamento/**operador**/período/tipo/estado |
| GET | `/evidencias/:id` | gestor | Detalhe + histórico de auditoria |
| PUT | `/evidencias/:id/carimbo` | **admin/gerência** | Edita `ov_*`; incrementa versão, audita, limpa cache |
| DELETE | `/evidencias/:id/carimbo` | **admin/gerência** | `stamp_mode='limpo'` — **exige `motivo`** |
| POST | `/evidencias/:id/carimbo/restaurar` | **admin/gerência** | Zera `ov_*`, volta ao valor do aparelho |
| GET | `/evidencias/:id/download?variant=stamped\|clean` | gestor | **As duas versões**; remove GPS do EXIF no `clean` |
| POST | `/evidencias/download-lote` | gestor | Multi-seleção → ZIP, sem arquivar |
| GET | `/evidencias/aderencia` | gestor | Painel por obra/período/equipamento/operador |
| GET/PUT | `/evidencias/config/:obraId` | gestor | Exigências e janelas |
| GET/PUT | `/evidencias/carimbo-config` | **admin/gerência** | Campos impressos nos 3 níveis (§5.3) |
| GET/POST/DELETE | `/evidencias/dispensa` | gestor | Listar, criar, **revogar** |
| POST | `/evidencias/dossie` | gestor | PDF de comprovação (pdfkit) |
| POST | `/evidencias/offload` | **admin** | Cria lote; **não apaga nada** |
| GET | `/evidencias/offload/:id/zip` | **admin** | Baixa o ZIP pronto |
| POST | `/evidencias/offload/:id/confirmar` | **admin** | **Só aqui** os originais são apagados |
| POST | `/evidencias/restaurar` + `/preflight` | **admin** | Volta imagens ao sistema (§11.3) |
| GET | `/vehicles/:id/evidencias` | gestor | Linha do tempo do equipamento (não existe histórico genérico hoje) |
| GET | `/public/evidencias/:id/:variante` | **HMAC** | Imagem assinada, acima do `authMiddleware` |

Multer do ingest: destino `uploads/evidencias/inbox`, limite 12 MB, e mensagem de recusa contendo
a palavra **"arquivo"** (§3.7).

`GET /evidencias` **nunca** aceita período ilimitado — teto de 92 dias no servidor, senão o
primeiro admin que clicar "todos" puxa dezenas de milhares de linhas.

---

## 8. Dispensa de fotos ("anular")

O operador registra a inatividade e o sistema para de exigir **e de cobrar**.

- **Abrangência:** um equipamento, vários, ou **todos** os da obra num dia.
- **Período:** dia inteiro, só manhã ou só tarde.
- **Motivo:** catálogo pré-configurado — *Chuva · Veículo em Manutenção · Veículo com problema ·
  Falta de operador · …* — editável na página de Administração, **mais** um texto curto livre.

```sql
CREATE TABLE IF NOT EXISTS evidencia_dispensa (
    id             VARCHAR(36)  PRIMARY KEY,
    obra_id        VARCHAR(255) NOT NULL,
    veiculo_id     VARCHAR(255) DEFAULT NULL,       -- NULL = TODOS os equipamentos da obra
    data_ref       DATE NOT NULL,
    periodo        ENUM('dia','manha','tarde') NOT NULL DEFAULT 'dia',
    motivo_codigo  VARCHAR(40)  DEFAULT NULL,
    motivo_texto   VARCHAR(300) DEFAULT NULL,
    criado_por     VARCHAR(255) NOT NULL,
    criado_por_nome VARCHAR(150) DEFAULT NULL,
    origem         ENUM('operador','gestor') NOT NULL DEFAULT 'operador',
    revogada_em    DATETIME DEFAULT NULL,
    revogada_por   VARCHAR(255) DEFAULT NULL,
    revogada_motivo VARCHAR(300) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_disp_obra_data (obra_id, data_ref),
    KEY idx_disp_veic_data (veiculo_id, data_ref)
);
```

**Efeitos:**
- **Aderência:** o dispensado sai do **denominador** (`exigidas` diminui, `dispensadas` sobe) em
  vez de contar como falta. A obra não é punida por chuva.
- **Cobrança:** os crons pulam o que está dispensado e não revogado.

**Governança.** O operador registra sozinho — se dependesse de aprovação, não serviria em campo.
Em troca: a dispensa aparece **destacada** no painel com autor, motivo e hora, e o admin pode
**revogar**, restaurando a exigência. Sem essa contrapartida, "anular" vira o caminho fácil para
nunca mandar foto, e o módulo inteiro perde o sentido.

---

## 9. Cobrança automática

Um bloco novo em `backend/services/cronService.js`.

> ⚠️ **Nunca cravar hora na expressão do cron.** `Dockerfile:4-6` define
> `TZ=America/Sao_Paulo`, mas `cronService.js:625-627` comenta a mesma expressão como se o
> contêiner fosse UTC. As duas coisas não podem ser verdade — a convenção do arquivo é
> contraditória e alguns crons existentes podem estar rodando 3 h fora do comentado. Usar o
> padrão seguro que já existe em `cronService.js:117-129`: `'* * * * *'` + checagem em JS via
> `getGmt3Date()`, que funciona sob os dois fusos.

```js
cron.schedule('* * * * *', async () => {
    const d = getGmt3Date();
    const h = d.getUTCHours(), m = d.getUTCMinutes();
    const hoje = getTzDateStr(0), ontem = getTzDateStr(-1);

    if (h===10 && m===0  && await claimSlot('evid_lembrete_manha', hoje)) await lembreteManha(hoje);
    if (h===15 && m===0  && await claimSlot('evid_lembrete_tarde', hoje)) await lembreteTarde(hoje);
    if (h===18 && m===30 && await claimSlot('evid_cobranca_fim',  hoje)) await cobrancaFimDeDia(hoje);
    if (h===7  && m===30 && await claimSlot('evid_consolida',     hoje)) await consolidar(ontem);
    if (h===8  && m===0  && await claimSlot('evid_resumo',        hoje)) await resumoGestores(ontem);
});
```

`claimSlot(chave, dia)` generaliza `getLastDailyRunDate`/`setLastDailyRunDate`
(`cronService.js:88-104`): `INSERT … ON DUPLICATE KEY UPDATE` atômico em `system_settings`
devolvendo se mudou de fato, para que um restart às 10:00:30 ou um segundo contêiner não
disparem duas vezes. Chaves namespaced `cron_evid_*` — **não** reusar `cron_lastDailyRunDate`,
isso quebraria a rotina de RH.

**Dois níveis de dedupe, os dois necessários:** o `claimSlot` (uma execução por dia) e o
`UNIQUE (veiculo_id, data_ref, tipo_cobranca, canal)` de `evidencia_cobranca_log` (uma mensagem
por equipamento por slot por canal). Gravar o log **antes** de enviar, pulando em erro de chave
duplicada — assim o log é a trava, não o registro dela.

**Regras:**
- Só equipamentos **no escopo do §2**, em obras `ativa`, com `evidencia_config.ativa = 1`.
- **Push ao operador** + **um único WhatsApp agregado** ao responsável da obra, listando os N
  equipamentos pendentes. Nunca uma mensagem por equipamento: a ~200 operadores isso faz o número
  ser limitado ou banido, e `cronService.js` já mantém um cron dedicado a monitorar a fragilidade
  da conexão do WhatsApp.
- **Nunca cobrar** sábado, domingo e feriado, salvo configuração em contrário (a tabela de
  feriados já existe). **Nunca cobrar** equipamento com `dataSaida IS NOT NULL` (saiu da obra),
  nem o que está dispensado.

Templates novos em `notificationDispatcher.js`; `dispatchAsync(evento, payload, { obraId })` —
`notification_log` já tem `obra_id`, então o histórico de cobrança fica consultável no dia 1 sem
custo extra.

---

## 10. Telas

### 10.1 Operador — entrada única, três funções

Hoje `App.js:671-867` tem três saídas distintas (só comboio / ambos / só normal) e o chooser de
cards só aparece numa delas — a maioria dos operadores nunca o vê. Unificar atrás de um **shell
com abas**:

```
[ Abastecimento ]  [ Evidências ]  [ Fila ⑷ ]
```

Isso entrega o pedido — a página do operador ganha mais essa função — sem inchar o arquivo de
1401 linhas, e de quebra corrige a inconsistência das três saídas. O padrão a seguir é o de
`operadorTelaAtual === 'documentos'`, já checado em `App.js:681` **antes** da detecção de
veículos, com a prop `onAbrir…` nos quatro pontos existentes (`:764`, `:788`, `:805`, `:863`).

**Tela de captura:** escolher o equipamento (auto-selecionado quando só há um, o caso comum),
depois quatro cartões grandes de status — ✅ enviado · ⏳ na fila · ○ pendente · ⚠ fora da janela ·
🚫 dispensado. Horímetro abre teclado numérico + foto; fotos de trabalho são só foto. Botão de
**dispensa** com os motivos padrão. Mobile-first, coluna única, alvos `py-4 text-lg`, bottom-sheet,
tokens do Terroso Mineral. Os dados vêm do pacote em IndexedDB, não do `DataContext`.

### 10.2 Administração — página `admin_evidencias`

Novo item do grupo **Administração**, ao lado de Usuários / Frota / Comunicação / Sistema. Reúne
tudo que é gestão do módulo:

- **Configuração do carimbo** nos 3 níveis (§5.3), com pré-visualização ao vivo.
- **Exigências e janelas** por obra; motivos de dispensa; limite de aderência e regra de corte do
  WhatsApp (em `system_settings`, editável sem deploy).
- **Arquivo de evidências** — busca cruzada entre obras, com filtro por obra, equipamento,
  **operador**, período, tipo e estado. Miniaturas por URL assinada; itens arquivados renderizam
  como **cartão de rastro**, não como imagem quebrada. Multi-seleção → baixar com carimbo / sem
  carimbo / gerar dossiê.
- **Editor de carimbo** — preview à esquerda, campos à direita, cada um mostrando o valor do
  aparelho em cinza como placeholder e uma seta "restaurar" quando sobrescrito. Pino arrastável
  no mapa (leaflet já é dependência). `motivo` obrigatório onde a §5.2 manda. Histórico completo
  listado abaixo. Salvar incrementa `stamp_version` → todas as URLs mudam → o navegador rebusca
  sozinho, sem nenhuma lógica de cache-busting no cliente.
- **Painel de aderência** — grade obra × dia, ranking por operador, dispensas destacadas, e o
  indicador de **prontidão para corte do WhatsApp**.
- **Offload e restauração** (§11).

### 10.3 Faturamento — aba na Ficha da Obra, não página nova

`frontend/src/pages/FichaObraPage.js` já existe com as abas Visão geral / Aproveitamento /
Faturamento. As fotos da obra entram como **4ª aba "Evidências"**.

É o lugar certo: quem cobra já vai à Ficha responder "como vai esta obra / o que dá para cobrar",
e a aba `FichaFaturamento.js` já calcula contratado × apontado — as fotos são exatamente a prova
por trás daquelas horas. O princípio do próprio plano da Ficha ("aba só quando a pergunta muda")
se aplica: *"o que comprova este trabalho"* é pergunta diferente de *"o que dá para cobrar"*.

Porta de entrada pelo grupo Faturamento: link **"Ver evidências"** no Relatório de Horas, abrindo
a Ficha já nessa aba. Uma página separada só criaria um segundo lugar para procurar a mesma coisa.

### 10.4 Ligações obrigatórias

`renderPage()` + `Sidebar.js` (`navGroups`) + `PAGE_RESOURCE_REQUIREMENTS` (`App.js:560-584`) +
`RESOURCE_DEFS`/`TARGET_TO_RESOURCE` no `DataContext`. Backend: chaves `admin_evidencias` e
`evidencias_app` em `utils/permissions.js`.

> ⚠️ `users.page_permissions` **substitui** a lista do papel quando não está vazia. Quem tem
> override customizado **não** receberá as chaves novas automaticamente — rodar uma query de
> auditoria e reconceder. Colocar isso nas notas de deploy.

---

## 11. Offload, rastro e restauração

### 11.1 Exportar e apagar são etapas separadas

`POST /offload` monta o ZIP em disco de forma assíncrona (`gerando → pronto`) e **não apaga
nada**. A exclusão dos originais acontece **só** em `/confirmar`, depois que alguém confirmou que
o arquivo chegou à máquina de **TI / Desenvolvimento**.

**Nada é disparado por mudança de status de obra.** Hoje `updateObra`
(`obraController.js:205-256`) aceita `status:'finalizada'` por PUT genérico **sem trava de
permissão**, contornando `finishObra` (`:340-364`). Apagar prova de cobrança nesse gatilho seria
perda de dado esperando acontecer. A obra finalizada apenas **entra numa fila de "pendente de
arquivamento"** na tela de Administração.

Lotes de até **2 GB ou 5000 arquivos**, um por mês-calendário. Uma obra de 6 meses são ~150 k
arquivos — um ZIP único falharia. Render limitado a 3 simultâneos para não deixar o app sem CPU.

### 11.2 Conteúdo e o rastro

```
MAK_EVID/BR-386-KM12/2026-09/
  manifest.json
  LEIA-ME.txt
  carimbadas/2026-09-06_ESC014_ABC1D23_foto_manha_01_a3f9c2e1.jpg
  originais/ 2026-09-06_ESC014_ABC1D23_foto_manha_01_a3f9c2e1.jpg
  relatorio-aderencia.csv
```

**As duas versões vão juntas.** `carimbadas/` é o que o cliente olha; `originais/` é o que a
restauração usa — restaurar a carimbada destruiria a propriedade não-destrutiva e deixaria o
carimbo permanentemente inalterável. O sistema detecta e recusa, explicando.

Convenção do nome, que **é** o rastro:

```
MAK_EVID/<OBRA_SLUG>/<AAAA-MM>/<AAAA-MM-DD>_<REGINTERNO>_<PLACA>_<TIPO>_<SEQ>_<HASH8>.jpg
```

`HASH8` = 8 primeiros hex do `sha256`, a chave humana de restauração. Sem `:` nem `?`, caminho
abaixo de 200 caracteres — seguro no Windows.

Na tela, no lugar da miniatura:

> 📦 **Arquivada em 02/10/2026 por Almir**
> `MAK_EVID/BR-386-KM12/2026-09/2026-09-06_ESC014_ABC1D23_foto_manha_01_a3f9c2e1.jpg`
> Destino: *TI / Desenvolvimento* · [Copiar caminho] · [Restaurar imagem]

**Todo o metadado continua visível e pesquisável** — data, hora, GPS, horímetro, operador,
histórico do carimbo. Só os bytes saíram. Aparece em quatro lugares: arquivo administrativo, aba
Evidências da Ficha da Obra, linha do tempo do equipamento e dossiê PDF.

O `manifest.json` carrega o estado completo `dev_*` + `ov_*` de cada item, para que uma restauração
num banco reconstruído recupere não só o pixel, mas o registro probatório inteiro.

### 11.3 Restauração

`POST /evidencias/restaurar` aceita o ZIP, uma pasta solta ou um arquivo. Cascata de
correspondência:

1. **`sha256` dos bytes** contra a coluna indexada — autoritativo, sobrevive a renomear, mover e
   copiar entre máquinas.
2. **`HASH8` do nome** contra `LEFT(sha256,8)` — recupera arquivo cujos bytes mudaram (alguém
   abriu e salvou de novo), com aviso de divergência.
3. **`registroId` do manifesto** — último recurso, reportado como tal.

Ao casar: devolve os bytes, `estado='ativo'`, grava `restaurado_em/por`, e move os campos
`offload_*` para o `historico` JSON — **o rastro de ter sido arquivada nunca se perde**. Devolve
relatório por arquivo. `POST /restaurar/preflight` roda o mesmo casamento sem gravar; oferecer
sempre antes.

---

## 12. Fases

| Fase | Conteúdo | Porta de saída |
|---|---|---|
| **0 — Spike de risco** (0,5–1 dia) | Build descartável `node:18-alpine` + `sharp` + `fontconfig`/`ttf-dejavu`. Provar: **acento renderiza** ("Início", "Horímetro"), HEIC decodifica, vazão de render. Conferir fuso real (`docker exec … date`) | Nada começa sem essas respostas |
| **1 — Offline nível 1** | SW + manifest + exceções nginx (**um commit**), correção do `AuthContext`, cache de escopo, shell do operador | **A página do operador abre e funciona sem sinal — já para abastecimento e comboio.** Valor antes da primeira foto |
| **2 — Backend** | Migrações, guarda de path, ingest com `sha256` + idempotência, render/cache, URL assinada, `meu-escopo` | curl posta foto e devolve URLs que abrem |
| **3 — Captura + fila** | `PhotoCapture` extraído, tela de captura, IndexedDB, página da fila, dispensa | **Piloto: 1 obra, 3–5 equipamentos, 1 semana.** Responde a única pergunta que importa: o operador usa? |
| **4 — Administração** | Página `admin_evidencias`, editor e config do carimbo, auditoria, download nas 2 versões | Requisito do carimbo completo |
| **5 — Aderência + cobrança** | Consolidação, painel, crons, templates, dispensas abatendo do denominador | Crons em **dry-run 3 dias** — um bug aqui manda mensagem a 200 operadores e não há desfazer no WhatsApp |
| **6 — Faturamento** | Aba na Ficha da Obra + link do Relatório de Horas + dossiê PDF | A prova chega a quem cobra |
| **7 — Offload + restauração** | `archiver`, lotes, rastro nas 4 telas, restore + preflight | **Testar a restauração antes do primeiro offload apagar qualquer coisa** |
| **8 — Offline nível 3** | Estender a fila a abastecimento e comboio | Só depois da fila provada — pedido enfileirado e enviado horas depois pode bater na trava de regressão de leitura |
| **9 — Corte do WhatsApp** | Quando a aderência sustentar o limite | Operacional |
| **10 — App nativo (adiado)** | Após um mês de campo | `meu-escopo` já é contrato JSON; o outbox porta direto para SQLite; `pushService` já tem token Expo; **a API não muda** |

### Checklists

**Fase 0** — [ ] `require('sharp')` no alpine · [ ] acento no SVG · [ ] HEIC · [ ] vazão ≥8/s · [ ] `date` no contêiner

**Fase 1** — [ ] `service-worker.js` + registro no `index.js` · [ ] `manifest.json` + ícones + tags no `index.html` · [ ] 3 exceções no nginx **no mesmo commit** · [ ] snapshot + `degraded` no `AuthContext` · [ ] `forceLogout` no-op offline · [ ] shell com abas · [ ] **testar recarregando em modo avião**

**Fase 2** — [ ] migrações · [ ] guarda `/uploads/evidencias` **antes** do `express.static` · [ ] `resolverCaminho()` copiado · [ ] `sha256` + `client_id UNIQUE` · [ ] 3 variantes + cache · [ ] URL assinada · [ ] `meu-escopo`

**Fase 3** — [ ] `PhotoCapture` extraído **com `onerror`** · [ ] GPS obrigatório, sem `0,0` · [ ] `cidadeDoPonto` offline · [ ] IndexedDB + backoff com jitter · [ ] permanente ≠ transitório · [ ] badge em todas as abas · [ ] **testar em iPhone**

**Fase 7** — [ ] `archiver` · [ ] duas pastas no ZIP · [ ] manifesto · [ ] rastro nas 4 telas · [ ] **preflight testado antes de apagar**

---

## 13. Riscos e pendências

1. **O volume `mak_uploads` não tem backup.** Item de maior consequência do plano: prova de
   cobrança em disco sem cópia. Até resolver, **o offload para a máquina de TI é o backup de
   fato** — o que torna a fase 7 mais importante, não menos.
2. **iOS Safari** descarta storage após 7 dias sem interação. Mitigado (instalar na tela de
   início, aviso na fila, e a cobrança trazendo o operador de volta), **não eliminado**. Residual
   aceito pelo negócio; antecipar a fase 10 é a única cura real.
3. **Ambiguidade de fuso nos crons existentes** (§9): alguns podem estar rodando 3 h fora do
   comentado. Fora do escopo corrigir, mas vale reportar depois de confirmado.
4. **`sharp` no alpine** — resolvido ou reprovado na fase 0. Plano B: `@napi-rs/canvas` com fonte
   `.ttf` versionada no repo.
5. **Limite de aderência e corte do WhatsApp** — proposta de 90% por 5 dias úteis. Vive em
   `system_settings`, editável na tela de Administração, para a diretoria mudar sem deploy.
6. **Reconcessão de permissões** para usuários com `page_permissions` customizado (§10.4).

---

## 14. O que mudou desde a revisão 1

| Antes | Agora | Por quê |
|---|---|---|
| `users.id INT AUTO_INCREMENT` | **`varchar(255)`** em users, obras, vehicles, employees | Conferido em `SQL/bancosql.sql`. O DDL anterior quebraria toda junção |
| Carimbo queimado no upload | Original intacto + metadado renderizado sob demanda | O admin precisa poder alterar o carimbo depois |
| Originais em `backend/storage/` | `public/uploads/evidencias/` + guarda 404 | Único volume é `mak_uploads`; fora dele, tudo some a cada deploy |
| Hora cravada na expressão do cron | `'* * * * *'` + `getGmt3Date()` | A convenção de fuso do arquivo é contraditória |
| Backup automático ao finalizar a obra | Manual, com confirmação humana | `updateObra` finaliza obra sem trava de permissão |
| Mobile e web em paralelo | **Web primeiro**, nativo na fase 10 | Decisão do negócio |
| Offline como fase 4 | **Fundação, fase 1** | Sem ele a página do operador não funciona em campo |
| Todos os veículos | Só Caminhões + Máquinas Pesadas | Decisão do negócio; coincide com `getAllowedReadingTypes` |
| — | **Dispensa ("anular")** | Requisito novo |
| — | **Config de campos do carimbo em 3 níveis** | Requisito novo |
| — | **Sem vestígio de edição na imagem** | Requisito novo |
| Página nova em Faturamento | **Aba na Ficha da Obra** | A Ficha já é onde se responde sobre a obra |

---

_Revisão 2 — 2026-09-06. Ancorado nas convenções reais de `backend/CLAUDE.md` e
`frontend/CLAUDE.md`, com as divergências entre documentação e código anotadas onde existem._
