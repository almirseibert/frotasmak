# Spike de risco — Evidências de Campo (Fase 0)

> Pasta **descartável**. Não faz parte do build de produção. O objetivo é
> responder, com PASS/FAIL, às perguntas da Fase 0 do plano
> (`IMPLANTACAO_EVIDENCIAS_CAMPO_2.md` §12) **antes** de escrever qualquer código
> do módulo. Depois de colher as respostas, pode apagar `backend/_spike_evidencias/`.

## O que ele prova

| # | Teste | Tipo | Meta |
|---|---|---|---|
| 1 | `require('sharp')` carrega no `node:18-alpine` | duro | carrega sem erro |
| 2 | Acento renderiza no SVG (`fontconfig` + `ttf-dejavu`) | duro | "Início/Horímetro/ÁÉÍ" desenham |
| 3 | `sharp` decodifica HEIC (Plano A) ou não (Plano B) | **informativo** | decide a estratégia de HEIC |
| 4 | Vazão de composição do carimbo | duro | ≥ 8 renders/s |
| 5 | Fuso do contêiner é GMT-3 | duro | `getTimezoneOffset() === 180` |

O processo sai com código `0` se todos os testes **duros** passarem, `1` se algum
reprovar — dá pra usar em CI.

## Como rodar

Precisa só de Docker. A pasta `out/` recebe as imagens de conferência visual
(carimbo renderizado) — por isso montamos um volume nela.

### PowerShell (Windows)

```powershell
cd D:\Aplicativos\frotasmak\backend\_spike_evidencias
docker build -f Dockerfile.spike -t evid-spike .
docker run --rm -v ${PWD}\out:/spike/out evid-spike
```

### bash (Linux/Mac/WSL)

```bash
cd backend/_spike_evidencias
docker build -f Dockerfile.spike -t evid-spike .
docker run --rm -v "$PWD/out:/spike/out" evid-spike
```

Depois de rodar, abra **`out/carimbo-teste.png`** e **`out/carimbo-composto.jpg`**
e confirme a olho que os acentos ("Início", "Horímetro", "João") estão nítidos e
não viraram quadrados — o Teste 2 conta pixels, mas o olho é o juiz final da
legibilidade.

## Teste de HEIC com um arquivo real (opcional, recomendado)

O Teste 3 diz se o `sharp` **consegue** decodificar HEIC. Para provar de ponta a
ponta com uma foto de iPhone de verdade, coloque um `.heic` na pasta e rode:

```powershell
copy "C:\caminho\para\foto.heic" .\out\amostra.heic
docker run --rm -v ${PWD}\out:/spike/out evid-spike `
  node -e "require('sharp')('/spike/out/amostra.heic').jpeg().toFile('/spike/out/heic-ok.jpg').then(()=>console.log('HEIC decodificado OK')).catch(e=>{console.error('HEIC FALHOU:',e.message);process.exit(1)})"
```

Se gerar `out/heic-ok.jpg`, o Plano A está livre.

## Como ler o resultado

- **Tudo PASS + Teste 3 = "DECODIFICA"** → Fase 0 aprovada, Plano A de HEIC. Pode
  seguir para a Fase 1. Anote a vazão do Teste 4 no §12 do plano.
- **Tudo PASS, mas Teste 3 = "NÃO decodifica"** → Fase 0 aprovada, mas HEIC exige
  decisão (ver abaixo). Não é bloqueador para começar; é bloqueador para aceitar
  foto de iPhone sem tratamento.
- **Teste 2 FAIL** → a fonte não chegou no `librsvg`. Revisar `apk add fontconfig
  ttf-dejavu` + `fc-cache -f` no `Dockerfile.spike`. Isso é o §5.6 do plano.
- **Teste 4 FAIL** → a estratégia de render preguiçoso + cache por versão (§5.1)
  vira obrigatória, não otimização; e reavaliar concorrência com o serviço de
  WhatsApp no mesmo contêiner.
- **Teste 5 FAIL** → o contêiner **não** está em GMT-3; isso muda toda a §9
  (crons). Reportar antes de mexer em cobrança.

## Se o HEIC reprovar (Plano B)

Duas saídas, em ordem de custo:

1. **Barato — decodificar no cliente.** Antes de enfileirar, converter HEIC→JPEG
   no navegador com `heic2any`. Só entra no caminho quando o `File.type` é
   `image/heic`/`image/heif`, então não pesa o caso comum. O servidor recebe JPEG
   e nunca precisa de libheif. É o recomendado para um app de campo.
2. **Caro — libvips do sistema com libheif.** Descomente o bloco Plano B do
   `Dockerfile.spike` (instala `vips vips-heif` e compila o `sharp` do fonte).
   Encarece imagem e build; só justifica se precisar guardar/servir HEIC nativo.

## Limpeza

```powershell
docker image rm evid-spike
# e apague a pasta backend\_spike_evidencias quando não precisar mais
```
