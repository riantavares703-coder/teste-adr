@echo off
title Plataforma de Pedidos
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto sem_node

REM Tudo o mais (dependencias, banco, sistema) e responsabilidade do launcher.
REM Este arquivo faz UMA coisa so: chamar o Node. Fluxo de batch com blocos e
REM errorlevel e a parte que quebra em silencio, entao ela nao existe aqui.
node scripts\launcher.mjs %*
echo.
pause
exit /b 0

:sem_node
echo.
echo  Falta instalar o Node.js neste computador.
echo.
echo  1. Abra: https://nodejs.org
echo  2. Baixe a versao LTS e instale
echo  3. Abra este programa de novo
echo.
pause
exit /b 1
