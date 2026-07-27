@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting Roomly at http://localhost:3000
echo Press Ctrl+C to stop the server.
echo.
call npm start

if errorlevel 1 (
  echo.
  echo The server stopped with an error.
  pause
)
