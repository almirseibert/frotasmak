# App Mobile FrotasMAK — guia de implantação e continuação

> **Expo MUDOU.** Antes de escrever qualquer código, leia os docs exatos da versão:
> https://docs.expo.dev/versions/v56.0.0/ (este projeto usa Expo SDK 56).

## O que é este app

App mobile da MAK Frotas em **Expo / React Native** (development build, usa
`expo-dev-client`). Vive na pasta `mobile/` na **raiz** do repositório — **não**
dentro de `frontend/`. O `frontend/` é o site web (React/CRA); o `backend/` é a API.

- `appId` / package Android: `com.makservicos.frotas`
- AVD de teste: `Medium_Phone`
- Assets em `mobile/assets/` são **placeholders** ("MAK" em fundo marrom `#9E7A42`).
  Substituir pelas artes finais quando houver e rodar `npx expo prebuild --clean`.

## Arquitetura de conexão (IMPORTANTE)

O app **não acessa o MySQL diretamente**. Ele fala com a **API REST** do backend,
e o backend é que acessa o banco. As variáveis `DB_*` são **exclusivas do backend**
(EasyPanel) — nunca precisam ser tocadas no mobile.

- API base: `https://frotasmak-frotas-backend.oehpg2.easypanel.host/api`
  (definida em `app.json` → `expo.extra.apiUrl`, lida em `src/api/client.js`).
- O cliente HTTP (`src/api/client.js`) lança "Sem conexão com o servidor" sempre que
  o `fetch` falha na rede — isso é **falha de rede**, não de banco.

## Como rodar

Pré-requisitos: Android SDK (`ANDROID_HOME`), JDK 17, um emulador/dispositivo.

```bash
cd mobile
npx expo run:android        # 1ª vez: builda nativo + instala + abre (demora minutos)
# nas próximas vezes, basta o Metro:
npx expo start --dev-client # depois abrir o app no device
```

Receita testada (emulador já com o dev-client instalado), reconectando ao Metro:

```bash
# 1) sobe o emulador (ver "fix de internet" abaixo)
emulator -avd Medium_Phone -dns-server 8.8.8.8 -no-snapshot-load -no-boot-anim &
adb wait-for-device                       # espera ligar
# 2) sobe o Metro — NÃO use --localhost (ver gotcha de IPv6 abaixo)
npx expo start --dev-client &
adb reverse tcp:8081 tcp:8081             # device:8081 → host:8081 (IPv4)
# 3) abre o app e, na tela do dev-client, toca no servidor "http://localhost:8081"
adb shell monkey -p com.makservicos.frotas -c android.intent.category.LAUNCHER 1
```

Build manual / reset quando algo quebra:
- Pasta nativa incompleta ou faltando `applicationId` → `npx expo prebuild --platform android --clean`
- `prebuild` falha por asset faltando → garantir os PNGs em `mobile/assets/`
- Conflito `INSTALL_FAILED_UPDATE_INCOMPATIBLE` → desinstalar o pacote antigo antes:
  `adb uninstall com.makservicos.frotas`
- Metro com cache velho ("Unable to resolve module" de arquivo que existe) →
  `npx expo start --dev-client --clear`

## Fix recorrente: emulador sem internet

O AVD costuma subir sem internet validada (DNS interno do QEMU quebrado). Sintoma:
ícone "sem internet" no topo e o app mostra "Sem conexão com o servidor".

```bash
# reinicia o emulador com DNS explícito
emulator -avd Medium_Phone -dns-server 8.8.8.8 -no-snapshot-load
```

Confirmar que validou: `adb shell "dumpsys connectivity | grep VALIDATED"` deve
mostrar `IS_VALIDATED`. **Ignorar o `ping`** — o QEMU não encaminha ICMP, então dá
sempre 100% packet loss mesmo com a internet funcionando.

## Fix recorrente: dev-client não carrega ("unexpected end of stream")

Sintoma: na tela do dev-client, ao tocar no servidor, aparece
`Error loading app — unexpected end of stream on http://localhost:8081/...`.

Causa comum: o Metro subiu escutando **só em IPv6** (`[::1]:8081`), mas o
`adb reverse` encaminha para **IPv4** (`127.0.0.1:8081`) — a conexão cai no meio.
Isso acontece quando se usa `npx expo start --localhost`.

```bash
# diagnóstico: deve aparecer 0.0.0.0:8081 (e não só [::1]:8081)
netstat -ano | grep ":8081"
```

Correção: **não** use `--localhost`. Suba com `npx expo start --dev-client` (bind em
`0.0.0.0`, cobre IPv4) e reaplique `adb reverse tcp:8081 tcp:8081`. Outra dica:
tocar no servidor **só depois** do Metro terminar de aquecer (senão o 1º bundle é
cancelado e dá o mesmo erro).

## Estrutura de `src/`

```
src/
  api/client.js            cliente HTTP + endpoints da API
  auth/AuthContext.js      contexto de autenticação (token em AsyncStorage)
  realtime/SocketContext.js socket.io (tempo real)
  navigation/              RootNavigator + abas por perfil (roleTabs.js)
  screens/                 telas por perfil: auth, operador, admin, supervisor, comboio,
                           frota, obras, operacoes, cadastros, relatorios, comum
  components/, push/, theme/, theme/tokens.js
```

Todos os módulos do `MODULE_CATALOG` já têm tela própria — o `EmConstrucaoScreen`
ficou só como fallback. O mapa módulo→tela fica em `MaisScreen.js` → `MODULE_SCREEN`
e a aba Relatórios em `RootNavigator.js` → `TAB_SCREENS`. As listas simples usam
o componente `components/SearchableList.js` (busca + pull-to-refresh + loading/vazio)
e helpers de `utils/format.js`. Telas e endpoints (todos GET já existentes no backend):

| Módulo | Tela | Método em `client.js` |
|--------|------|------------------------|
| relatórios (aba) | `relatorios/RelatoriosScreen` | `getVehicles`+`getRefuelings`+`getObras` |
| abastecimento | `operacoes/AbastecimentosScreen` | `getRefuelings` |
| despesas | `operacoes/DespesasScreen` | `getExpenses` |
| horas | `operacoes/HorasScreen` | `getBillingLogs` (`/billing`) |
| central operacional | `operacoes/CentralOperacionalScreen` | `getOperationalRequests` |
| revisões | `oficina/RevisoesScreen` | `getRevisions` |
| pneus | `oficina/PneusScreen` | `getTires` |
| ordens C/S | `oficina/OrdensScreen` | `getOrders` |
| obras | `obras/ObrasScreen` | `getObras` |
| veículos | `frota/FrotaScreen` | `getVehicles` |
| funcionários | `cadastros/FuncionariosScreen` | `getEmployees` |
| fornecedores | `cadastros/FornecedoresScreen` | `getPartners` |
| estoque | `cadastros/EstoqueScreen` | `getInventoryItems` (`/inventory/items`) |
| multas | `cadastros/MultasScreen` | `getFines` |
| SigaSul GPS | `gps/SigaSulScreen` | `getSigasulPositions` (`/sigasul/positions`) |

> As telas são **somente leitura** (lista + busca). Os nomes de campos foram
> derivados das páginas web equivalentes e da renderização é defensiva (fallbacks).
> Verificados no emulador como **admin** (19/06/2026) com dados reais — os campos
> bateram. `Horas` (`/billing`) e `CentralOperacional` retornaram dados sem precisar
> de filtro. Falta confirmar com os **demais perfis** (operador/supervisor/oficina…),
> que podem ver subconjuntos diferentes ou campos vazios.

`CentralOperacional` mostra as **requisições operacionais** (mudança de obra/operador)
de `/operationalRequests` — não é o dashboard de horas que a web chama de "Central
operacional". Se o objetivo for replicar o dashboard, é outro recorte (usa
`/billing` por obra + datas).

## Status atual

- ✅ Build nativo Android funcionando; APK instala e abre no emulador.
- ✅ Bundle compila sem erros; tela de login renderiza.
- ✅ Conectividade com a API confirmada (login devolve resposta real do backend).
- ✅ Todas as telas dos módulos do `MODULE_CATALOG` implementadas (listas com busca
  + dashboard de KPIs em Relatórios), ligadas a endpoints GET reais da API.
- ✅ Verificado no emulador como **admin** (19/06/2026): aba Relatórios + todas as
  15 telas do "Mais" abrem com dados reais; navegação por `Mais`/abas OK. Registrei
  `Comboio`/`Relatorios`/`Frota` também como telas de stack (fallback) — antes davam
  `'NAVIGATE' ... was not handled by any navigator` para perfis sem a aba.
- ⏳ Validar com os **demais perfis** (operador/supervisor/oficina/abastecimento…).
- ⏳ Telas são só leitura — falta **detalhe/ações** (abrir item, editar, dar baixa…).
- ⏳ Substituir assets placeholder pelas artes finais.
- ⏳ iOS ainda não testado.

## Próximos passos sugeridos

1. Validar os demais perfis (cada `ROLE_TABS` mostra abas/módulos diferentes).
2. Telas de **detalhe** para as listas novas (hoje só `DetalheVeiculo`/`DetalheObra`/
   `DetalheSolicitacao` existem). Padrão: `Stack.Screen` + navegar no `onPress` do
   `ListItem`.
3. Decidir se `CentralOperacional` vira o dashboard de horas (ver nota acima).
4. Conferir campos pouco populados no banco de teste (ex.: só 1 pneu) com dados de
   produção.

## Histórico

O Capacitor (que empacotava o site React como APK, em `frontend/android` +
`frontend/capacitor.config.json`) foi **descartado** em favor do Expo e **removido**
do `frontend/`. Os dois usavam o mesmo `appId`, o que causava conflito de instalação.
