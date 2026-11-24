# Inspect or cancel the scheduled tasks used by dsh-restart.
#   -Action status : print "NAME=STATE" per known task, "-" when not registered
#   -Action cancel : unregister every known task, print what was removed
#
# Task names cover both families:
#   DSH-Restart-* : armed by restart-dsh-arm.ps1 / restart-dsh-arm2.ps1
#   DSH-Maint-*   : the 2026-11-10 maintenance window (one-off tasks)
#
# ASCII only: PowerShell 5.1 misreads BOM-less UTF-8, so no Chinese comments.

param(
    [ValidateSet("status", "cancel")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Continue"
$names = @(
    "DSH-Restart-Start",
    "DSH-Restart-Kill",
    "DSH-Restart-Watchdog",
    "DSH-Maint-Start",
    "DSH-Maint-Kill",
    "DSH-Maint-Watchdog"
)

if ($Action -eq "status") {
    foreach ($n in $names) {
        $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        if ($t) {
            $info = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue
            $next = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "-" }
            Write-Output ("{0}={1};next={2}" -f $n, $t.State, $next)
        } else {
            Write-Output ("{0}=-" -f $n)
        }
    }
    exit 0
}

$removed = 0
foreach ($n in $names) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) { continue }
    try {
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop
        Write-Output ("removed " + $n)
        $removed += 1
    } catch {
        Write-Output ("failed " + $n + ": " + $_.Exception.Message)
    }
}
Write-Output ("removed_total=" + $removed)
exit 0
