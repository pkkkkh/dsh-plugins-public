# Arms the two halves of a restart with second-level precision.
#   start at now +56s : start DSH if it is not running
#   kill  at now +45s : taskkill DSH
#
# ORDER MATTERS: the START task is registered FIRST. If the KILL registration
# then fails we roll back and leave DSH untouched -- "kill registered, start
# missing" must never happen (that is how DSH gets lost for good).
#
# schtasks can only schedule whole minutes, hence PowerShell here.
# ASCII only: PowerShell 5.1 misreads BOM-less UTF-8, so no Chinese comments.
#
# Parameters (defaults keep restart-dsh.cmd behaviour unchanged):
#   -KillAfterSeconds  20..600, kill task fires this many seconds from now
#   -StartAfterSeconds start task fires this many seconds from now
# The START task is always registered first; see the ordering note below.

param(
    [int]$KillAfterSeconds = 45,
    [int]$StartAfterSeconds = 56
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
    # A failed log write must never stop the restart from being armed.
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
$killAt = $now.AddSeconds($KillAfterSeconds)
$startAt = $now.AddSeconds($StartAfterSeconds)

try {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $startAction = New-ScheduledTaskAction -Execute (Join-Path $root "restart-dsh-fallback.cmd")
    $startTrigger = New-ScheduledTaskTrigger -Once -At $startAt
    $killAction = New-ScheduledTaskAction -Execute (Join-Path $root "restart-dsh-kill.cmd")
    $killTrigger = New-ScheduledTaskTrigger -Once -At $killAt
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
} catch {
    $message = $_.Exception.Message
    foreach ($name in $registered) {
        try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop | Out-Null } catch { }
    }
    Write-Log ("ARM-FAIL: " + $message)
    Write-Log "ARM-FAIL: rolled back, DSH left untouched"
    exit 1
}

Write-Log ("arming restart: kill at {0:HH:mm:ss}, start at {1:HH:mm:ss}" -f $killAt, $startAt)
Write-Log "tasks registered (start first, then kill)"
exit 0
