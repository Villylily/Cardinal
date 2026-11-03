@echo off
setlocal
title Cardinal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 20 or newer, then try again.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
    echo Could not determine the installed Node.js version.
    pause
    exit /b 1
)
if %NODE_MAJOR% LSS 20 (
    echo Cardinal requires Node.js 20 or newer. Detected major version %NODE_MAJOR%.
    pause
    exit /b 1
)

echo Starting Cardinal from "%~dp0"
node cardinal.js
set "CARDINAL_EXIT_CODE=%ERRORLEVEL%"
if not "%CARDINAL_EXIT_CODE%"=="0" (
    echo.
    echo Cardinal stopped with exit code %CARDINAL_EXIT_CODE%.
    pause
)
exit /b %CARDINAL_EXIT_CODE%
