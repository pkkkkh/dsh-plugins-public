# Starts DSH detached from whatever console called us, and verifies the app
# actually STAYS up: a process that appears and then crashes (the desktop
# "Web authentication failed" startup crash, seen 2026-11-09 15:48-16:14) must
# NOT be reported as "up".
#
# History:
#   1) `start "" "...DeepSeek Harness.exe"` inherited cmd's console -> the window
#      stayed alive and closing it killed DSH (2026-11-08 21:59).
#   2) Win32_Process.Create (WMI) fixed the console issue, but the WMI-launched
#      instance crashed at 22:13 (crash-main.log: connect UNKNOWN 127.0.0.1:64297)
#      -- a WMI-created process gets a different environment block than a normal
#      shell launch, which this app does not survive.
#   3) Now: launch through explorer.exe first (same as a double-click: no console,
#      normal user environment). WMI stays as a last resort.
#
# Exit codes: 0 = process up and survived the confirmation window; 1 = gave up.
# ASCII only: PowerShell 5.1 misreads BOM-less UTF-8.

param([string]$Exe = "")

$ErrorActionPreference = "Continue"

# Do not hardcode an install path: -Exe > DSH_APP_EXE > <plugin>\.state\app-exe.txt > common install dirs
$candidates = New-Object System.Collections.ArrayList
if ($Exe) { [void]$candidates.Add($Exe) }
if ($env:DSH_APP_EXE) { [void]$candidates.Add($env:DSH_APP_EXE) }
$stateFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".state\app-exe.txt"
if (Test-Path -LiteralPath $stateFile) {
    $fromState = Get-Content -LiteralPath $stateFile -TotalCount 1
    if ($fromState) { [void]$candidates.Add($fromState.Trim()) }
}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA "Programs"))) {
    if ($base) { [void]$candidates.Add((Join-Path $base "DeepSeek Harness\DeepSeek Harness.exe")) }
}
$exe = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break }
}
if (-not $exe) {
    "  START: DSH exe not found; pass -Exe, set DSH_APP_EXE, or write .state\app-exe.txt"
    exit 1
}

function Count-Dsh {
    @(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue).Count
}

function Wait-ForProcess([int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        Start-Sleep -Seconds 1
        if ((Count-Dsh) -gt 0) { return $true }
    }
    return $false
}

# The process appearing is not enough: today's failure mode is "appears, then
# dies within seconds". Wait, then check it is still there.
function Confirm-StaysUp([int]$seconds) {
    Start-Sleep -Seconds $seconds
    return ((Count-Dsh) -gt 0)
}

function Launch-Explorer {
    "  START: launching via explorer.exe"
    Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList ('"' + $exe + '"')
}

function Launch-Wmi {
    "  START: trying WMI create"
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = ('"' + $exe + '"')
        }
        "  START: WMI create rc=$($r.ReturnValue) pid=$($r.ProcessId)"
    } catch {
        "  START: WMI create failed: $($_.Exception.Message)"
    }
}

function Bring-Up([int]$waitSeconds) {
    if (-not (Wait-ForProcess $waitSeconds)) {
        Launch-Wmi
        if (-not (Wait-ForProcess 12)) { return $false }
    }
    return $true
}

# Attempt 1
Launch-Explorer
if (-not (Bring-Up 15)) {
    "  START: gave up, DSH never came up"
    exit 1
}
if (Confirm-StaysUp 20) {
    "  START: DSH is up and stayed up"
    exit 0
}

# Attempt 2: only after a startup crash (process is already gone)
"  START: DSH exited within 20s after launch, retrying once"
Launch-Explorer
if (-not (Bring-Up 15)) {
    "  START: gave up (retry), DSH never came up"
    exit 1
}
if (Confirm-StaysUp 20) {
    "  START: DSH is up after retry and stayed up"
    exit 0
}

"  START: gave up, DSH keeps exiting at startup"
exit 1
