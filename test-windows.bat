@echo off
REM Test script for Windows - Roda todos os testes

echo.
echo ========================================
echo Plataforma Multi-Tenant - Testes
echo ========================================
echo.

REM Check if pnpm is installed
pnpm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ pnpm não instalado. Execute setup-windows.bat primeiro
    pause
    exit /b 1
)

echo Rodando suite de testes...
echo (domain + client + api = 252 testes)
echo.

call pnpm test

if errorlevel 1 (
    echo.
    echo ❌ Alguns testes falharam
    pause
    exit /b 1
)

echo.
echo ========================================
echo ✓ Todos os testes passaram!
echo ========================================
echo.
pause
