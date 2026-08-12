#!/usr/bin/env bash
# Equivalente do INICIAR.bat para macOS e Linux.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Falta instalar o Node.js neste computador."
  echo "  Baixe a versao LTS em https://nodejs.org e abra este programa de novo."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  Preparando o sistema pela primeira vez. Isso leva alguns minutos..."
  echo
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
  pnpm install
fi

exec node scripts/launcher.mjs "$@"
