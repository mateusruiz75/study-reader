<#
.SYNOPSIS
  Daily INDIO review refresh wrapper (Windows).

.DESCRIPTION
  Runs `pnpm study:refresh-review` in production mode and writes an operational
  log under .indio-virtual/logs/daily-refresh/. Configuration comes from
  environment variables (INDIO_LEDGER, INDIO_TABLET_SERIAL, ADB) or from the
  local, git-ignored file .indio-virtual/daily-refresh.json:

    { "ledger": "<path to ledger.json>", "serial": "<adb serial>", "adb": "<path to adb.exe>" }

  Exit codes: 0 DEPLOYED/NO_CHANGE/DRY_RUN · 3 SKIPPED_DEVICE_OFFLINE · 2 FAILED · 1 configuration/unexpected error.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$RestartKoreader,
    [string]$Serial,
    [string]$Ledger,
    [string]$Adb
)

$ErrorActionPreference = "Stop"
$started = Get-Date
$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot ".indio-virtual\logs\daily-refresh"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ($started.ToString("yyyy-MM-dd_HH-mm-ss") + ".log")

function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $message
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Finish([int]$code, [string]$status) {
    $duration = [int]((Get-Date) - $started).TotalSeconds
    Write-Log ("status={0} exit={1} duration={2}s" -f $status, $code, $duration)
    exit $code
}

Write-Log "INDIO StudyReader daily refresh started (repo=$repoRoot)"

$configPath = Join-Path $repoRoot ".indio-virtual\daily-refresh.json"
$config = @{}
if (Test-Path $configPath) {
    try {
        $json = Get-Content -Path $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $json.PSObject.Properties) { $config[$p.Name] = $p.Value }
    } catch {
        Write-Log "config file unreadable: $configPath ($($_.Exception.Message))"
        Finish 1 "FAILED"
    }
}

if (-not $Ledger) { $Ledger = $env:INDIO_LEDGER }
if (-not $Ledger -and $config.ContainsKey("ledger")) { $Ledger = [string]$config["ledger"] }
if (-not $Serial) { $Serial = $env:INDIO_TABLET_SERIAL }
if (-not $Serial -and $config.ContainsKey("serial")) { $Serial = [string]$config["serial"] }
if (-not $Adb) { $Adb = $env:ADB }
if (-not $Adb -and $config.ContainsKey("adb")) { $Adb = [string]$config["adb"] }
if (-not $Adb) {
    $candidate = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $candidate) { $Adb = $candidate }
    else {
        $cmd = Get-Command adb -ErrorAction SilentlyContinue
        if ($cmd) { $Adb = $cmd.Source }
    }
}

if (-not $Ledger) { Write-Log "INDIO_LEDGER is not configured (env var or $configPath)"; Finish 1 "FAILED" }
if (-not (Test-Path $Ledger)) { Write-Log "ledger not found: $Ledger"; Finish 1 "FAILED" }
if (-not $Serial) { Write-Log "INDIO_TABLET_SERIAL is not configured (env var or $configPath)"; Finish 1 "FAILED" }
if (-not $Adb -or -not (Test-Path $Adb)) { Write-Log "adb.exe not found (set ADB or install Android platform-tools)"; Finish 1 "FAILED" }

$pnpm = $null
$cmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($cmd) { $pnpm = $cmd.Source }
if (-not $pnpm) {
    $candidate = Join-Path $env:APPDATA "npm\pnpm.cmd"
    if (Test-Path $candidate) { $pnpm = $candidate }
}
if (-not $pnpm) { Write-Log "pnpm not found in PATH or %APPDATA%\npm"; Finish 1 "FAILED" }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Write-Log "node.exe not found in PATH"; Finish 1 "FAILED" }

Write-Log "device=$Serial adb=$Adb node=$($node.Source) pnpm=$pnpm"
Write-Log "ledger=(configured) dryRun=$($DryRun.IsPresent) restart=$($RestartKoreader.IsPresent)"

$env:INDIO_LEDGER = $Ledger
$env:INDIO_TABLET_SERIAL = $Serial
$env:ADB = $Adb

$arguments = @("-s", "study:refresh-review", "--", "--serial", $Serial, "--allow-device-offline")
if ($DryRun) { $arguments += "--dry-run" }
if ($RestartKoreader) { $arguments += "--restart-koreader" }

$latest = Join-Path $repoRoot ".indio-virtual\daily-refresh\latest.json"
$previousRunId = $null
if (Test-Path $latest) {
    try { $previousRunId = [string]((Get-Content -Path $latest -Raw -Encoding UTF8 | ConvertFrom-Json).runId) } catch { $previousRunId = $null }
}

$stdout = Join-Path $env:TEMP ("indio-refresh-" + [guid]::NewGuid().ToString("N") + ".out")
$stderr = Join-Path $env:TEMP ("indio-refresh-" + [guid]::NewGuid().ToString("N") + ".err")
$process = Start-Process -FilePath $pnpm -ArgumentList $arguments -WorkingDirectory $repoRoot -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$code = $process.ExitCode

foreach ($file in @($stdout, $stderr)) {
    if (Test-Path $file) {
        $content = Get-Content -Path $file -Raw -Encoding UTF8
        if ($content) { Add-Content -Path $logPath -Value $content -Encoding UTF8 }
        Remove-Item -Path $file -Force -ErrorAction SilentlyContinue
    }
}

$status = "FAILED"
if (Test-Path $latest) {
    try {
        $report = Get-Content -Path $latest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($report.runId -and ([string]$report.runId) -ne $previousRunId) {
            $status = [string]$report.result
            Write-Log ("report={0}/report.json result={1} deployment={2} remote={3}->{4}" -f $report.reportDir, $report.result, $report.deploymentStatus, $report.remoteVersionBefore, $report.remoteVersionAfter)
        } else {
            Write-Log "no fresh report found in $latest (refresh aborted before reporting?)"
        }
    } catch {
        Write-Log "report unreadable: $latest ($($_.Exception.Message))"
    }
}

switch ($code) {
    0 { if ($status -eq "FAILED") { $status = "UNKNOWN" } }
    3 { $status = "SKIPPED_DEVICE_OFFLINE" }
    default { if ($status -notin @("FAILED")) { $status = "FAILED" } }
}
Finish $code $status
