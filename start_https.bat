@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   协作白板 V2 - HTTPS启动脚本
echo ========================================
echo.

REM Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

:: Install dependencies
echo [1/3] 检查依赖...
python -m pip install fastapi "uvicorn[standard]" -q

:: Build frontend
echo [2/3] 构建前端...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo [警告] 前端构建失败，请先运行: cd frontend ^&^& npm install
    echo   跳过前端构建，使用已有产物继续...
)
cd ..

:: Start with HTTPS
echo [3/3] 启动HTTPS服务器...
echo.
echo   本地访问: https://localhost:8000
echo   内网穿透: 将隧道指向 127.0.0.1:8000
echo.
echo   按 Ctrl+C 停止服务
echo ========================================
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem --log-level info
pause
