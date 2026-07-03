@echo off
rem YT Proxy Startup Script
chcp 65001 > nul
cd /d "%~dp0"
setlocal enabledelayedexpansion
title YT-Proxy-Maintenance-Loop

rem Load configuration from .env file
if not exist .env (
    echo [!] .env file not found. Please create it based on .env.example.
    pause
    exit
)
for /f "usebackq tokens=*" %%i in (".env") do (
    set "line=%%i"
    if not "!line:~0,1!"=="#" (
        for /f "tokens=1* delims==" %%a in ("%%i") do (
            set "%%a=%%b"
        )
    )
)
set KEY=%GAS_KEY%

if exist stop.trigger del /f /q stop.trigger >nul 2>&1
if exist stopped.flag del /f /q stopped.flag >nul 2>&1

:main_loop
cls
echo ======================================================
echo   YT Proxy Maintenance Loop Starting...
echo   Current Time: %date% %time%
echo   * Press Ctrl+C to stop or run "stop.bat"
echo ======================================================

echo [1/5] Cleaning up old processes...
rem Kill processes holding port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr :3000') do taskkill /f /pid %%a >nul 2>&1

taskkill /f /fi "windowtitle eq YT-Proxy-Server*" >nul 2>&1
taskkill /f /fi "windowtitle eq YT-Proxy-Tunnel*" >nul 2>&1
taskkill /f /im cloudflared.exe >nul 2>&1
taskkill /f /im ffmpeg.exe >nul 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 2"

if exist tunnel.log (
    del /f /q tunnel.log >nul 2>&1
)
if exist temp_url.txt del /f /q temp_url.txt >nul 2>&1

echo [2/5] Starting server and tunnel...
start /min "YT-Proxy-Server" node server.js
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
start /b "" .\cloudflared.exe tunnel --url http://localhost:3000 > tunnel.log 2>&1

echo [3/5] Waiting for URL (max 60s)...

set WAIT_COUNT=0
:wait_loop
if exist stop.trigger goto do_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
if exist stop.trigger goto do_stop

node extract.js > temp_url.txt
set /p NEW_URL=<temp_url.txt
if "!NEW_URL!"=="" (
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! gtr 30 (
        echo [!] URL extraction timed out. Check tunnel.log for errors.
        echo Restarting...
        powershell -NoProfile -Command "Start-Sleep -Seconds 5"
        goto main_loop
    )
    goto wait_loop
)

echo.
echo URL Obtained: !NEW_URL!

echo [3.5/5] Tunnel URL detected. Waiting 10s for DNS propagation...
set WAIT_DNS=0
:dns_wait_loop
if exist stop.trigger goto do_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
set /a WAIT_DNS+=2
if !WAIT_DNS! lss 10 goto dns_wait_loop
echo.

echo [4/5] Notifying GAS of the new URL...

set RETRY_COUNT=1
:notify_loop
if exist stop.trigger goto do_stop
powershell -NoProfile -Command "try { $res = Invoke-RestMethod -Uri '%GAS_URL%' -Method Post -Body @{url='!NEW_URL!'; key='%KEY%'}; if ($res -eq 'OK') { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
    echo [!] GAS notification failed [Attempt !RETRY_COUNT!]. Retrying in 5s...
    set /a RETRY_COUNT+=1
    if !RETRY_COUNT! leq 5 (
        powershell -NoProfile -Command "Start-Sleep -Seconds 5"
        if exist stop.trigger goto do_stop
        goto notify_loop
    )
    echo [!] Failed to notify GAS after 5 attempts.
) else (
    echo GAS notified successfully.
)

echo [5/5] System is running. Entering monitoring mode...
echo * Auto-restart will occur in 4 hours or on server exit.

set MONITOR_TICKS=0
:monitor_loop
set SEC_COUNT=0
:monitor_wait
if exist stop.trigger goto do_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 5"
set /a SEC_COUNT+=5
if !SEC_COUNT! lss 60 goto monitor_wait

set /a MONITOR_TICKS+=1

rem Scheduled 4-hour restart (240 minutes)
if !MONITOR_TICKS! gtr 240 (
    echo [!] Scheduled 4-hour restart.
    goto main_loop
)

rem Check server (Monitor port 3000)
netstat -ano | findstr LISTENING | findstr :3000 > nul
if errorlevel 1 (
    echo [!] Server port 3000 offline detected. Restarting...
    goto main_loop
)

rem Check tunnel
tasklist /fi "imagename eq cloudflared.exe" | find "cloudflared.exe" > nul
if errorlevel 1 (
    echo [!] Tunnel stop detected. Restarting...
    goto main_loop
)

goto monitor_loop

:do_stop
echo [!] Stop signal detected. Cleaning up...
taskkill /f /fi "windowtitle eq YT-Proxy-Server*" >nul 2>&1
taskkill /f /im cloudflared.exe >nul 2>&1
taskkill /f /im ffmpeg.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr :3000') do taskkill /f /pid %%a >nul 2>&1
if exist tunnel.log del /f /q tunnel.log >nul 2>&1
if exist temp_url.txt del /f /q temp_url.txt >nul 2>&1
del /f /q stop.trigger >nul 2>&1
echo. > stopped.flag
echo Stopped successfully.
exit
