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
- Ids internos derivam da `dedupeKey` (convenção implementada na Fase 2A):
  - aula `error-<dedupeKey>` (arquivo `content/error-<dedupeKey>.md`)
  - questão `<dedupeKey>-recovery`
  - card `<dedupeKey>-card`
  - módulo: slug da `materia`

  O mesmo conceito regenerado mantém os mesmos ids, e o histórico SRS
  sobrevive.
- Módulos: um por `materia`, ordenados pela maior prioridade dentro de cada um.
- Proveniência em `manifest.extensions.indio`: `eventIds` por aula, faixa de
  prioridade, resultado do gate e data do build. A V0.1 ignora campos
  desconhecidos (SPEC §3), então isso não exige mudança no plugin.

Saída: `INDIO-REVISAO-YYYY-MM-DD.study`, ou arquitetura equivalente que
respeite a regra de identidade acima.

## 8. DEPLOY

Implementado na PHASE 2D (abaixo). Requisitos originais:

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

### Implementação (2A)

| Peça | Caminho |
| --- | --- |
| Fixture `ErrorEvent` (erro real `adm-podc-q1`) | `examples/phase2a/adm-podc-error.json` |
| Transformação pura + schema zod | `packages/study-format/scripts/error-event.ts` |
| CLI | `packages/study-format/scripts/build-error-event.mts` |
| Testes | `packages/study-format/tests/error-event.test.ts` |

Comando (na raiz do repo):

```
pnpm study:error-example
```

Equivalente a:

```
node packages/study-format/scripts/build-error-event.mts examples/phase2a/adm-podc-error.json examples/INDIO-ERROR-TEST.study
```

A CLI valida o `ErrorEvent`, gera o pacote, relê o pacote com `readStudy` e
roda `validateCrossReferences`. Se houver referência quebrada ou path com `\`,
ela falha antes de gravar.

Determinismo: mesmo input → mesmos ids e mesmo conteúdo de cada arquivo
interno. O hash do ZIP muda entre execuções porque `buildStudy` grava o
horário corrente como mtime de cada entrada. É equivalência lógica, não
byte-a-byte.

## PHASE 2B — Caderno de Erros → INDIO REVISÃO

Fonte real: o ledger do projection `obsidian-error-notebook-v1`, fonte
canônica do Caderno de Erros. As notas `.md` do caderno são projeções
derivadas dele. Fica em
`<vault>/99 - Sistema/Eventos/Checkpoints/obsidian-error-notebook-v1/ledger.json`:
um array JSON de eventos `knowledge.error_recorded` e
`knowledge.answer_recorded`. O builder só **lê** o ledger; nenhum dado dele é
versionado neste repositório.

Mapeamento (`packages/study-format/scripts/adapters/error-notebook-ledger.ts`):

| Ledger | `ErrorEvent` |
| --- | --- |
| `eventId` | `eventId` |
| `occurredAt` | `timestamp` |
| — | `source: "tec"` |
| `materia` / `assunto` | `materia` / `assunto` |
| `questionId` | `questionId` |
| `content.statement` | `enunciado` |
| `content.alternatives[].label/text` | `alternativas[].id/text` |
| `respostaUsuario` | `respostaMarcada` |
| `content.correctAnswer` | `respostaCorreta` |
| nº de `error_recorded` do mesmo `questionId` | `recorrencia` |
| entrada original | `raw` |
| inexistente no ledger | `banca`, `ano`, `notebookId`, `explicacaoOriginal` = `null` |

Regras:

- Só `knowledge.error_recorded` com `content` completo (enunciado, ≥ 2
  alternativas, gabarito) vira `ErrorEvent`. O resto é contado e descartado.
- Dedupe determinístico por `questionId`: fica a ocorrência mais recente
  (`occurredAt`, desempate por `eventId`). `recorrencia` conta todas as
  ocorrências de erro, inclusive as sem conteúdo.
- Lote técnico da 2B (matérias em ordem alfabética, 2 por matéria, 10 no
  total) foi substituído pela priorização da 2C.
- Curso: `manifest.id = indio-revisao`, título "ÍNDIO REVISÃO — Livro de
  Erros". Um módulo por matéria e uma aula, um quiz e um flashcard por erro,
  todos via `buildErrorLesson()` da 2A. Os ids derivam do `questionId`.
  `version` é explícita (`--version`, padrão 1), para o build ser
  determinístico.

Comando:

```
INDIO_LEDGER="<vault>/99 - Sistema/Eventos/Checkpoints/obsidian-error-notebook-v1/ledger.json" pnpm study:build-review
```

ou `pnpm study:build-review <ledger.json> [output.study] [--limit 30] [--max-per-materia 6] [--version 1]`
(flags completas na 2C). Saída padrão: `examples/INDIO-REVISAO.study`,
ignorado pelo git.

Os testes (`tests/review-course.test.ts`) usam uma fixture no formato do ledger
montada com as questões já versionadas em `courses/indio-fiscal` e uma entrada
sintética explicitamente marcada.

## PHASE 2C — Prioridade do Caderno de Erros

Substitui o lote técnico da 2B por uma priorização determinística, sem LLM e
sem dados inventados. Pipeline:

```
ledger → adapter (ErrorEvent[] + AttemptRecord[]) → dedupe → PriorityFeatures
→ banda + reasons → ordenação → seleção balanceada → INDIO-REVISAO.study
```

Código: `packages/study-format/scripts/review-priority.ts`; testes em
`tests/review-priority.test.ts` (fixtures sintéticas).

### O que o ledger permite derivar

O adapter extrai **todo** o histórico de cada `questionId` como
`AttemptRecord { result: "error" | "correct" | "unknown" }`:

| Evento | Resultado |
| --- | --- |
| `knowledge.error_recorded` | `error` (com ou sem `content`) |
| `knowledge.answer_recorded` com `content.correctAnswer` | comparação com `respostaUsuario` |
| `knowledge.answer_recorded` com `sourceEventId` `desempenho:<id>_acertou:` / `_errou:` | `correct` / `error` |
| `knowledge.answer_recorded` sem nenhum dos dois | `unknown` — não conta como acerto |

Só questões com pelo menos um `error_recorded` com `content` viram aula (regra
da 2B), mas as features usam o histórico completo, inclusive erros e acertos
sem `content`.

`PriorityFeatures` por questão: `errorCount`, `attemptCount`, `correctCount`,
`unknownCount`, `firstErrorAt`, `lastErrorAt`, `lastAttemptAt`,
`latestResult`, `correctAfterLastError` (acertos consecutivos após o último
erro), `errorsAfterCorrect` (erros precedidos por algum acerto),
`daysSinceLastError`, `recurrence` (`errorCount >= 2`), `wrongAnswerPattern`
(`repeated` / `varied` / `null` se erro único) e `asOf`.

`asOf` é o `occurredAt` mais recente do ledger (sobrescritível com `--as-of`),
nunca `Date.now()`: o mesmo ledger produz sempre a mesma classificação.

### Bandas

Flags derivadas: `recent` = último erro há ≤ 7 dias; `old` = > 21 dias;
`relapsed` = recorrente **e** `errorsAfterCorrect > 0`; `recovered` =
`correctAfterLastError >= 2` (ou `>= 3` se já houve recaída — uma questão que
já oscilou precisa de mais evidência).

Primeira regra que casa, de cima para baixo:

| Banda | Regra | Condição |
| --- | --- | --- |
| CRITICAL | `relapse-unrecovered` | `relapsed && !recovered` |
| CRITICAL | `many-recent-errors` | `errorCount >= 3 && recent` |
| HIGH | `recurrent-unrecovered` | `recurrence && !recovered` |
| HIGH | `recurrent-recent` | `recurrence && recent` |
| MEDIUM | `unrecovered` | `correctAfterLastError == 0` (erro isolado nunca recuperado, qualquer idade) |
| MEDIUM / LOW | `partially-recovered` | 1 acerto após o erro: MEDIUM se não for `old`, LOW se for |
| MEDIUM | `recovered-recent` | recuperado, mas `recent` |
| LOW | `recovered` | recuperação consistente e erro não recente |

Um erro único após um acerto (`correct → error`) não é recaída: a regra exige
recorrência.

### Reasons

Cada item carrega `reasons`: a frase da regra aplicada seguida dos fatos
(`"N erros registrados"`, `"último erro há N dias"`, `"N erros após acerto"`,
`"N acertos após o último erro"` / `"nenhum acerto após o último erro"`,
`"N tentativas com resultado desconhecido"`, padrão da alternativa errada).
Nenhum texto é gerado por IA. Com profile, acrescenta
`"matéria priorizada no perfil"`.

### Profile (opcional)

`--profile profile.json` com `{ "materiaBoosts": { "<matéria>": 1 } }`
(valores 0 ou 1). O boost só desempata **dentro da mesma banda**; não altera
features nem bandas. Sem profile, todos os boosts são 0.

### Ordenação e seleção

Ordem total, determinística: banda → boost → `errorCount` desc →
`errorsAfterCorrect` desc → `correctAfterLastError` asc → `lastErrorAt` desc →
`questionId`.

`selectBalanced(items, { limit, maxPerMateria })` respeita o invariante
**CRITICAL sempre precede HIGH/MEDIUM/LOW**; `max-per-materia` nunca tira a
vaga de um CRITICAL para uma banda inferior:

1. Se `#CRITICAL <= limit`: todos os CRITICAL entram, mesmo que uma matéria
   ultrapasse a cota. As vagas restantes são preenchidas em ordem
   (HIGH → MEDIUM → LOW) aplicando `max-per-materia` normalmente — a cota conta
   os CRITICAL já incluídos, então uma matéria que estourou por CRITICAL não
   recebe banda inferior.
2. Se `#CRITICAL > limit`: só CRITICAL entram. A cota atua apenas como
   balanceamento entre eles (primeira passada respeitando a cota, segunda
   passada preenchendo o restante na ordem determinística); nenhuma banda
   inferior entra.

Cada rejeição registra `rejectedBecause: "max-per-materia" | "limit"`. A lista
`selected` mantém a ordem global de prioridade.

### Curso

`manifest.id` continua `indio-revisao`; ids de aula/quiz/flashcard continuam
derivados do `questionId` (`error-<id>`, `<id>-recovery`, `<id>-card`), então
mudar a prioridade não reseta progresso nem SRS. Módulos por matéria em ordem
alfabética; aulas dentro do módulo em ordem de prioridade. A aula ganha uma
seção `### Prioridade` com a banda e as reasons.

`extensions.indio`: `phase: "2C"`, `dedupeKeys`, `eventIds`, `priorityAsOf` e
`priorities[<dedupeKey>]` com `priority`, `rule`, `priorityReasons`,
`recurrence`, `errorCount`, `attemptCount`, `correctAfterLastError`,
`errorsAfterCorrect`, `lastErrorAt`, `daysSinceLastError`, `latestResult`,
`wrongAnswerPattern`. Sem timestamp de build.

### CLI

```
INDIO_LEDGER="<vault>/.../obsidian-error-notebook-v1/ledger.json" pnpm study:build-review --limit 30 --max-per-materia 6   [--as-of 2026-09-17T00:00:00Z] [--profile profile.json]   [--priority-report report.md] [--version 1]
```

`--priority-report` grava uma tabela com `questionId`, matéria, banda, regra,
`selected YES/NO (motivo)` e reasons de **todas** as questões analisadas. O
relatório contém dados reais: não versionar.

## PHASE 2D — Safe auto deploy

`pnpm study:deploy-review -- --serial <serial> [--dry-run] [--restart-koreader]`
(`packages/study-format/scripts/deploy-review.mts`; lógica pura testável em
`scripts/deploy-review.ts`, testes em `tests/deploy-review.test.ts` com adb
mockado). Variáveis: `INDIO_LEDGER`, `INDIO_TABLET_SERIAL`, `ADB` (caminho do
`adb.exe`). O builder é o mesmo da 2C.1 (`scripts/review-pipeline.ts`,
`--limit 30 --max-per-materia 6` por padrão).

Fluxo, todo fail-closed (qualquer falha aborta antes de substituir):

1. `--serial` obrigatório; `adb devices -l` precisa listar o serial em estado
   `device`. Todo comando seguinte usa `adb -s <serial>`.
2. Destino fixo `/sdcard/koreader/studyreader/courses/INDIO-REVISAO.study`;
   o diretório precisa existir. Nada mais em `courses/` ou `data/` é tocado.
3. Se já existe arquivo remoto: `sha256sum`, `adb pull`, conferência do hash,
   leitura do `manifest` (id precisa ser `indio-revisao`) e da `version`.
4. Build determinístico (`buildStableStudy`: mtime fixo = `priorityAsOf`)
   com `version` = versão remota. Se o SHA-256 bater **ou** o conteúdo lógico
   (todos os arquivos, ignorando `manifest.version`) for idêntico → `NO CHANGE`,
   sem push, sem backup, sem restart.
5. Caso contrário, rebuild com `version` = remota + 1 — o plugin só re-extrai
   o cache quando a versão muda — e validação: `readStudy`,
   `validateCrossReferences`, `manifest.id`, nº de aulas esperado, ids de
   aula/módulo/flashcard sem duplicata, paths portáveis.
6. `--dry-run` para aqui: mostra device, destino, hashes, versões e se haveria
   deploy. Sem push, sem backup, sem restart.
7. Backup do arquivo atual em `.indio-virtual/deploy-backups/<UTC stamp>/`
   (`INDIO-REVISAO.study` + `meta.json` com serial, sha256, tamanho,
   `manifest.version`). `.indio-virtual/` está no `.gitignore`.
8. Hashes de `data/indio-revisao/{progress,answers,reviews}.json` antes.
9. `adb push` para `INDIO-REVISAO.study.tmp`, `sha256sum` remoto; se diferir,
   `rm` do temporário e abort (arquivo anterior intacto).
10. `mv .tmp → .study` (rename no mesmo diretório), `touch` (invalida o cache
    em memória do plugin, que é por mtime) e `sha256sum` final == local.
11. Hashes de estado depois; qualquer diferença aborta com erro.
12. `--restart-koreader`: `am force-stop org.koreader.launcher` +
    `monkey -p org.koreader.launcher -c android.intent.category.LAUNCHER 1`,
    só após `DEPLOYED` (nunca em `NO CHANGE` ou dry-run).

Observação: `adb pull` sem `-a` não preserva mtime, e `adb push` no Windows
grava mtime com deslocamento de fuso; por isso o `touch` após o rename.

## PHASE 2E — StudyReader feedback loop

Fecha o primeiro ciclo: o estado que o plugin grava no tablet volta como
**fonte adicional de sinais**, read-only. Nada é escrito no ledger, no TEC, no
Caderno de Erros ou no tablet; nenhum `knowledge.answer_recorded` é publicado.

### Schema real (`/sdcard/koreader/studyreader/data/indio-revisao/`)

| Arquivo | Conteúdo real | Sinais |
| --- | --- | --- |
| `progress.json` | `{ currentLesson, completedLessons: { "error-<qid>": ISO \| true } }` | aula concluída, `completedAt` (`null` se legado `true`) |
| `answers.json` | `{ "<qid>-recovery": { selected[], correct, answeredAt } }` — só a **última** resposta | quiz respondido/acertou/selecionada/quando |
| `reviews.json` | `{ "<qid>-card": { reps, lapses, ef, interval (dias), due (epoch s) } }` | reps, lapses, ease, intervalo, due |

NOT AVAILABLE: timestamp da última revisão, histórico de revisões (`reps`
zera no lapse).

### Mapeamento de ids (`scripts/study-feedback.ts`)

`questionKeyFromLessonId("error-<k>")`, `questionKeyFromQuizId("<k>-recovery")`,
`questionKeyFromCardId("<k>-card")` → `k` = `dedupeKey` (igual ao `questionId`
do TEC). Ids fora do padrão vão para `unknownIds` e nunca são atribuídos.

### Snapshot (`pnpm study:sync-feedback -- --serial <serial>`)

`scripts/sync-feedback.ts`: `adb devices -l` → `-s <serial>` em tudo → `ls -d`
do diretório → `sha256sum` dos 3 arquivos → `adb pull` → `sha256sum` de novo.
Se algum hash mudou (ou o arquivo puxado não bate), tenta mais 1 vez; se mudar
de novo: `STATE CHANGED DURING SNAPSHOT`, sem gravar `snapshots/` nem
`latest/`. Só `shell ls`, `shell sha256sum` e `pull` — nenhuma escrita no
device. Saída em `.indio-virtual/study-feedback/snapshots/<UTC stamp>/` e
`latest/`: os 3 JSONs originais + `metadata.json` (serial, `courseId`,
`remoteDir`, `collectedAt`, `collectedAtEpoch`, hashes e tamanhos).

### `StudyFeedback` (namespace separado de `PriorityFeatures`)

`questionKey, lessonCompleted, lessonCompletedAt, quizAnswered, quizCorrect,
quizSelected, quizAnsweredAt, reviewReps, reviewLapses, reviewInterval,
reviewEase, reviewDueAt` — ausência é `null`/`false`. Nenhum campo do ledger
(`errorCount`, `attemptCount`, `recurrence`, recaída, recuperação) é tocado:
uma resposta no StudyReader **não** é uma tentativa no TEC.

### Study signal (avaliado em `now` = `collectedAtEpoch` do snapshot)

| Sinal | Regra (primeira que casa) |
| --- | --- |
| `LAPSING` | card com `reps == 0 && lapses > 0` (em reaprendizado) **ou** último quiz errado |
| `DUE` | card com `due <= now` |
| `STABLE` | card com `reps >= 3` (≥ 16 dias de intervalo no SM-2 do plugin) |
| `LEARNING` | qualquer outro sinal (card curto, quiz certo, aula concluída) |
| `UNSEEN` | nenhum registro |

Sem feedback, todo item é tratado como `UNSEEN`.

### Ordem exata dentro da banda

1. banda (`CRITICAL > HIGH > MEDIUM > LOW`) — **só do ledger, inalterada**
2. study signal: `LAPSING → DUE → UNSEEN → LEARNING → STABLE`
3. `materiaBoosts` do profile
4. `errorCount` desc → `errorsAfterCorrect` desc → `correctAfterLastError` asc
5. `lastErrorAt` desc
6. `questionId`

Sem feedback o passo 2 é neutro e o resultado é idêntico à 2C.1.

### Build e report

`pnpm study:build-review -- ... --feedback .indio-virtual/study-feedback/latest`.
As reasons do ledger vêm primeiro; as do StudyReader vêm depois, sempre com
prefixo `StudyReader:` (`"1 lapse no card"`, `"card due"`,
`"quiz errado (C)"`, `"2 revisões concluídas"`, `"aula concluída"`). O
priority report ganha `studySignal`, `quizCorrect`, `reviewReps`,
`reviewLapses`, `reviewInterval`, `reviewDue`. `extensions.indio.priorities[k].study`
carrega o sinal e os campos usados; `phase` passa a `"2E"`.

Feedback de questões fora das 30 atuais fica no store e volta a contar quando
a questão disputar seleção.

## Sequência das fases

| Fase | Entrega |
| --- | --- |
| **2A** | JSON de 1 erro → `.study` válido |
| 2B | Caderno de Erros → builder (adapter de ingest + dedupe) |
| **2C** | Priorização determinística (bandas, recaída/recuperação, seleção balanceada) |
| **2D** | Deploy seguro via `adb -s` (dry-run, backup, temp + rename, SHA-256, NO CHANGE) |
| **2E** | Feedback do StudyReader (read-only) como desempate dentro da banda |
