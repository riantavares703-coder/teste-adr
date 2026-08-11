@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo Plataforma Multi-Tenant - Setup Windows
echo ========================================
echo.

echo Verificando Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado. Instale em: https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js instalado

echo Verificando npm...
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] npm nao encontrado
    echo.
    pause
    exit /b 1
)
echo [OK] npm instalado

echo.
echo Instalando pnpm globalmente...
call npm install -g pnpm
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar pnpm
    echo.
    pause
    exit /b 1
)
echo [OK] pnpm instalado

echo.
echo Instalando dependencias do projeto (pode levar alguns minutos)...
call pnpm install
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar dependencias
    echo.
    pause
    exit /b 1
)
echo [OK] Dependencias instaladas

echo.
echo ========================================
echo Setup concluido com sucesso!
echo ========================================
echo.
echo Proximos passos:
echo   - Rodar testes: test-windows.bat
echo   - Rodar app customer: run-customer-windows.bat
echo   - Rodar app operator: run-operator-windows.bat
echo.
pause
