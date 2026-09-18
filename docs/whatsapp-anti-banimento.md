# WhatsApp: estudo anti-banimento do microsserviço

Estudo feito em 18/09/2026, depois do loop de reconexão do boot. Implementado em
`whatsapp/server.js`. Os parâmetros ficam na seção "POLÍTICA DE CONEXÃO (ANTI-BANIMENTO)"
e em "RITMO DE ENVIO".

## 1. O risco, sem rodeio

- O `whatsapp-web.js` automatiza o WhatsApp Web, que não é um canal oficial. Automatizar
  viola os Termos do WhatsApp. **Nenhum ajuste zera o risco; só o reduz.** A única forma
  sem risco de banimento é a API oficial (WhatsApp Business Platform / Cloud API).
- O antiabuso do WhatsApp não publica regras. Os sinais abaixo são os relatados pela
  comunidade e pelos incidentes documentados:

| Sinal | Por que pesa | Onde aparecia no nosso serviço |
|---|---|---|
| Ciclos rápidos de conecta/desconecta | Parecem robô. Caso documentado: cerca de 3.500 ciclos em ~3 h levaram a 72 h+ de restrição, e cada nova tentativa durante a restrição reinicia o prazo | Loop de 18/09: ~30 conexões em 5 min (≈ 360/h) |
| Mesma sessão aberta em dois lugares (`CONFLICT`) | As duas instâncias "tomam" a sessão uma da outra sem parar | O serviço reconectava sozinho em 5 s ao receber `CONFLICT` |
| Reconectar depois de bloqueio (`TOS_BLOCK`) | Insistir durante a restrição agrava e renova a pena | O serviço tratava como queda comum e reconectava |
| Parear o número várias vezes (QR) | Muitos pareamentos seguidos em pouco tempo | "Limpar e Reiniciar" era a dica do painel para qualquer demora |
| Rajadas de mensagens em intervalo fixo | Padrão de disparo em massa | Cron e ordens simultâneas saíam coladas |
| Consultar "este número tem WhatsApp?" repetidamente | Padrão de robô que valida listas | `getNumberId` a cada envio, inclusive para o mesmo posto |
| Denúncia/bloqueio pelos destinatários | É o sinal mais forte de spam | Reenvio de ordem PARCIAL repete o texto inteiro (ver §5) |

## 2. O incidente de 18/09

1. O serviço passou a ser buildado do repositório certo (`frotasmak`, `/whatsapp`). Até
   então ele vinha do `back_desenvolvimento`, com um `server.js` de 11/06.
2. No boot, uma reconexão disparava enquanto outra inicialização ainda estava em curso e
   destruía o Chromium dela. A inicialização morta agendava outra reconexão, e as
   rejeições soltas do Chromium fechado também. Resultado: um loop infinito, com uma
   conexão a cada ~10 s. Ver o commit `2153a6a`.

## 3. O que o serviço faz agora

### Conexão

| Regra | Valor | Por quê |
|---|---|---|
| Espera entre tentativas automáticas | 15 s → 30 s → 1 → 2 → 5 → 10 → 15 min, com ±20% de variação | Queda passageira volta rápido; problema persistente não martela o servidor |
| Disjuntor | Após 5 falhas seguidas, no máximo 1 tentativa a cada ~30 min | Mesmo desenho proposto para o incidente de referência (10 falhas → 30 min), só que mais conservador |
| Conexão estável | Só zera a sequência de falhas depois de 10 min de pé | Cai-volta a cada 2 min conta como falha e também abre o disjuntor |
| Teto por hora (automático + boot) | 8 conexões na última hora | Gravado em `wa-conexoes.json` **no volume**: vale também quando o container reinicia em loop |
| `CONFLICT` | Não reconecta; fica "Reconexão pausada" até reinício manual | Evita o vai e vem entre duas instâncias |
| `TOS_BLOCK` / `SMB_TOS_BLOCK` | Não reconecta; fica pausado até reinício manual | Não renova a pena |
| Reinício manual (painel) | Passa por cima da espera e do disjuntor. Mínimo de 60 s entre cliques e teto absoluto de 15 conexões/h | A decisão é humana, mas clicar várias vezes seguidas é o mesmo padrão de risco |
| Erro do Chromium com o serviço pronto | Só reconecta se a página perdeu o WWebJS | Depois de um reload do WA Web, a lib reinjeta sozinha |

O painel do WhatsApp (Configurações) mostra o estado **Reconexão pausada**, com o motivo,
o horário da próxima tentativa e as conexões da última hora. O `GET /status` expõe o mesmo
no campo `conexao`. Os eventos ficam em `wa-session-events.log` (`RECONEXAO_PAUSADA`,
`REINICIO_MANUAL`).

### Envio

| Regra | Valor |
|---|---|
| Fila única | Uma mensagem por vez, 2,5 a 4,5 s entre envios (intervalo com variação) |
| Cache número → ID | 24 h (número sem WhatsApp: 1 h). Evita consultar o mesmo número a cada ordem |
| Número inexistente | Já não enviava (`getNumberId`); o cache evita repetir a consulta no reenvio automático |

Os chamadores do backend enviam em sequência (`await`), então a fila fica curta e não
estoura o timeout de 120 s do backend.

## 4. Validação (simulador com relógio virtual, sem WhatsApp real)

| Cenário | Antes | Agora |
|---|---|---|
| Boot com 1ª tentativa falhando (o loop de 18/09) | 31 conexões em 5 min, nunca pronto | 2 conexões, pronto |
| WhatsApp Web falhando sempre por 3 h | 1 conexão a cada ~10 s | 10 conexões em 3 h (pior hora: 6), depois 1 a cada ~30 min |
| Conexão caindo a cada 2 min | Reconectava a cada queda | 10 conexões em 3 h (pior hora: 6) |
| `CONFLICT` | Reconectava em 5 s, sem parar | 0 reconexões; pausado até ação manual |
| `TOS_BLOCK` | Reconectava em 5 s | 0 reconexões; pausado até ação manual |
| Container reiniciando em loop (8 conexões nos últimos 10 min) | 1 conexão por restart | Espera liberar vaga no teto antes de conectar |

## 5. Regras de operação (o que NÃO fazer)

1. **Nunca rode dois serviços com a mesma sessão.** Exemplos: um serviço antigo ainda de pé
   no Easypanel, ou `node server.js` na máquina local com uma cópia da pasta
   `.wwebjs_auth`. Isso gera `CONFLICT`.
2. **"Limpar e Reiniciar" só quando o WhatsApp pedir novo pareamento.** Para qualquer
   trava, use "Reiniciar (mantém sessão)".
3. **Evite vários deploys seguidos do serviço WhatsApp.** Cada deploy é uma conexão. O teto
   segura em 8/h, mas o ideal é agrupar as mudanças.
4. **Se aparecer bloqueio (`TOS_BLOCK`):** não tente reconectar. Abra o WhatsApp no celular,
   leia o aviso e, se houver, peça revisão pelo app. Aguarde de 48 a 72 h.
5. **Se aparecer `CONFLICT`:** descubra quem mais está usando a sessão e desligue antes de
   clicar em reiniciar.

## 6. Recomendações ainda não implementadas (por prioridade)

1. **Reenvio de ordem PARCIAL mandar só o PDF.** Hoje o reenvio repete o texto inteiro e o
   posto recebe a mesma ordem duas vezes, o que é risco de denúncia e de confusão
   operacional.
2. **Avisar o admin quando o serviço entrar em "Reconexão pausada"** (notificação no
   sistema/e-mail), em vez de depender de alguém abrir o painel.
3. **Número dedicado e reconhecível.** WhatsApp Business com nome e foto da MAK, e os postos
   salvando o contato. Quem salva e responde raramente denuncia.
4. **Avaliar a API oficial (Cloud API)** para as ordens aos postos: modelos aprovados, custo
   por conversa, sem Chromium e sem risco de banimento. É a solução definitiva.

## Fontes

- [openclaw #16270: circuit breaker contra loops de reconexão que levam a banimento](https://github.com/openclaw/openclaw/issues/16270)
- [whatsapp-web.js #532: relatos de banimento](https://github.com/wwebjs/whatsapp-web.js/issues/532)
- [whapi.cloud: 12 banimentos em 30 dias com automação via navegador](https://whapi.cloud/blog/browser-use-whatsapp-automation)
- Código da lib instalada (`whatsapp-web.js` 1.34.7, commit `2dc9466`): `Client.js`, onde
  `CONFLICT`/`TOS_BLOCK` viram `disconnected` e a lib chama `destroy()`.
