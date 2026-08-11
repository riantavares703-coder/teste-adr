#!/usr/bin/env bash
# Sobe um PostgreSQL local para desenvolvimento e testes.
# Em CI, use um service container em vez deste script.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/tmp/plataforma-pgdata}"
PGPORT="${PGPORT:-5433}"
PGSOCK="${PGSOCK:-/tmp}"

if [ ! -d "$PGDATA/base" ]; then
  echo "==> Inicializando cluster em $PGDATA"
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  if id postgres >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
    su postgres -c "$PGBIN/initdb -D $PGDATA -A trust -U postgres" >/dev/null
  else
    "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres >/dev/null
  fi
fi

if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l $PGDATA/server.log -o '-p $PGPORT -k $PGSOCK' -w start" || true
else
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -o "-p $PGPORT -k $PGSOCK" -w start || true
fi

psql -h "$PGSOCK" -p "$PGPORT" -U postgres -tAc "SELECT 1" >/dev/null
echo "==> PostgreSQL pronto em $PGSOCK:$PGPORT"
echo "    DATABASE_URL=postgresql://postgres@localhost:$PGPORT/plataforma?host=$PGSOCK"
