@echo off
if /I "%~1"=="--attached" goto :attached
start "DeepSeek Boost Gateway" "%ComSpec%" /d /k ""%~f0" --attached"
exit /b 0

:attached
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title DeepSeek Boost Gateway - http://127.0.0.1:8642/

echo.
echo  DeepSeek Boost Gateway
echo  ======================
echo.

where node >nul 2>&1
if errorlevel 1 goto :node_missing

for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :node_missing
if %NODE_MAJOR% LSS 22 goto :node_old

where npm >nul 2>&1
if errorlevel 1 goto :npm_missing

echo [1/4] Node.js %NODE_MAJOR% detected.

if not exist ".env" (
  if not exist ".env.example" goto :env_template_missing
  copy /y ".env.example" ".env" >nul
  echo [2/4] Created .env from .env.example.
) else (
  echo [2/4] Existing .env preserved.
)

for /f "delims=" %%D in ('node -e "const p=require('./package.json'); const d={...(p.dependencies||{}),...(p.optionalDependencies||{})}; process.stdout.write(String(Object.keys(d).length))"') do set "RUNTIME_DEPS=%%D"
if not defined RUNTIME_DEPS goto :dependency_check_failed

if "%RUNTIME_DEPS%"=="0" (
  echo [3/4] No external runtime dependencies required.
) else (
  call npm ls --omit=dev --depth=0 >nul 2>&1
  if errorlevel 1 (
    echo [3/4] Installing missing runtime dependencies...
    if exist "package-lock.json" (
      call npm install --omit=dev --no-audit --no-fund
    ) else (
      call npm install --omit=dev --no-audit --no-fund --no-package-lock
    )
    if errorlevel 1 goto :dependency_install_failed
  ) else (
    echo [3/4] Runtime dependencies are ready.
  )
)

echo [4/4] Starting Gateway. Keep this window open.
echo       Current page: http://127.0.0.1:8642/
echo       Configured data API endpoints will be printed below.
echo       Closing this terminal stops the Gateway started here.
echo.
if /I "%GATEWAY_NO_OPEN%"=="1" (
  node "scripts\launch-gateway.mjs" --no-open
) else (
  node "scripts\launch-gateway.mjs"
)
if errorlevel 1 goto :gateway_failed
exit /b 0

:node_missing
echo [ERROR] Node.js was not found.
echo Install Node.js 22 or newer, then run this file again:
echo https://nodejs.org/en/download
goto :pause_error

:node_old
echo [ERROR] Node.js %NODE_MAJOR% is too old. Version 22 or newer is required.
echo Download the current LTS release, then run this file again:
echo https://nodejs.org/en/download
goto :pause_error

:npm_missing
echo [ERROR] npm was not found. A normal Node.js installation includes npm.
echo Reinstall Node.js 22 or newer from:
echo https://nodejs.org/en/download
goto :pause_error

:env_template_missing
echo [ERROR] .env.example is missing. Restore the complete project and try again.
goto :pause_error

:dependency_check_failed
echo [ERROR] Unable to inspect package.json runtime dependencies.
goto :pause_error

:dependency_install_failed
echo [ERROR] Automatic dependency installation failed. Review the npm output above.
goto :pause_error

:gateway_failed
echo.
echo [ERROR] Gateway stopped with an error. Review the output above.

:pause_error
echo.
pause
exit /b 1
