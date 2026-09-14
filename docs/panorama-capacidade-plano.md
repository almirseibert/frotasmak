# Panorama de Capacidade — "o que temos por fazer × o que podemos fazer × o que terceirizamos"

Painel narrativo para a direção. Público: pessoas que **não usam o sistema no dia a dia**.
Formato: história em capítulos, cada um respondendo uma pergunta em linguagem corrente, com o
número em destaque e o detalhe técnico recolhido em drill-down.

---

## 1. Decisões tomadas

| Questão | Decisão |
|---|---|
| Horizonte de tempo | **Nenhum.** Tudo que está no sistema é imediato. O painel é uma **fotografia do agora** — sem calendário, sem projeção, sem pico por mês. Ver §2. |
| Unidade principal | **Máquinas.** A direção decide alugando máquina, não hora. As horas aparecem sempre ao lado, porque é assim que o contrato é medido. |
| Obras em `radar` | **Aparecem**, em bloco próprio ("carteira provável"), fora dos somatórios — não têm plano de trabalho, logo não têm horas. |
| Contratos de terceiro `fechado` | **Entram**, em bloco próprio — as horas ali são acompanhamento físico, não compromisso contratado. |
| Métrica de capacidade | **A mesma do Aproveitamento Produtivo**: `HORAS_POR_DIA = 8` × dias úteis (`utils/businessDays.js`, com feriados), excluindo sucata e descontando manutenção. Ver `obraSupervisorController.js:589,686-689`. **Não** usar os 175 h/mês do `planejamentoController`. |
| Onde mora | Nova aba **`Panorama`** em `PlanejamentoPage`, como primeira aba (antes de Kanban e Balanço). |

---

## 2. Uma fotografia, não uma projeção

Regra da casa (já em `planejamentoController.dimensionar()`): **toda obra deve fechar em ≤ 45
dias**. Não é limite físico — é o cenário ideal de referência. Para este painel, é apenas
**a régua que converte horas contratadas em número de máquinas necessárias**.

**Não há temporalidade.** Tudo que está no sistema precisa começar o quanto antes; mesmo com
prorrogações acordadas, o prazo é curto. Logo, toda obra aberta demanda suas máquinas **agora, ao
mesmo tempo**. Nada de calendário de picos, curva mensal ou projeção — seria precisão falsa.

**Premissa declarada na tela**, para ninguém acusar dupla contagem:
> "Este panorama assume que todas as obras em carteira precisam de máquina simultaneamente. Não
> considera que uma obra possa terminar antes de outra começar — esse encaixe é decidido fora do
> sistema."

**Fora de escopo:** custo, despesa, valor. Tudo em máquinas e horas.

Modelo:

1. Para cada obra aberta × subgrupo: `dimensionar(horas restantes, 45 dias)` → **máquinas necessárias**.
2. Somar por subgrupo → **demanda total simultânea**.
3. Comparar com **frota própria produtiva** (`locadorId IS NULL`, sucata fora, manutenção
   descontada) e com **máquinas de terceiros já contratadas**.
4. `Déficit = demanda − própria − terceiros contratados` → **máquinas a contratar**;
   `déficit × 8 h × dias úteis em 45 dias` → **horas a terceirizar**.

---

## 3. A história, capítulo a capítulo

Cada capítulo = um bloco na tela: frase em texto corrido com os números em negrito, visual de
apoio, e um "ver detalhe" que abre a tabela técnica.

### Faixa de cobertura — no TOPO, não no rodapé
Se obras abertas não têm plano de trabalho cadastrado, **todo número deste painel está
subestimado** — e a direção precisa saber disso **antes** de ler o número principal, não depois.

> "Este panorama cobre **X de Y obras abertas (x%)**. **n obras não têm plano de trabalho
> cadastrado** e estão fora de todos os números abaixo."

Com link direto para cadastrar. Abaixo de 80% de cobertura, a faixa fica vermelha.

### Capítulo 1 — O que temos para fazer
> "Hoje a MAK tem **N obras** em carteira: **A em execução** e **B contratadas aguardando início**.
> Juntas somam **H horas** de máquina contratadas. Dessas, **E já foram executadas**.
> **Restam R horas para fazer.**"

Bloco lateral (carteira provável):
> "Há ainda **Z obras no radar** — prováveis, sem plano de trabalho fechado. Não sabemos quantas
> horas nem quantas máquinas exigem, então **não entram nas contas abaixo**."
> Lista: nome · órgão · região · confiança (`confiancaInfo`).

### Capítulo 2 — De que tipo são essas horas
Barras por subgrupo, ordenadas por volume, com horas e % do total. Marcar planos que estão só em
nível de grupo (`planoNivelGrupo`).

### Capítulo 3 — Quantas máquinas isso exige
> "Nossa régua é entregar toda obra em **45 dias**. Aplicando essa régua obra por obra, para dar
> conta de tudo que está em carteira precisaríamos de **M máquinas em campo ao mesmo tempo** —
> sendo **70 escavadeiras 13t**, **22 rolos**, …"

**Esta é a tela principal.** É a que a direção fotografa e leva para a reunião.

**Máquina é indivisível.** Falte 1 hora ou 100, ainda é uma escavadeira inteira. Por isso o
arredondamento é **para cima, por obra**, e só depois se soma — nunca somar horas de várias obras
e dividir no fim. `dimensionar()` já faz `Math.ceil` por obra; é só somar.

Sem "bruto × líquido" — uma linha por subgrupo, contagem de máquinas, ponto:

| Subgrupo | Precisamos | Operando | Oficina | Disponíveis | Terceiros | **Gap hoje** | Gap se a oficina voltar | Gap em horas |
|---|---|---|---|---|---|---|---|---|
| Escavadeira 13t | 50 | 20 | 10 | 5 | 0 | **25** | 15 | 8.000 h |

- **Precisamos** — `dimensionar(horas restantes, 45 d)` somado sobre as obras com plano
  (`planejada`, `mobilizacao`, `ativa`). `radar` fica fora.
- **Operando** — próprias alocadas em obra hoje. **Inclui `mobilizacao`, não só `ativa`.**
- **Oficina** — próprias em manutenção. Não vão para obra amanhã.
- **Disponíveis** — próprias sem alocação, prontas para ir.
- **Terceiros** — máquinas de contratos vigentes com locadores.
- **Gap hoje** — `Precisamos − (Operando + Disponíveis + Terceiros)`. **A oficina não entra.** É a
  resposta à pergunta da direção: quantas máquinas precisamos providenciar de fora, hoje.
- **Gap se a oficina voltar** — o mesmo com a manutenção somada. Em cinza, ao lado. Mostra o
  tamanho do alívio que a oficina representa sem maquiar o número de hoje.
- **Gap em horas** — `gap hoje × 8 h × dias úteis em 45 dias`, porque o contrato se mede em horas.

Sucata fora de todas as colunas. Ordenada pelo tamanho do gap, semáforo por linha.

**Princípio de exibição, válido para o painel inteiro:** na dúvida entre mostrar ou omitir um
número, **mostrar**. Nunca escolher por conta própria qual recorte a direção deveria ver — expor
os dois lado a lado, deixando claro qual é o número oficial e qual é o cenário. Vale aqui
(oficina), na linha de "prestes a finalizar", nas obras em `radar` e nos contratos `fechado`.

#### O alívio que vem aí — "quantas estão prestes a finalizar?"
Pergunta certa da direção, e o critério **já existe**: `terminando` = ≥ 70% das horas consumidas
**ou** fim previsto/projetado ≤ 15 dias (`planejamentoController`).

Linha logo abaixo de cada subgrupo com gap:
> "Das **20 escavadeiras 13t** operando, **6 estão em obras prestes a finalizar** e devem ficar
> livres em breve. Se realocadas, o gap cai de **15 para 9**."

**Isso não abate o gap na tabela.** Aquelas 6 já estão contadas em "Operando" — subtrair de novo
seria contar duas vezes. É um **sinal de realocação**, em cinza, não somado. Clicável: quais
máquinas, em quais obras, e o % consumido de cada uma.

### Capítulo 4 — Quanto já está com terceiros
> "Já contratamos **K máquinas** de terceiros em **C contratos**, somando **T horas**. Dessas,
> **U já foram executadas** — restam **V horas** que terceiros ainda vão entregar."
>
> "Cruzando com o capítulo 3: das **Y horas** de gap, **V já estão
> contratadas** e **(Y − V) ainda não têm contrato.**"

Esse cruzamento é o número que ninguém tem hoje. Bloco à parte:
> "Há ainda **W contratos de valor fechado**. Neles não contratamos horas e sim um serviço — as
> horas são acompanhamento físico, não compromisso."

### Capítulo 5 — Onde exatamente está o buraco
A direção não para em "faltam 40 escavadeiras" — a pergunta seguinte é **quais obras**. Como o
planejamento acontece fora do sistema, o painel tem que entregar essa lista pronta.

Ao clicar num subgrupo deficitário: as obras que compõem aquela demanda, ordenadas por tamanho —
nome · órgão · região · horas restantes · máquinas exigidas · máquinas hoje alocadas · o que falta.
**Exportável em CSV**, porque é esse recorte que vira planilha na análise paralela ao sistema.

### Capítulo 6 — Em uma frase
> "Temos **R horas** para entregar, o que exige **M máquinas** em campo. Temos **P próprias** e
> **K de terceiros já contratadas** — **faltam D máquinas**, ou **Y horas**. O aperto está
> concentrado em **[subgrupos]**."

### Rodapé
- "**n planos** em nível de grupo, não de subgrupo — o detalhe por porte é aproximado."
- Data/hora da apuração.

---

## 4. Implementação

**Backend** — `GET /api/obras/planejamento/panorama?incluirRadar=1`
Novo handler em `controllers/planejamentoController.js`. Reaproveita `parseJson` e as queries de
obras / consumo / alocações que já estão lá. Acrescenta:
- frota por subgrupo separando **própria** (`vehicles.locadorId IS NULL`) de **terceira**, com
  `estado_calculado` (sucata fora, manutenção descontada) — copiar o CASE de
  `obraSupervisorController.js:644`;
- contratos de terceiro vigentes + aditivos + horas executadas por contrato (portar de
  `frontend/src/utils/terceirizados.js:146`);
- demanda simultânea por subgrupo: `ceil(horas restantes / (8 h × dias úteis em 45 dias))` por obra,
  somado — **sem janela nem calendário**. Não usa `dimensionar()`: aquele calcula com 175 h/mês e
  mês de 30 dias; o panorama usa a métrica do Aproveitamento Produtivo (8 h × dia útil, com
  feriados), que é a decisão registrada no §1. `dimensionar()` segue servindo o Kanban;
- **uniformizar o dimensionamento entre os status.** Hoje `necessidadeAtual` só é calculada para
  `status='ativa'` **e** `contractType='horas'`, enquanto `perfilDemanda` cobre as pré-ativas —
  somar os dois no mesmo total misturaria bruto com líquido. O panorama precisa de **um único
  cálculo** aplicado a `planejada`, `mobilizacao` e `ativa`, com as alocações abatidas só na
  coluna líquida. `radar` fica fora (sem plano);
- máquinas em obras `terminando` por subgrupo, para a linha de alívio (o flag já existe, mas hoje
  só é avaliado em `ativa` — correto, já que obra sem apontamento não pode estar terminando);
- contagem de obras abertas sem plano, para a faixa de cobertura.

Rota registrada **antes** de `/:id` em `routes/obraRoutes.js`, como já se faz com `/planejamento`.

**Frontend** — aba `panorama` em `PlanejamentoPage.js`. Um componente por capítulo, empilhados,
scroll vertical único. Números grandes, frase em texto corrido, tabela recolhida em "ver detalhe".

**Export PDF** — mesmo padrão de `components/reports/PlanejamentoObrasReport.js` (jsPDF). A
história inteira em 2 páginas, para levar impressa à reunião.

**Fases:** (1) endpoint + capítulos 1 a 4 — sem calendário, tudo é somatório sobre dados que já
existem; (2) capítulo 5 (drill-down + CSV) e faixa de cobertura; (3) PDF.

Sem o calendário mensal o esforço cai bastante: o núcleo é um único endpoint agregador, sem
nenhuma lógica temporal nova.

---

## 5. Riscos de dado

1. **Obra sem plano de trabalho** = demanda invisível. Por isso a cobertura vai no topo, não no
   rodapé. O ideal é fechar o cadastro antes de apresentar à direção.
2. **Máquina de terceiro sem apontamento** em `daily_work_logs` infla o "em aberto" de terceiros.
3. **Obra parada mas não finalizada** conta demanda que não existe. A defesa é o capítulo 5: a
   direção reconhece a obra fantasma na lista e manda encerrar.
4. **[RESOLVIDO NO ENDPOINT] Frota própria sem `sub_tipo`.** Dos 477 veículos ativos, os 32 com
   `sub_tipo` preenchido são todos de terceiros; as 376 próprias caem no nome do grupo. Um plano
   escrito em subgrupo nunca encontrava máquina própria e o gap aparecia dobrado em duas linhas
   da mesma frota. **Tratamento:** um grupo só é exibido em subgrupo quando TODA a frota própria
   daquele grupo tem `sub_tipo`; enquanto houver uma máquina sem, demanda e oferta são agregadas
   no grupo. Sem meio-termo — granularidade parcial distribuiria a frota errado. A tela se corrige
   sozinha conforme o cadastro for completado, sem mexer em código. Cada linha devolve
   `granularidade: 'subgrupo' | 'grupo'`, e `cobertura.gruposAgregadosPorCadastro` lista os 17
   grupos hoje agregados. Rodada de 10/09/2026: 27 linhas caíram para 20; `Escavadeira` consolidou
   170 exigidas × 32 operando × 22 terceiros.
5. **Chave de plano sem frota correspondente.** Restam 2 chaves (~7% das horas) que não batem com
   nenhuma máquina: `Caminhão` (10.000 h, nome genérico demais — a frota tem Caçamba Truckado,
   Traçado, Pipa…) e subgrupos de caçamba cujo `tipo` na taxonomia não é o `tipo` usado nos
   veículos. A linha vem com `semFrotaCorrespondente: true` para a tela marcar, em vez de exibir
   como gap normal. Correção é de cadastro/taxonomia, não de código.
6. **Frota própria conta a empresa inteira**, não por região — uma escavadeira em Uruguaiana não
   atende obra em Lajeado. Limitação declarada na v1; quebra por região é evolução natural
   (`obras.regiao` / `cidade_ibge` já existem).
