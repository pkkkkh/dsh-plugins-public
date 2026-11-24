@echo off
rem Start half of the restart pair. Fires ~11s after the kill task.
rem If DSH is already running, do nothing (never two instances).
rem Generic version: script dir is %~dp0, log path comes from <plugin>\.state\log-path.txt
rem (written by arm.ps1), falling back to <plugin>\logs.
setlocal
set "SCRIPTDIR=%~dp0"
set "LOGFILE=%SCRIPTDIR%..\.state\log-path.txt"
if exist "%LOGFILE%" for /f "usebackq delims=" %%L in ("%LOGFILE%") do set "LOG=%%L"
if not defined LOG set "LOG=%SCRIPTDIR%..\logs\restart-dsh.log"
if not exist "%SCRIPTDIR%..\logs" mkdir "%SCRIPTDIR%..\logs" >nul 2>&1
echo [%time%] START task fired >> "%LOG%"
tasklist /fi "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [%time%] START: DSH already running, nothing to do >> "%LOG%"
) else (
  echo [%time%] START: DSH missing, starting it >> "%LOG%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTDIR%restart-dsh-start.ps1" >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo [%time%] START: first attempt failed, retrying once >> "%LOG%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTDIR%restart-dsh-start.ps1" >> "%LOG%" 2>&1
    if errorlevel 1 (
      echo [%time%] START: retry failed too, DSH is NOT running >> "%LOG%"
    ) else (
      echo [%time%] START: retry brought DSH up >> "%LOG%"
    )
  ) else (
    echo [%time%] START: DSH is up (start.ps1 confirmed) >> "%LOG%"
  )
)
schtasks /delete /tn "DSH-Restart-Kill" /f >> "%LOG%" 2>&1
schtasks /delete /tn "DSH-Restart-Start" /f >> "%LOG%" 2>&1
exit /b 0
