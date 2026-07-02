@echo off
rem YT Proxy Stop Script
chcp 65001 > nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo ========================================
echo   Stopping YT Proxy...
echo ========================================

if exist stopped.flag del /f /q stopped.flag >nul 2>&1

echo [1/2] Sending stop signal to maintenance loop...
echo. > stop.trigger

echo Waiting for maintenance loop to exit cleanly...
set WAIT_COUNT=0
:wait_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
set /a WAIT_COUNT+=1
if exist stopped.flag (
    del /f /q stopped.flag >nul 2>&1
    echo Maintenance loop exited cleanly.
    goto stop_done
)
if !WAIT_COUNT! gtr 10 (
    echo [!] Clean exit timed out. Force killing remaining processes...
    taskkill /f /fi "windowtitle eq YT-Proxy-Maintenance-Loop*" >nul 2>&1
    taskkill /f /fi "windowtitle eq YT-Proxy-Server*" >nul 2>&1
    taskkill /f /im cloudflared.exe >nul 2>&1
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr :3000') do taskkill /f /pid %%a >nul 2>&1
    if exist stop.trigger del /f /q stop.trigger >nul 2>&1
    goto stop_done
)
goto wait_stop

:stop_done
echo Cleaning up temporary files...
if exist tunnel.log del /f /q tunnel.log >nul 2>&1
if exist temp_url.txt del /f /q temp_url.txt >nul 2>&1

echo.
echo DONE. All YT Proxy processes have been stopped.
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
exit
