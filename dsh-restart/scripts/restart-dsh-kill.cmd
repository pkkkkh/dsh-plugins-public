@echo off
rem Kill half of the restart pair. Does NOT relaunch: the start task does that.
rem Generic version: log path from <plugin>\.state\log-path.txt, else <plugin>\logs.
setlocal
set "SCRIPTDIR=%~dp0"
set "LOGFILE=%SCRIPTDIR%..\.state\log-path.txt"
if exist "%LOGFILE%" for /f "usebackq delims=" %%L in ("%LOGFILE%") do set "LOG=%%L"
if not defined LOG set "LOG=%SCRIPTDIR%..\logs\restart-dsh.log"
if not exist "%SCRIPTDIR%..\logs" mkdir "%SCRIPTDIR%..\logs" >nul 2>&1
echo [%time%] killing DeepSeek Harness >> "%LOG%"
taskkill /IM "DeepSeek Harness.exe" /F >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%time%] taskkill found nothing to kill (or access denied) >> "%LOG%"
) else (
  echo [%time%] taskkill ok >> "%LOG%"
)
endlocal
exit /b 0
