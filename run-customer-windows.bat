@echo off
REM Run Customer App - React Native / Expo

echo.
echo ========================================
echo App do Cliente - Expo Dev Mode
echo ========================================
echo.

REM Check if pnpm is installed
pnpm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ pnpm não instalado. Execute setup-windows.bat primeiro
    pause
    exit /b 1
)

echo Iniciando dev server...
echo.
echo Após a tela abrir, você pode:
echo   [s] - Scanear QR Code (Expo Go)
echo   [a] - Emulador Android
echo   [i] - Emulador iOS (não suportado em Windows)
echo   [w] - Web preview
echo.
echo Para Expo Go no iPhone:
echo   1. Baixe o app "Expo Go" na App Store
echo   2. Aperte [s] para ver QR Code
echo   3. Abra a câmera do iPhone e aponte para o QR Code
echo.

call pnpm --filter mobile-customer dev

pause
