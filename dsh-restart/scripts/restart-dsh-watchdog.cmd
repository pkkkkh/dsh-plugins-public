@echo off
rem Third task of a maintenance restart: if DSH is STILL down, bring it up,
rem then delete the DSH-Restart-* task definitions.
setlocal
set "SCRIPTDIR=%~dp0"
set "LOGFILE=%SCRIPTDIR%..\.state\log-path.txt"
if exist "%LOGFILE%" for /f "usebackq delims=" %%L in ("%LOGFILE%") do set "LOG=%%L"
if not defined LOG set "LOG=%SCRIPTDIR%..\logs\restart-dsh.log"
if not exist "%SCRIPTDIR%..\logs" mkdir "%SCRIPTDIR%..\logs" >nul 2>&1
echo [%time%] WATCHDOG fired >> "%LOG%"
tasklist /fi "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [%time%] WATCHDOG: DSH already running >> "%LOG%"
) else (
  echo [%time%] WATCHDOG: DSH still down, starting it >> "%LOG%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTDIR%restart-dsh-start.ps1" >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo [%time%] WATCHDOG: first attempt failed, retrying once >> "%LOG%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTDIR%restart-dsh-start.ps1" >> "%LOG%" 2>&1
  )
)
schtasks /delete /tn "DSH-Restart-Watchdog" /f >> "%LOG%" 2>&1
schtasks /delete /tn "DSH-Restart-Kill" /f >> "%LOG%" 2>&1
schtasks /delete /tn "DSH-Restart-Start" /f >> "%LOG%" 2>&1
exit /b 0
