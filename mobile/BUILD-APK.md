# Gerar o APK (MAK Frotas) para distribuição interna

Este projeto serve **apenas para gerar o aplicativo Android (.apk)**. Não há
deploy web/servidor — o acesso por navegador continua sendo o frontend normal.

A build é feita com **EAS Build** (serviço de build do Expo na nuvem). Não é um
serviço contínuo: você roda o comando, ele compila e te devolve um link do `.apk`.

## Pré-requisitos (uma vez)

1. Conta Expo (gratuita): https://expo.dev/signup
2. CLI logada:
   ```bash
   npm install -g eas-cli
   eas login
   ```
3. Vincular o projeto (preenche `extra.eas.projectId` no `app.json`):
   ```bash
   eas init
   ```

## Gerar o APK

```bash
# instala dependências (se ainda não)
npm install

# build de APK para distribuição interna (nuvem)
eas build -p android --profile preview
```

Ao final o EAS mostra um **link para baixar o `.apk`**, que você distribui
internamente (link direto, MDM, etc.). O perfil `preview` está configurado em
[eas.json](eas.json) com `distribution: internal` e `buildType: apk`.

## Alternativa: build local (sem nuvem)

Requer Android SDK + JDK 17 instalados na máquina:

```bash
eas build -p android --profile preview --local
```

ou, usando o Gradle diretamente (a pasta `android/` já é gerada via prebuild):

```bash
npx expo prebuild -p android
cd android
./gradlew assembleRelease   # APK em android/app/build/outputs/apk/release/
```

## Observações

- O identificador do app é `com.makservicos.frotas` (ver `app.json`).
- A URL da API usada pelo app está em `app.json` → `extra.apiUrl`.
- Push notifications nativas (`expo-notifications`) só funcionam neste app
  nativo — por isso o caminho é APK, não web.
