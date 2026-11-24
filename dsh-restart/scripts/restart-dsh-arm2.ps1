# Extended arm script for planned MAINTENANCE restarts (2026-11-10).
#
# Why a second file instead of editing restart-dsh-arm.ps1: that one is the
# long-verified path (11-08 building, 11-09 hardening) and stays untouched.
# This file is a strict superset used only when a caller needs a custom
# "start half" or a third watchdog task.
#
#   start    at now +56s : custom -StartScript, or restart-dsh-fallback.cmd
#   kill     at now +45s : taskkill DSH (always restart-dsh-kill.cmd)
#   watchdog at now +N s : optional, brings DSH up if it is STILL down
#
# ORDER: start registered FIRST, then kill, then watchdog. Any registration
# failure rolls back everything so DSH is never left killed with no start half.
#
# Huorong HIPS kills the killer right after taskkill, so the start half MUST be
# a separate task -- that is exactly why -StartScript exists (e.g. a cmd that
# runs pnpm install and then calls restart-dsh-start.ps1).
#
# Parameters:
#   -KillAfterSeconds   20..600
#   -StartAfterSeconds  > kill, clamped to kill+11 at least
#   -StartScript        optional path to the start-half cmd
#   -WatchAfterSeconds  0 = off, else >= start+60, max 1800
#
# ASCII only: PowerShell 5.1 misreads BOM-less UTF-8, so no Chinese comments.

param(
    [int]$KillAfterSeconds = 45,
    [int]$StartAfterSeconds = 56,
    [string]$StartScript = "",
    [int]$WatchAfterSeconds = 0
)

$ErrorActionPreference = "Stop"
# Portable: script dir is the plugin's scripts/ folder; log comes from
# DSH_RESTART_LOG (set by the plugin) or <plugin>\logs\restart-dsh.log.
$root = $PSScriptRoot
$pluginRoot = Split-Path -Parent $root
$log = $env:DSH_RESTART_LOG
if (-not $log) { $log = Join-Path $pluginRoot "logs\restart-dsh.log" }
$stateDir = Join-Path $pluginRoot ".state"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Set-Content -LiteralPath (Join-Path $stateDir "log-path.txt") -Value $log -Encoding ascii
$logDir = Split-Path -Parent $log
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Write-Log([string]$msg) {
    try {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] $msg" |
            Out-File -Append -FilePath $log -Encoding utf8 -ErrorAction Stop
    } catch {
        Write-Verbose "log write failed: $($_.Exception.Message)"
    }
}

$now = Get-Date
if ($KillAfterSeconds -lt 20) { $KillAfterSeconds = 20 }
if ($KillAfterSeconds -gt 600) { $KillAfterSeconds = 600 }
if ($StartAfterSeconds -le $KillAfterSeconds) { $StartAfterSeconds = $KillAfterSeconds + 11 }

$startFile = Join-Path $root "restart-dsh-fallback.cmd"
if ($StartScript -and $StartScript.Trim().Length -gt 0) { $startFile = $StartScript.Trim() }
if (-not (Test-Path -LiteralPath $startFile)) {
    Write-Log ("ARM-FAIL: start script not found: " + $startFile)
    exit 1
}

$useWatchdog = $WatchAfterSeconds -gt 0
if ($useWatchdog) {
    if ($WatchAfterSeconds -lt ($StartAfterSeconds + 60)) { $WatchAfterSeconds = $StartAfterSeconds + 60 }
    if ($WatchAfterSeconds -gt 1800) { $WatchAfterSeconds = 1800 }
}

$killAt = $now.AddSeconds($KillAfterSeconds)
$startAt = $now.AddSeconds($StartAfterSeconds)
$watchAt = $now.AddSeconds($WatchAfterSeconds)

try {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $startAction = New-ScheduledTaskAction -Execute $startFile
    $startTrigger = New-ScheduledTaskTrigger -Once -At $startAt
    $killAction = New-ScheduledTaskAction -Execute (Join-Path $root "restart-dsh-kill.cmd")
    $killTrigger = New-ScheduledTaskTrigger -Once -At $killAt
    $watchAction = New-ScheduledTaskAction -Execute (Join-Path $root "restart-dsh-watchdog.cmd")
    $watchTrigger = New-ScheduledTaskTrigger -Once -At $watchAt
} catch {
    Write-Log ("ARM-FAIL: cannot build task objects: " + $_.Exception.Message)
    exit 1
}

$registered = @()
try {
    Register-ScheduledTask -TaskName "DSH-Restart-Start" -Action $startAction -Trigger $startTrigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    $registered += "DSH-Restart-Start"
    Register-ScheduledTask -TaskName "DSH-Restart-Kill" -Action $killAction -Trigger $killTrigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    $registered += "DSH-Restart-Kill"
    if ($useWatchdog) {
        Register-ScheduledTask -TaskName "DSH-Restart-Watchdog" -Action $watchAction -Trigger $watchTrigger `
            -Settings $settings -Principal $principal -Force | Out-Null
        $registered += "DSH-Restart-Watchdog"
    }
} catch {
    $message = $_.Exception.Message
    foreach ($name in $registered) {
        try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop | Out-Null } catch { }
    }
    Write-Log ("ARM-FAIL: " + $message)
    Write-Log "ARM-FAIL: rolled back, DSH left untouched"
    exit 1
}

Write-Log ("arming MAINT restart: kill at {0:HH:mm:ss}, start at {1:HH:mm:ss}" -f $killAt, $startAt)
if ($useWatchdog) { Write-Log ("watchdog at {0:HH:mm:ss}" -f $watchAt) }
Write-Log ("start half: " + $startFile)
Write-Log "tasks registered (start first, then kill, then watchdog)"
exit 0
