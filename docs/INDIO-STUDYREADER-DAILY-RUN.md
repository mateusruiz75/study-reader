# INDIO StudyReader — Daily Run

Rotina diária de produção (Windows) que fecha o ciclo Caderno de Erros →
prioridade → `INDIO-REVISAO.study` → Galaxy Tab → feedback do StudyReader.

## O que roda

`scripts/refresh-indio-review.ps1` → `pnpm study:refresh-review -- --serial <serial> --allow-device-offline`

Ordem (Phase 3): lock → device → sync read-only do feedback → ledger →
prioridade (2C.1 + feedback 2E) → build → validação → comparação com o tablet
→ backup + deploy atômico só se mudou → report. Nada é escrito no ledger, no
TEC, no Caderno de Erros nem no estado do aluno no tablet.

## Configuração (nunca versionada)

Variáveis de ambiente `INDIO_LEDGER`, `INDIO_TABLET_SERIAL`, `ADB` **ou** o
arquivo local `.indio-virtual/daily-refresh.json`:

```json
{ "ledger": "<caminho do ledger.json>", "serial": "<serial adb>", "adb": "<caminho do adb.exe>" }
```

Sem ledger ou serial configurados o wrapper falha com mensagem clara
(`exit 1`) e não toca em nada.

## Execução manual

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-indio-review.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-indio-review.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-indio-review.ps1 -RestartKoreader
```

Ou direto: `pnpm study:refresh-review -- --serial <serial> [--dry-run] [--restart-koreader] [--allow-device-offline]`.

## Tarefa agendada

- nome: **INDIO StudyReader Daily Refresh**
- horário: **06:00** (hora local do Windows), diariamente, `StartWhenAvailable`
- usuário atual, sem senha armazenada (S4U se permitido, senão Interactive —
  roda quando o usuário está logado), janela oculta
- uma instância por vez (`MultipleInstances = IgnoreNew`), limite de 1 h
- working directory = raiz do repositório

```
scripts\install-daily-refresh-task.ps1            # instala ou verifica (idempotente)
scripts\install-daily-refresh-task.ps1 -Show      # mostra estado, última/próxima execução
scripts\install-daily-refresh-task.ps1 -RunNow    # instala/verifica e dispara agora
scripts\install-daily-refresh-task.ps1 -Uninstall # remove a tarefa
```

Desabilitar sem remover: `Disable-ScheduledTask -TaskName "INDIO StudyReader Daily Refresh"`
(reativar com `Enable-ScheduledTask`). Disparar pelo agendador:
`Start-ScheduledTask -TaskName "INDIO StudyReader Daily Refresh"`.

## Estados e exit codes

| Estado | Significado | Exit |
| --- | --- | --- |
| `DEPLOYED` | livro mudou; backup + deploy atômico verificados por SHA-256 | 0 |
| `NO_CHANGE` | livro idêntico ao do tablet; nada tocado | 0 |
| `DRY_RUN` | só `-DryRun`: relata `WOULD DEPLOY` / `NO CHANGE` | 0 |
| `SKIPPED_DEVICE_OFFLINE` | tablet ausente/não autorizado: nada sincronizado, buildado ou deployado | 3 |
| `FAILED` | abort fail-closed (ledger ausente, snapshot inconsistente, pacote inválido, SHA divergente, estado alterado, lock ativo) | 2 (1 = configuração) |

O tablet offline nunca usa snapshot antigo: sem feedback atual não há build.

## Logs e relatórios

- log operacional: `.indio-virtual/logs/daily-refresh/YYYY-MM-DD_HH-mm-ss.log`
  (início, device, resultado, report, exit code, duração; sem conteúdo de questões)
- relatório por execução: `.indio-virtual/daily-refresh/<runId>/report.{json,md}` e `latest.json`
- snapshots do feedback: `.indio-virtual/study-feedback/{latest,snapshots/<ts>}/`
- backups do `.study` substituído: `.indio-virtual/deploy-backups/<ts>/`
- lock: `.indio-virtual/locks/refresh-review.lock` (stale após 6 h)

`.indio-virtual/` está no `.gitignore`.

## Restrições

A automação não desbloqueia o tablet, não contorna o keyguard, não liga
wireless debugging e não altera nada de segurança Android. Se o adb não
enxerga o device: `SKIPPED_DEVICE_OFFLINE`.
