@echo off
REM Run Operator App - React Native / Expo

echo.
echo ========================================
echo App do Operador/Admin - Expo Dev Mode
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
echo Credenciais de teste:
echo   Email: admin@franquia-a.com
echo   Senha: senha123456
echo.

call pnpm --filter mobile-operator dev

pause
