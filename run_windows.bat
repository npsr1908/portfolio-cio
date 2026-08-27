@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Please install Node.js LTS, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Node.js detected:
node --version
echo.

if not exist "node_modules\@modelcontextprotocol\client" (
  echo Installing the MCP client package. This is a one-time setup...
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo npm install failed.
    echo Please paste the full error shown above.
    pause
    exit /b 1
  )
  echo.
  echo MCP client installation complete.
)

echo Starting Portfolio CIO at http://127.0.0.1:8000
echo Keep this window open while using the dashboard.
echo.

start "" "http://127.0.0.1:8000"
node server.js
pause
endlocal
