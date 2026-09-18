# Fase 2 — TEC → StudyReader

Status: **arquitetura e contrato**. Nada deste documento está implementado.

Base: INDIO StudyReader V0.1 (tag `indio-studyreader-v0.1`), congelada. A Fase 2
não altera o plugin (`studyreader.koplugin`) nem o formato `.study` v1: ela
produz pacotes `.study` válidos que a V0.1 já sabe abrir.

## Objetivo

Automatizar o caminho:

```
TEC
→ Caderno de Erros
→ classificação/priorização
→ geração por IA
→ pacote .study
→ Galaxy Tab
→ StudyReader
→ revisão/SRS
```

Premissa central: **nem todo erro merece virar material.** O pipeline filtra,
agrupa e prioriza antes de gerar qualquer conteúdo.

## Visão geral do pipeline

```
[1 INGEST] → [2 DEDUPE] → [3 CLASSIFY] → [4 PRIORITIZE] → seleção
   → [5 GENERATE] → [6 NORMATIVE GATE] → [7 STUDY BUILD] → [8 DEPLOY]
   → tablet (offline) → [9 FEEDBACK] → volta para 4
```

Cada etapa recebe e devolve JSON em disco. Assim cada etapa pode ser
reexecutada, inspecionada e testada isoladamente, sem depender da anterior
estar online.

## 1. INGEST

Entrada: um erro vindo do TEC / Caderno de Erros.

Este repositório não contém schema de eventos do TEC nem do Caderno de Erros.
Os eventos atuais continuam como estão: **nenhum schema existente é alterado**.
A adaptação é feita por um *adapter* de leitura que converte o evento de origem
no formato canônico `ErrorEvent` abaixo. Campos ausentes na origem ficam
`null` e nunca são inventados.

`ErrorEvent` (canônico, interno ao pipeline):

| Campo | Tipo | Obrigatório | Observação |
| --- | --- | --- | --- |
| `eventId` | string | ✔ | Id do evento na origem; se não existir, hash do evento bruto. |
| `timestamp` | string ISO-8601 UTC | ✔ | Momento do erro. |
| `source` | string | ✔ | Ex.: `tec`, `caderno-de-erros`, `manual`. |
| `banca` | string \| null | | |
| `ano` | number \| null | | |
| `materia` | string | ✔ | |
| `assunto` | string \| null | | |
| `questionId` | string \| null | | Id da questão na origem (TEC). |
| `enunciado` | string | ✔ | |
| `alternativas` | `{ id, text }[]` | ✔ | ≥ 2. Ids preservados da origem (`a`…`e`, ou `certo`/`errado`). |
| `respostaMarcada` | string[] | ✔ | Ids marcados pelo aluno. |
| `respostaCorreta` | string[] | ✔ | Ids corretos. |
| `explicacaoOriginal` | string \| null | | Comentário/gabarito comentado da origem. |
| `recorrencia` | number | ✔ | Quantas vezes este erro/conceito já apareceu (≥ 1). |
| `notebookId` | string \| null | | Caderno de origem, quando existir. |
| `raw` | object | ✔ | Evento original intacto, para auditoria e reprocessamento. |

Regras:

- O adapter é puro: `evento de origem → ErrorEvent`. Não chama rede nem IA.
- `raw` é sempre preservado; o pipeline pode ser refeito a partir dele.
- Questões Certo/Errado (CEBRASPE) viram `alternativas` com ids `certo`/`errado`.
  No `.study` elas mapeiam direto para `single-choice` com 2 opções.

## 2. DEDUPE

Objetivo: não gerar duas revisões para o mesmo erro ou conceito.

Chaves, em ordem de preferência:

1. `questionId`: mesma questão errada de novo não gera material novo; só
   incrementa `recorrencia`.
2. `hash normalizado` do enunciado (minúsculas, sem acentos, sem pontuação e
   sem espaços repetidos): pega a mesma questão vinda de fontes diferentes.
3. `assunto` + `conceito`: questões diferentes sobre o mesmo conceito entram no
   mesmo **cluster**. O `conceito` vem da etapa 3; o dedupe por conceito
   roda depois da classificação.

Saída: clusters. Cada cluster tem uma `dedupeKey` estável, derivada de
`materia` + `conceito` normalizados, com fallback para `questionId` ou hash.

**A `dedupeKey` é a identidade do material.** Dela derivam os ids de aula,
questão e flashcard no `.study` (ver etapa 7). Isso é o que permite ao
StudyReader preservar progresso e SRS quando o pacote é regenerado.

## 3. CLASSIFICAÇÃO DO ERRO

Categorias iniciais (multi-rótulo: uma questão pode ter mais de uma):

| Categoria | Significado |
| --- | --- |
| `conceito` | Não entendeu o instituto/ideia. |
| `regra/norma` | Não sabia ou confundiu o texto normativo. |
| `interpretação` | Entendeu errado o que o enunciado pedia. |
| `distração` | Sabia, mas errou por desatenção. |
| `cálculo` | Erro de conta/procedimento. |
| `memória` | Sabia e esqueceu (prazos, números, listas). |
| `leitura` | Pulou palavra-chave (EXCETO, NÃO, SOMENTE…). |
| `desconhecimento` | Assunto nunca estudado. |
| `recorrente` | Derivada: `recorrencia ≥ 2` no cluster. |

A classificação pode vir de IA ou de marcação manual no Caderno de Erros.
Quando as duas existirem, a manual prevalece. A saída também registra o
`conceito` central do cluster (texto curto), usado pelo dedupe.

## 4. PRIORIDADE

Primeira heurística, **ainda não codificada**. O resultado é só uma faixa, não
um score com falsa precisão científica.

| Sinal | Peso |
| --- | --- |
| recorrência alta | +3 |
| assunto prioritário (edital/plano) | +3 |
| questão de banca-alvo | +2 |
| erro conceitual (`conceito` ou `regra/norma`) | +2 |
| erro recente | +1 |
| erro já dominado (ver feedback, etapa 9) | −2 |
| erro banal / distração isolada | −1 |

Faixas: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`. Os cortes numéricos entre as faixas
serão calibrados com dados reais na Fase 2C. A soma é só um meio interno; o que
sai da etapa é a faixa.

Regra de seleção inicial: `CRITICAL` e `HIGH` viram material. `MEDIUM` entra se
houver espaço no lote. `LOW` não vira material.

## 5. GERAÇÃO DE CONTEÚDO

Para cada cluster selecionado, a IA produz um **cartão de estudo curto**:

| Campo | Destino no `.study` |
| --- | --- |
| título | `lessons[].title` e `# título` da aula |
| mini-resumo | parágrafo inicial da aula |
| conceito central | seção da aula |
| por que errei | seção da aula (usa `respostaMarcada` × `respostaCorreta`) |
| pegadinha | seção da aula |
| regra de prova | seção da aula (1 linha, estilo "regra de bolso") |
| questão de recuperação | `questions/questions.json` + `{{quiz:<id>}}` na aula |
| flashcard | `flashcards/flashcards.json` + `{{flashcard:<id>}}` na aula |
| expansão opcional | seção final, só se agregar |

Restrições:

- O material deve ser curto: uma aula por cluster, legível em 2 a 3 minutos no tablet.
- **StudyReader não é depósito de PDFs.** Não se anexa material bruto,
  apostila ou PDF. Só conteúdo sintetizado em Markdown.
- A questão de recuperação é **nova**: testa o mesmo conceito, mas não copia a
  questão original errada.
- A saída da IA é JSON estruturado, validado antes de seguir. Saída inválida
  volta para a fila e não vira pacote.

## 6. GATE NORMATIVO

Quando o conteúdo envolver Constituição, lei, CTN, jurisprudência ou norma
oficial, o pipeline precisa permitir um **gate de fonte normativa** antes da
versão final.

Contrato (não implementar agora):

- Cada item gerado carrega `normativeRefs[]`, por exemplo
  `{ tipo: "CF", dispositivo: "art. 5º, XXXV" }`.
- Se `normativeRefs` não estiver vazio, o item fica `status: pending-source`
  até ser conferido contra o texto oficial vigente, manualmente ou por
  ferramenta de consulta normativa.
- Resultado do gate: `verified`, `corrected` ou `rejected`. Só `verified` e
  `corrected` seguem para o build.
- O resultado do gate fica registrado em `manifest.extensions.indio` (§9 da
  SPEC), para auditoria.

## 7. STUDY BUILD

Converte os itens aprovados para a estrutura `.study` v1 (ver
`packages/study-format/SPEC.md`):

```
manifest.json
content/*.md
questions/questions.json
flashcards/flashcards.json
```

Reuso: `buildStudy` de `@study-reader/study-format`, o mesmo usado por
`scripts/build-indio.mts` para gerar o `INDIO-FISCAL.study` validado.

### Identidade: decisão de arquitetura

O estado do aluno (`progress.json`, `answers.json`, `reviews.json`) é
indexado por **course `id`** e por **ids de aula, questão e card** (SPEC §7–8).
Portanto:

- **Nome do arquivo ≠ identidade.** O arquivo pode se chamar
  `INDIO-REVISAO-YYYY-MM-DD.study`, mas o `manifest.id` deve ser **estável**
  (ex.: `indio-revisao`), com `manifest.version` incrementado a cada build.
  Um `id` novo por dia fragmentaria o SRS e zeraria o progresso a cada pacote.
- Ids internos derivam da `dedupeKey`:
  - aula `L-<dedupeKey>`
  - questão `Q-<dedupeKey>-<n>`
  - card `C-<dedupeKey>-<n>`

  O mesmo conceito regenerado mantém os mesmos ids, e o histórico SRS
  sobrevive.
- Módulos: um por `materia`, ordenados pela maior prioridade dentro de cada um.
- Proveniência em `manifest.extensions.indio`: `eventIds` por aula, faixa de
  prioridade, resultado do gate e data do build. A V0.1 ignora campos
  desconhecidos (SPEC §3), então isso não exige mudança no plugin.

Saída: `INDIO-REVISAO-YYYY-MM-DD.study`, ou arquitetura equivalente que
respeite a regra de identidade acima.

## 8. DEPLOY

Objetivo futuro (**não automatizar nesta fase**):

```
PC → adb → Galaxy Tab → /sdcard/koreader/studyreader/courses/
```

Requisitos já conhecidos da V0.1:

- Selecionar o dispositivo explicitamente com `adb -s <serial>`, nunca o device
  implícito, porque emulador e tablet podem estar conectados ao mesmo tempo.
- Conferir SHA-256 local × dispositivo após o push.
- Nunca tocar em `/sdcard/koreader/studyreader/data/`: estado do aluno.
- Substituir o `.study` antigo com o mesmo `manifest.id` por um de `version`
  maior. O plugin re-extrai quando o arquivo muda.

## 9. FEEDBACK LOOP

O StudyReader gera, no tablet, por curso:

- `progress.json`: aulas concluídas e aula atual
- `answers.json`: resposta, acerto e data por questão
- `reviews.json`: estado SM-2 por card (`reps`, `lapses`, `ef`, `interval`, `due`)

Retorno futuro (Fase 2E): coletar esses arquivos (por exemplo `adb pull`, só
leitura) e mapear cada id de volta para a `dedupeKey`, graças à convenção de
ids da etapa 7. Os sinais alimentam a etapa 4:

| Sinal observado | Efeito na prioridade |
| --- | --- |
| errou novamente a questão de recuperação | sobe |
| `lapses` crescente no card | sobe |
| acertou repetidamente / `reps` alto | cai |
| `interval` SRS crescente (ex.: ≥ 21 dias) | conceito tende a sair do ciclo intensivo |
| novo erro no TEC do mesmo cluster | sobe e reabre o cluster |

O feedback nunca edita o `.study` (ele é imutável). Ele muda a prioridade, e o
próximo build reflete isso.

## 10. OFFLINE FIRST

Princípio obrigatório. Depois que o `.study` estiver no tablet, estas funções
operam **sem IA e sem internet**:

- aula
- quiz
- flashcards
- SRS
- progresso

A IA atua na **construção e atualização** do material (etapas 3, 5 e,
opcionalmente, 6), nunca em cada revisão. A V0.1 já garante isso: todo o
runtime é local ao KOReader.

## MVP PHASE 2A

Provar: **erro estruturado → `.study` válido.** Sem TEC, sem IA obrigatória,
sem priorização e sem deploy automático.

Input: um JSON local representando **1 erro real**, no formato `ErrorEvent`
(etapa 1).

Processamento:

```
JSON
→ transformação
→ 1 módulo
→ 1 aula
→ 1 quiz
→ 1 flashcard
→ .study
```

Output: `INDIO-ERROR-TEST.study`

Critério de aceite:

- O pacote passa na validação do `@study-reader/study-format` (schemas de
  manifest, questions e flashcards).
- Os ids seguem a convenção da etapa 7, derivados da `dedupeKey`.
- O arquivo **abre no StudyReader validado** (V0.1, KOReader v2026.07.1): o
  curso aparece em My courses, a aula renderiza, o quiz responde e o flashcard
  entra em Reviews.
- Reconstruir a partir do mesmo JSON gera os mesmos ids (build determinístico
  quanto à identidade).

Fora do escopo do 2A: integração direta com TEC, classificação por IA,
priorização, gate normativo e deploy automático.

## Sequência das fases

| Fase | Entrega |
| --- | --- |
| **2A** | JSON de 1 erro → `.study` válido |
| 2B | Caderno de Erros → builder (adapter de ingest + dedupe) |
| 2C | Priorização (heurística da etapa 4 calibrada com dados reais) |
| 2D | Deploy automático via `adb -s` com verificação de hash |
| 2E | Feedback SRS → inteligência (etapa 9) |
