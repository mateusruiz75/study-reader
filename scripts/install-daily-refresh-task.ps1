<#
.SYNOPSIS
  Installs (idempotently), shows or removes the Windows Task Scheduler entry
  "INDIO StudyReader Daily Refresh" that runs scripts/refresh-indio-review.ps1
  every day at 06:00 (local time) for the current user.

.DESCRIPTION
  - one instance at a time (MultipleInstances = IgnoreNew)
  - runs hidden, no PowerShell window required
  - working directory = repository root
  - no password stored: S4U logon for the current user (falls back to Interactive)
  - stdout/stderr are captured by the wrapper into .indio-virtual/logs/daily-refresh/

  Re-running the installer never creates a second task: an existing task is
  updated in place and reported as ALREADY CONFIGURED.
#>
[CmdletBinding()]
param(
    [string]$Time = "06:00",
    [switch]$Show,
    [switch]$Uninstall,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$taskName = "INDIO StudyReader Daily Refresh"
$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot "scripts\refresh-indio-review.ps1"

function Show-Task {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "task '$taskName' is not installed"; return $false }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "task:      $taskName"
    Write-Host "state:     $($task.State)"
    Write-Host "principal: $($task.Principal.UserId) ($($task.Principal.LogonType))"
    Write-Host "trigger:   daily at $($task.Triggers[0].StartBoundary)"
    Write-Host "action:    $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
    Write-Host "workdir:   $($task.Actions[0].WorkingDirectory)"
    Write-Host "instances: $($task.Settings.MultipleInstances)"
    Write-Host "last run:  $($info.LastRunTime) result=0x$('{0:X}' -f $info.LastTaskResult)"
    Write-Host "next run:  $($info.NextRunTime)"
    return $true
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "REMOVED '$taskName'"
    } else {
        Write-Host "task '$taskName' was not installed"
    }
    exit 0
}

if ($Show) { $null = Show-Task; exit 0 }

if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

$argument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$userId = "$env:USERDOMAIN\$env:USERNAME"

function Register-Task([bool]$replace) {
    foreach ($logonType in @("S4U", "Interactive")) {
        try {
            $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited
            $params = @{ TaskName = $taskName; Action = $action; Trigger = $trigger; Settings = $settings; Principal = $principal }
            if ($replace) { $params.Force = $true }
            Register-ScheduledTask @params | Out-Null
            return $logonType
        } catch {
            Write-Host "registration with logon type $logonType failed: $($_.Exception.Message)"
        }
    }
    throw "could not register '$taskName'"
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $current = $existing.Actions[0]
    $wantedStart = ([datetime]::ParseExact($Time, "HH:mm", $null)).ToString("HH:mm")
    $currentStart = ([datetime]$existing.Triggers[0].StartBoundary).ToString("HH:mm")
    $same = ($current.Execute -eq "powershell.exe") -and ($current.Arguments -eq $argument) -and
        ($current.WorkingDirectory -eq $repoRoot) -and ($currentStart -eq $wantedStart) -and
        ($existing.Settings.MultipleInstances -eq "IgnoreNew") -and ($existing.Principal.UserId -like "*$env:USERNAME")
    if ($same) {
        Write-Host "ALREADY CONFIGURED '$taskName' (definition unchanged)"
    } else {
        $logonType = Register-Task $true
        Write-Host "ALREADY CONFIGURED '$taskName' (definition updated, logon type $logonType)"
    }
} else {
    $logonType = Register-Task $false
    Write-Host "INSTALLED '$taskName' (logon type $logonType)"
}

$null = Show-Task
if ($RunNow) {
    Start-ScheduledTask -TaskName $taskName
    Write-Host "STARTED '$taskName'"
}
