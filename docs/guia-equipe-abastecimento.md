# O que muda na tela de Solicitações — Guia da equipe de Abastecimento

> Para quem aprova ordens e faz baixas no Frotas MAK.
> Última atualização: 23/08/2026.

---

## Em uma frase

O sistema passou a **ler as fotos** que o operador envia — a do painel e a do cupom — e a dar um
parecer antes de você abrir a solicitação. Nada foi tirado de você: **a decisão continua sendo sua**.

---

## O que a ferramenta faz agora

Quando um operador abre uma solicitação pelo app ou pelo WhatsApp, o sistema:

1. Confere as regras de sempre (leitura menor que a atual, ordem já aberta para o mesmo veículo,
   limite de 20% do contrato da obra, operador fictício há mais de 7 dias);
2. Confere se a **média de consumo** do veículo está dentro do normal;
3. Confere se o consumo desde o último abastecimento **justifica** a quantidade pedida;
4. **Lê a foto do painel** e compara com o número que o operador digitou;
5. Confere se o valor estimado da ordem está abaixo do teto configurado.

Passou em tudo → o sistema marca como **"IA liberaria"**.
Falhou em qualquer ponto → vai para você, com o motivo escrito.

Quando o operador envia o cupom, o sistema também **lê a nota** e já preenche o formulário de baixa.

---

## O ponto mais importante

> **A IA nunca nega uma solicitação.**

Ela só decide entre duas coisas: *liberar sozinha* ou *mandar para o setor conferir*.
Negar continua sendo decisão exclusivamente humana — e negativa continua exigindo motivo escrito.

Se você vir "IA encaminhou", significa apenas: *"não tive segurança para liberar isso sozinha, olha
aí"*. Não quer dizer que a solicitação seja irregular.

---

## O que você vai ver na tela

### Na lista de solicitações

Um selo ao lado do status:

| Selo | Significado |
|---|---|
| 🛡️ **IA liberaria** (verde) | Passou em todos os critérios |
| 🛡️ **IA encaminhou** (âmbar) | Algum critério não passou — o motivo está no detalhe |
| 🕐 **analisando…** (cinza) | Acabou de chegar, a análise leva alguns segundos |
| ⚠️ **IA falhou** (vermelho) | Problema técnico na análise. Trate como uma solicitação normal |

### Nova aba "IA liberaria"

Ao lado de *Pendentes*, *Baixas* e *Histórico*. Junta tudo que passou em todos os critérios —
na prática, a fila de "provavelmente é só conferir e aprovar".

### Ao abrir a solicitação

Um bloco **"Análise da IA"** mostrando:

- **Lido na foto** × **Digitado** × **Confiança** — o número que a IA leu no painel, o que o operador
  digitou, e o quanto ela tem certeza da leitura;
- Cada critério com ✓, ✕ ou ? e a explicação. Exemplo:
  *"Média fora do padrão: último abastecimento 5,39 Km/L vs linha de base do veículo 9,71 ±20%"*.

O símbolo **?** significa "não deu para avaliar" — quase sempre falta de cadastro (capacidade do
tanque, média esperada) ou histórico curto demais. Não é erro da IA nem problema do operador.

Tem também um botão **Reprocessar análise**, para quando a leitura falhou por instabilidade.

---

## A baixa ficou mais rápida

Quando o operador manda a foto do cupom, o sistema lê e mostra no formulário de baixa:

**Litros · R$/litro · Total · Nota Fiscal**

Cada um com uma marca:

- **✓ confere** — bate com a ordem
- **✕ diverge** — não bate; confira antes de confirmar
- **— não lido** — a foto não permitiu ler esse campo

O botão **"Preencher com estes valores"** joga tudo nos campos de uma vez. **Você continua conferindo
e confirmando** — a IA não conclui baixa nenhuma. O que ela elimina é a digitação, que é onde o
tempo era gasto e onde erro de digitação acontecia.

Uma conferência extra que vale conhecer: o sistema checa se **litros × preço = total**. Quando os
três números fecham entre si, é sinal forte de que a leitura está correta.

---

## Fase de acompanhamento — o "treinamento" de 15 dias

É assim que a fase é apresentada às obras: um **período de treinamento de no mínimo 15 dias**, em
que o sistema acompanha os pedidos e aprende o consumo dos equipamentos daquela obra. Internamente
isso é o **modo sombra**:

- A IA analisa tudo e registra o que **teria feito**;
- **Nada é liberado automaticamente** — todas as solicitações continuam passando por você;
- O operador **não vê** nenhum aviso da IA.

Serve para medir. A tela de parâmetros (Admin → Frota → Aceite Automático) mostra a **taxa de
concordância**: quantas vezes a IA acertaria e, principalmente, quantas vezes ela teria liberado algo
que o setor negou.

**Enquanto houver qualquer caso desses, o modo automático nem pode ser ligado** — o botão fica
travado no sistema. Não depende de ninguém lembrar.

### Como você ajuda nessa fase

Trabalhe **exatamente como sempre**. Não aprove nada só porque a IA marcou verde, e não negue nada
só porque ela encaminhou. A medição só vale se as suas decisões forem as de sempre.

Se encontrar um caso em que a IA marcou "liberaria" e você negaria — **avise a coordenação**. Esse é
o caso que mais interessa.

### Por que insistimos que a obra peça tudo pelo site

O aviso enviado às obras pede que **todos** os veículos passem a solicitar pelo `frotamak.com`
durante o treinamento. Não é formalidade: o sistema aprende o consumo de cada equipamento a partir
dos pedidos. Veículo que continua pedindo por fora não gera histórico e, quando a liberação
automática for ligada naquela obra, vai continuar caindo na sua fila — sem que ninguém entenda o
motivo.

Se perceber uma obra em treinamento com veículos ainda pedindo por telefone ou WhatsApp direto,
vale avisar a coordenação para reforçar no grupo.

---

## Quando o modo automático for ligado

Para a obra, a mudança mais visível é que o pedido passa a poder ser feito **a qualquer hora e em
qualquer dia**, inclusive fim de semana e feriado, sem depender de alguém estar no escritório.

Para você, muda pouco:

- Solicitações que passam em tudo geram a ordem sozinhas, e a ordem vai para o posto normalmente.
  O operador recebe aviso no WhatsApp;
- Elas aparecem na aba "IA liberaria", marcadas como liberadas automaticamente;
- **Todo o resto continua caindo na sua fila**, do mesmo jeito de hoje.

A ordem emitida automaticamente é uma ordem comum — mesmo número, mesmo PDF, mesmo envio ao posto.
A única diferença é a marcação de que saiu automática.

---

## Perguntas que já surgiram

**A IA pode liberar um abastecimento errado?**
Ela só libera quando passa em cinco conferências independentes, incluindo comparar a foto do painel
com o número digitado. Qualquer dúvida em qualquer uma delas manda para você. E o modo automático só
é liberado depois de semanas sem nenhum erro na medição.

**E se a foto estiver ruim?**
A IA responde "não consegui ler" em vez de chutar. Solicitação vai para você. Um palpite errado com
ar de certeza seria pior que admitir que não deu.

**E se o sistema da IA cair?**
Tudo volta ao funcionamento de hoje: todas as solicitações vão para conferência manual. O operador
não vê erro nenhum.

**A IA vai substituir a conferência?**
Não. Ela tira a digitação e separa o que é rotina do que precisa de atenção. Decisão, negativa e
confirmação de baixa continuam com pessoas.

**Por que tantas solicitações aparecem com "?" nos critérios?**
Falta cadastro. Capacidade de tanque e média esperada estão sendo preenchidas por modelo de veículo.
Conforme isso avança, o "?" diminui.

---

## Onde encontrar

| O quê | Onde |
|---|---|
| Solicitações e parecer da IA | Abastecimento → Solicitações (App) |
| Parâmetros e taxa de concordância | Admin → Frota → Aceite Automático |
| Ordens bloqueadas por leitura/orçamento | Admin → Frota → Abastecimento |

Dúvida ou comportamento estranho: avise a coordenação com o **número da solicitação**. Toda análise
fica registrada e dá para reconstituir exatamente o que a IA leu e por que decidiu.
