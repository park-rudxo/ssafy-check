@echo off
REM SSAFY 출석 체크 알리미 - 업데이트
REM update.ps1 launcher. Double-click this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
