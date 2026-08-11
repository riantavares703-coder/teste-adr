@echo off
REM Setup script for Windows - Instala dependências do projeto
REM Usage: setup-windows.bat

echo.
echo ========================================
echo Plataforma Multi-Tenant - Setup Windows
echo ========================================
echo.

REM Check Node.js
echo Verificando Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js não encontrado. Instale em: https://nodejs.org
    pause
    exit /b 1
)
echo ✓ Node.js instalado

REM Check npm
echo Verificando npm...
npm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ npm não encontrado
    pause
    exit /b 1
)
echo ✓ npm instalado

REM Install pnpm globally
echo.
echo Instalando pnpm globalmente...
npm install -g pnpm
if errorlevel 1 (
    echo ❌ Erro ao instalar pnpm
    pause
    exit /b 1
)
echo ✓ pnpm instalado

REM Install project dependencies
echo.
echo Instalando dependências do projeto...
call pnpm install
if errorlevel 1 (
    echo ❌ Erro ao instalar dependências
    pause
    exit /b 1
)
echo ✓ Dependências instaladas

echo.
echo ========================================
echo ✓ Setup concluído com sucesso!
echo ========================================
echo.
echo Próximos passos:
echo   - Rodar testes: test-windows.bat
echo   - Rodar app customer: run-customer-windows.bat
echo   - Rodar app operator: run-operator-windows.bat
echo.
pause
