# Item de contrato × máquina que executa

**Escopo:** gestão interna. O sistema **não emite cobrança** — o valor do contrato é cobrado
integralmente e a conferência real é externa e manual. Nada aqui é sobre receita; é sobre o
sistema parar de classificar hora no lugar errado.

---

## 1. Diagnóstico

### Os dois sintomas

**(a) Preço/porte por item.** O contrato diferencia `Escavadeira 23T` de `30T`, com horas e preços
próprios. Agregar tudo em "Escavadeira" apaga a distinção — e foi o que o Panorama passou a fazer.
Aceitável como paliativo enquanto o cadastro está incompleto; errado como regra permanente.

**(b) Substituição.** O contrato tem item 23T, mandamos uma 11T fazer um serviço mais leve. As
horas da 11T não registram no plano da obra.

### A causa é uma só

O sistema usa **um único eixo — a classe da máquina — para duas coisas diferentes**:

| Deveria ser | Hoje é |
|---|---|
| **Item de contrato** — o que foi acordado, com horas e preço | string do subgrupo no JSON `horasContratadasPorSubTipo` |
| **Recurso físico** — que máquina foi lá | `vehicles.sub_tipo` / `vehicles.tipo` |

A ligação entre os dois é **igualdade de string**. `daily_work_logs` tem
`id, obraId, vehicleId, employeeId, date, …, totalHours` — **nenhuma referência ao item do
contrato**. A atribuição é inferida: agrupa-se por `COALESCE(sub_tipo, tipo)` do veículo e torce-se
para bater com a chave do plano. O mesmo vale para o valor calculado em
`analiseGerencialController.js:491`, que busca o preço pelo tipo do **veículo**.

**Efeito:** a 11T que executa o item 23T some do progresso físico da obra e entra no cálculo
interno pelo preço errado (ou por zero). Como a cobrança é externa, isso não vira prejuízo — vira
**gestão cega**: a obra parece menos executada do que está, e o item 23T parece ter saldo que já
foi consumido.

---

## 2. A correção

Tornar o vínculo explícito: a **alocação** declara qual item do contrato aquela máquina vai
desempenhar. Todo apontamento daquela máquina naquela obra herda o item.

```
ITEM DO PLANO               ALOCAÇÃO                    MÁQUINA
Escavadeira 23T   ←──────── desempenha ─────────────→   Escavadeira 11T
200 h                       12/09 → em aberto           (o que foi de fato)
```

### 2.1 Onde guardar o vínculo — recomendação revista

Na versão anterior eu recomendei criar `obra_plano_itens` (item como entidade com id estável). **A
recomendação muda para a opção simples**, porque três das premissas que a sustentavam caíram:
não há cobrança pelo sistema, não há backfill de histórico e não haverá fila de pendências.

**Adotar:** uma coluna na alocação.

```sql
ALTER TABLE obras_historico_veiculos ADD COLUMN planoItemKey VARCHAR(120) DEFAULT NULL;
```

O valor é a própria chave do plano (`"Escavadeira Hidráulica 23T"`). Sem tabela nova, sem refactor
do ObraModal, sem tocar no faturamento.

**Única salvaguarda necessária:** a edição do plano de trabalho passa a **bloquear renomear ou
excluir um item que já tem alocação apontando para ele** — ou oferecer o remapeamento explícito.
Sem isso, mexer no plano órfã vínculos silenciosamente.

Se um dia o sistema for emitir cobrança, aí sim a tabela com id estável se justifica. Hoje seria
construir para um requisito que não existe.

### 2.2 Quem decide é quem aloca — o sistema sugere, nunca assume

Fora da correspondência exata, o sistema **nunca atribui sozinho**. Um mesmo contrato pode ter
dois portes do mesmo grupo — *100 h de 30T e 200 h de 23T* — e só quem aloca sabe qual serviço
aquela máquina vai fazer.

| | Situação | Comportamento |
|---|---|---|
| 1 | Subgrupo da máquina idêntico a um item, candidato único | vincula silencioso — **único caso automático** |
| 2 | Um único item do grupo da máquina | confirmação **com o item pré-selecionado** |
| 3 | Dois ou mais itens do grupo | confirmação **sem pré-seleção** — escolha obrigatória |
| 4 | Nenhum item do grupo | confirmação com a lista completa dos itens da obra |
| 5 | Obra sem plano cadastrado | aloca sem vínculo (`planoItemKey` nulo) |

A diferença entre 2 e 3 importa: pré-selecionar onde não há ambiguidade evita caça ao item;
**não** pré-selecionar onde há dois portes evita que o "confirmar" vire reflexo justamente onde a
escolha é real.

### 2.3 Sem fila de pendências

Alocação sem item — histórico ou nova em obra sem plano — **fica como está**. `planoItemKey` nulo
significa "comporta-se como sempre se comportou": a hora é classificada pelo subgrupo da máquina,
exatamente como hoje.

Sem backfill retroativo, sem tela de pendências, sem cobrança de regularização. O vínculo passa a
existir da implantação em diante e vai cobrindo a operação naturalmente, conforme as máquinas
forem sendo alocadas.

### 2.4 O apontamento carimba o item

O apontamento grava `planoItemKey` no momento em que é criado, copiando da alocação vigente. Sem
o carimbo, editar a alocação reescreveria o passado silenciosamente. Ao trocar o item de uma
alocação, perguntar *"aplicar também aos apontamentos já lançados?"* — nunca decidir sozinho.

### 2.5 Pontas soltas

- **Máquina que faz dois itens na mesma estadia: não acontece** (confirmado). Vínculo fixo por
  alocação, sem versionamento por data.
- **Item esgotado** — alocar mais uma máquina num item cujas horas estão acabando deve **avisar,
  não bloquear**: pode haver aditivo a caminho.
- **Realocação entre obras** resolve-se sozinha: obra nova, plano novo, alocação nova.

---

## 3. Correção manual dos subgrupos

Decisão tomada: os `sub_tipo` das 376 máquinas próprias serão preenchidos manualmente. Isso muda
o cenário de forma relevante — mas tem dois efeitos que precisam ser antecipados.

### 3.1 O caso silencioso passa a ser a regra

Hoje só 32 dos 477 veículos ativos têm `sub_tipo`, e **todos são de terceiros**. Por isso, na
implantação, quase toda alocação de máquina própria cairá em confirmação (caso 2). Conforme o
cadastro for preenchido, as alocações migram para o caso 1 e silenciam sozinhas.

Ou seja: **o atrito é máximo no início e decrescente**. Vale avisar a equipe, senão no primeiro
dia alguém reclama que "apareceu uma tela nova em tudo".

### 3.2 Atenção: preencher `sub_tipo` reclassifica o histórico

O consumo por subgrupo é calculado a partir do `sub_tipo` **atual** do veículo, não de um snapshot
da época do apontamento:

```sql
SELECT l.obraId, COALESCE(NULLIF(v.sub_tipo,''), v.tipo) AS subgrupo, SUM(l.totalHours)
FROM daily_work_logs l JOIN vehicles v ON v.id = l.vehicleId
```

Logo, ao classificar uma escavadeira como 23T, **todas as horas históricas dela migram** de
"Escavadeira" para "Escavadeira Hidráulica 23T", em todas as obras e períodos passados. Números
de Ficha da Obra, Aproveitamento e Panorama vão mudar retroativamente.

Para gestão interna isso é uma **correção**, não um problema — a classificação passa a refletir a
realidade. Mas é melhor saber antes de alguém perguntar por que o relatório do mês passado mudou.

Recomendação prática: preencher **por grupo inteiro de uma vez** (todas as escavadeiras, depois
todos os rolos), não máquina a máquina. O Panorama agrega no grupo enquanto houver uma máquina sem
`sub_tipo` — então preenchimento parcial não muda nada na tela, e o grupo "vira" de uma vez quando
o último for classificado. Menos oscilação, mudança previsível.

---

## 4. O que muda no Panorama de Capacidade

Com o cadastro corrigido, a regra atual — agregar no grupo quando falta `sub_tipo` — **se desliga
sozinha, grupo a grupo**, sem tocar em código. É por isso que ela foi escrita assim.

O que ainda precisa mudar, depois do vínculo existir:

- **consumo por item, não por máquina**: a query de consumo passa a usar o `planoItemKey` da
  alocação quando houver, caindo no subgrupo do veículo quando for nulo (o comportamento legado
  de 2.3);
- a linha do Panorama passa a mostrar, no drill-down, quando a demanda de um item está sendo
  atendida por máquina de outro porte — informação de gestão que hoje não existe em lugar nenhum.

`cobertura.gruposAgregadosPorCadastro` já expõe quais grupos ainda estão agregados, então dá para
acompanhar o avanço do cadastro pela própria tela.

---

## 5. Ordem de execução

| Fase | O quê |
|---|---|
| 1 | `obras_historico_veiculos.planoItemKey` + `daily_work_logs.planoItemKey` |
| 2 | Confirmação do item na tela de alocação (regras de 2.2) |
| 3 | Trava de renomear/excluir item do plano com alocação vinculada |
| 4 | Consumo e progresso passam a usar `planoItemKey`, com fallback legado |
| 5 | Panorama: drill-down mostrando atendimento por porte diferente |
| — | Correção manual dos `sub_tipo`, por grupo inteiro — em paralelo |

Sem urgência de receita: a ordem é ditada por dependência, não por perda.

---

## 6. Decisões tomadas (10/09/2026)

1. **Sem receita em jogo.** O contrato é cobrado integralmente; conferência é externa e manual.
   O objetivo é gestão interna correta, não faturamento.
2. **O sistema não emite cobrança** e ainda não tem confiabilidade para isso. Nada no plano
   assume o contrário.
3. **Sem fila de pendências.** Alocação sem item permanece como está, indefinidamente.
4. **Subgrupos serão corrigidos manualmente**, saindo do caminho crítico.
5. **Nunca atribuir item automaticamente** fora da correspondência exata — quem aloca aprova.
6. **Máquina não faz dois itens na mesma estadia** — vínculo fixo por alocação.
