@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo App do Cliente - Expo Dev Mode
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
echo Para Expo Go no iPhone:
echo   1. Baixe o app "Expo Go" na App Store
echo   2. Aperte [s] para ver QR Code
echo   3. Abra a camera do iPhone e aponte para o QR Code
echo.

call pnpm --filter mobile-customer dev

echo.
echo Dev server encerrado.
pause
