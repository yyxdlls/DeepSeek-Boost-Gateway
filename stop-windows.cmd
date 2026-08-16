@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  DeepSeek Boost Gateway - Stop
echo  =============================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Unable to verify the Gateway process safely.
  goto :finish_error
)

node "scripts\stop-gateway.mjs"
if errorlevel 1 goto :finish_error

echo.
echo This window will close automatically.
node -e "setTimeout(function () {}, 1500)"
exit /b 0

:finish_error
echo.
pause
exit /b 1
