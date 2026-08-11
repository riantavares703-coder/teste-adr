@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo App do Operador/Admin - Expo Dev Mode
echo ========================================
echo.

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] pnpm nao instalado. Execute setup-windows.bat primeiro
    echo.
    pause
    exit /b 1
)

echo Iniciando dev server...
echo.
echo Apos a tela abrir, voce pode:
echo   [s] - Scanear QR Code (Expo Go)
echo   [a] - Emulador Android
echo   [i] - Emulador iOS (nao suportado em Windows)
echo   [w] - Web preview
echo.
echo Credenciais de teste:
echo   Email: admin@franquia-a.com
echo   Senha: senha123456
echo.

call pnpm --filter mobile-operator dev

echo.
echo Dev server encerrado.
pause
