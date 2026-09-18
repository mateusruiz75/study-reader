# INDIO StudyReader V0.1 — VALIDATED

## Status

VALIDATED — 2026-09-18

Base validada: branch `indio/windows-path-fix`, commit `85ae7ca`.

## Plataformas validadas

- Windows host (Windows 11, pnpm 10.29.3, Node 22)
- Android Emulator API 30 (Android 11, x86)
- Samsung Galaxy Tab S9 FE físico (SM-X516B, arm64-v8a, serial `RX2X…891H`)
- Android 16 / SDK 36
- KOReader v2026.07.1 (APK oficial da release `koreader/koreader`, digest SHA-256 conferido)

## Funcionalidades validadas

Validadas na interface real (emulador e tablet físico), salvo indicação:

- plugin discovery (`<data_dir>/plugins/studyreader.koplugin`, sem configuração manual)
- Study menu (FileManager e Reader, aba Ferramentas)
- My courses
- Continue studying — entrada presente no menu; fluxo (`last.json` → reabrir última aula) não exercitado manualmente
- Reviews (contagem de pendentes 2 → 1 → 0)
- course discovery (`/sdcard/koreader/studyreader/courses/`)
- modules
- lessons
- Markdown rendering (títulos, listas, negrito, blocos de quiz/flashcard, CTAs inline)
- quiz
- resposta correta ("Correct!", score 1/1)
- resposta incorreta ("Incorrect", alternativa correta indicada)
- explicação
- flashcards (frente, "Show answer", verso)
- Again — exercitado na UI (lapses=1, reagendado em 10 min)
- Hard — exibido na UI; não exercitado
- Good — exercitado na UI (intervalo 1 dia)
- Easy — exibido na UI; coberto pelo teste Lua `srs schedules SM-2 intervals`
- SM-2/SRS (card agendado não reaparece antes do vencimento)
- progress
- lesson completion (✓ e contagem de questões 1/1)
- module completion (100%)
- course completion (100%)
- restart persistence

## Persistência

Arquivos, em `/sdcard/koreader/studyreader/data/indio-fiscal-erros/`:

```
progress.json
answers.json
reviews.json
```

Resultado: persistência confirmada após force-stop e restart do KOReader.
SHA-256 idênticos antes e depois do restart no tablet físico:

| Arquivo | SHA-256 (prefixo) |
| --- | --- |
| progress.json | `05375d6b…` |
| answers.json | `a403feb8…` |
| reviews.json | `da2aba51…` |

A UI refletiu o estado persistido após o restart (curso 100%, módulos 100%,
aulas com ✓, Reviews 0 due).

## Testes

Lua syntax (container Ubuntu 24.04, LuaJIT 2.1.1703358377):
9/9 PASS

Lua tests (`luajit tests/run.lua`):
7/7 PASS

Os dois testes de regressão novos falham contra `origin/main` anterior e passam
com as correções:

- `main registers itself in the KOReader main menu`
- `state treats timestamped lessons as completed`

study-format (`pnpm study-format:check` + `pnpm study-format:test`):
10/10 PASS

converter (`pnpm converter:check` + `pnpm converter:test`):
3/3 PASS

## Bugs encontrados e corrigidos

1. Windows path separator em arquivos .study — `cb759f8`
2. absolute path perdido no state storage — `bf8036d`
3. plugin não registrado no main menu do KOReader — `96f1986`
4. ícone de voltar inexistente (`appbar.chevron.left` → `chevron.left`) — `b14e892`
5. completedLesson não reconhecia timestamp como conclusão — `85ae7ca`

As correções 1–5 foram propostas upstream em
<https://github.com/lunaperegrina/study-reader/pull/1>.

## Curso de validação

ÍNDIO FISCAL — Livro de Erros (`examples/INDIO-FISCAL.study`, 2982 bytes,
id `indio-fiscal-erros`)

- Direito Constitucional
- Administração

Conteúdo: 2 aulas, 2 questões, 2 flashcards.

## Limitações conhecidas

Nenhuma bloqueia a V0.1.

- quiz "Back to course" volta para a aula atual, não para o menu do curso
- overlay de quiz/review ainda pode mostrar a barra de progresso do leitor no rodapé
- interface do plugin ainda em inglês
- upstream CI aguardando autorização da maintainer (run `action_required`)
