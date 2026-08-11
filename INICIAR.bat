@echo off
title Plataforma de Pedidos
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  Falta instalar o Node.js neste computador.
    echo.
    echo  1. Abra: https://nodejs.org
    echo  2. Baixe a versao LTS e instale
    echo  3. Abra este programa de novo
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo.
    echo  Preparando o sistema pela primeira vez. Isso leva alguns minutos...
    echo.
    call npm install -g pnpm >nul 2>nul
    call pnpm install
    if %errorlevel% neq 0 (
        echo.
        echo  Nao foi possivel preparar o sistema.
        echo.
        pause
        exit /b 1
    )
)

node scripts\launcher.mjs
if %errorlevel% neq 0 pause
