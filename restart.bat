@echo off
rem YT Proxy Restart Script
chcp 65001 > nul
cd /d "%~dp0"

echo ========================================
echo   Restarting YT Proxy...
echo ========================================

cmd /c stop.bat

echo Processes stopped. Preparing to start...
powershell -NoProfile -Command "Start-Sleep -Seconds 2"

start start.bat
echo.
echo Restart command sent.
echo This window will close.
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
exit
