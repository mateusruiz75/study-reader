# @study-reader/koreader-plugin

`studyreader.koplugin` — the KOReader runtime for [`.study`](../study-format/SPEC.md)
courses. Turns a KOReader device (Kindle, Kobo, PocketBook…) into a study reader:

- **My courses** — scans a `study/` folder for `.study` packages
- **Read lessons** — Markdown is rendered to XHTML and displayed by crengine
  with full formatting (bold, tables, diagrams)
- **Quizzes** — single/multiple choice with explanations, answers persisted locally
- **Flashcards** — SM-2 spaced repetition (Again / Hard / Good / Easy)
- **Progress** — completed lessons, continue studying, per-course percentages

Everything runs offline. The `.study` package is never modified: user state
lives under `<koreader-data>/studyreader/data/<course-id>/`.

## Layout

```
plugin/studyreader.koplugin/
  _meta.lua      plugin metadata (name/description for the plugin loader)
  main.lua       WidgetContainer + main-menu wiring ("Study" entry)
  store.lua      course discovery, .study (ZIP) reading via ffi/archiver, lesson rendering
  md2xhtml.lua   Markdown subset → standalone XHTML for crengine
  present.lua    pure presentation layer: menu item texts, [PRIORITY]/[SIGNAL]
                 badges and the lesson review panel (no KOReader deps)
  screens.lua    My courses / course / module menus and navigation flows
  quiz.lua       quiz widget (single/multiple choice + feedback)
  review.lua     flashcard review widget (SM-2 grading)
  srs.lua        SM-2 scheduler
  state.lua      progress/answers/reviews JSON state
tests/run.lua    standalone luajit tests for the pure modules
deploy.sh        SSH deploy to a device
```

## Visual layer

Menus are KOReader `Menu` widgets, so item text is a single flowing string
(the widget strips newlines). The presentation rules live in `present.lua`:

- My courses: `title — done/total aulas · N reviews · status`, `%` on the right
  (dimmed at 100%), the last studied course in bold, a subtitle with the
  totals.
- Course: subtitle with modules/lessons/quizzes/reviews; `Reviews — …` in bold
  when something is due; one row per module with progress and the priority
  counts read from `manifest.extensions.indio.priorities`.
- Module: `✓`/`○` + `[CRITICAL|HIGH|MEDIUM|LOW]` + `[LAPSING|DUE|LEARNING|STABLE]`
  (`UNSEEN` is the default and is not badged in lists) + title + `erro há N dias`;
  the right column shows `✓ 1/1`, `✗ 1/1` or a dimmed `0/1` from the quiz state.
- Lesson: `store.renderLesson` prepends a review panel (`Present.lessonPanel`)
  with materia · Qid, assunto, badges, statement, marked answer (struck
  through), correct answer (bold) and the priority reasons, and skips the
  markdown sections it replaces (`O erro`, `Prioridade`). Rendered pages are
  cached per `RENDER_LAYOUT`; bump it when the layout changes.

- Quiz: header with materia · Qid, badges and `Questão X / Y`; alternatives
  are `OptionButton`s (frame + wrapped `TextBoxWidget`, selection and keyboard
  focus invert the frame — no colour, no font shrinking, no truncation);
  feedback shows `✓ CORRETO` / `✗ INCORRETO`, then `VOCÊ MARCOU` /
  `RESPOSTA CORRETA` with the full option texts and `EXPLICAÇÃO` only when the
  question has one; the summary shows the score, the percent and
  `✓ Aula concluída` when the lesson was marked done.
- Flashcards: materia · Qid and badges when the card maps to a lesson,
  `PERGUNTA` on the front, `PERGUNTA` + `RESPOSTA` on the back and the four
  SM-2 ratings (`Again · Hard · Good · Easy`) in one row.

Everything shown comes from the package manifest and the student state —
nothing is inferred. Grading, persistence and the SRS scheduler are untouched
by the presentation layer.

## Deploy to a device

Requires SSH access to the device (on Kindle: USBNetwork / KUAL).

```sh
STUDYREADER_HOST=root@192.168.1.50 pnpm plugin:deploy
```

Copies the plugin to `/mnt/us/koreader/plugins/studyreader.koplugin/`, ships any
`examples/*.study` to `/mnt/us/documents/study/`, and restarts KOReader. See
[docs/DEVELOPING.md](docs/DEVELOPING.md) for variables and the dev loop.

## Tests

```sh
pnpm plugin:test    # luajit tests/run.lua (pure modules)
pnpm plugin:check   # luajit syntax check of all plugin files
```
