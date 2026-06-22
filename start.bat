@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHON=%~dp0.venv\Scripts\python.exe"

REM Auto-create venv if not exists
if not exist "!PYTHON!" (
    echo [INFO] Virtual environment not found, creating .venv ...
    python -m venv "%~dp0.venv"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create virtual environment. Please install Python first.
        pause
        exit /b 1
    )
    echo [INFO] Virtual environment created.
)

REM ===== Required env vars for production =====
set "WHITEBOARD_SECRET_KEY=wb2k6s3cr3t_k3y_ch4ng3_m3_1n_pr0duct10n_a1b2c3d4e5f6g7h8"
set "WHITEBOARD_ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000"
REM ============================================

echo ========================================
echo   Whiteboard V2 - Start Script
echo   DB: PostgreSQL (whiteboard_v2)
echo ========================================
echo.

REM Check Python
if not exist "!PYTHON!" (
    echo [ERROR] Python not found: !PYTHON!
    pause
    exit /b 1
)

REM Install Python dependencies
echo [1/3] Installing Python dependencies...
"!PYTHON!" -m pip install -r requirements.txt -q
echo [1/3] Done
echo.

REM Build frontend
echo [2/3] Building frontend...
cd frontend
call npm run build
if !errorlevel! neq 0 (
    echo [WARN] Frontend build failed. Run manually: cd frontend ^&^& npm install ^&^& npm run build
    echo        Skipping frontend build, using existing dist...
)
cd ..
echo [2/3] Done
echo.

REM Kill any process occupying port 8000
echo [PRE] Checking port 8000...
powershell -NonInteractive -ExecutionPolicy Bypass -File "%~dp0killport.ps1" 2>nul
timeout /t 1 >nul

REM Get local LAN IP address for display
set "LAN_IP=your-ip"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "& { (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' -and $_.InterfaceAlias -notlike '*Loopback*' }).IPAddress | Select-Object -First 1 }" 2^>nul') do set "LAN_IP=%%i"

REM Start server
echo [3/3] Starting whiteboard server...
echo.
echo   Local:   http://localhost:8000
echo   LAN:     http://!LAN_IP!:8000
echo.
echo   Press Ctrl+C to stop the server
echo ========================================
echo.

"!PYTHON!" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --log-level info
pause
endlocal
