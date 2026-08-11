@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo Plataforma Multi-Tenant - Testes
echo ========================================
echo.

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] pnpm nao instalado. Execute setup-windows.bat primeiro
    echo.
    pause
    exit /b 1
)

echo Rodando suite de testes...
echo (domain + client + api = 252 testes)
echo.

call pnpm test

if %errorlevel% neq 0 (
    echo.
    echo [FALHA] Alguns testes falharam
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo Todos os testes passaram!
echo ========================================
echo.
pause
