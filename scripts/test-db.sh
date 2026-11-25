#!/usr/bin/env bash
# Aplica todas las migraciones sobre un Postgres local efímero (con un stub de
# Supabase) y ejecuta las pruebas SQL de supabase/tests/*.test.sql.
# Requiere binarios de PostgreSQL 15+ (initdb, pg_ctl, psql).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="$PGBIN:$PATH"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"; RUN_AS=(runuser -u postgres --)
fi
cleanup() { "${RUN_AS[@]}" pg_ctl -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" initdb -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${RUN_AS[@]}" pg_ctl -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" start >/dev/null
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$ROOT/supabase/tests/supabase_stub.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ migración $(basename "$f")"
  "${PSQL[@]}" -f "$f" >/dev/null
done
for f in "$ROOT"/supabase/tests/*.test.sql; do
  echo "→ pruebas $(basename "$f")"
  if ! "${PSQL[@]}" -f "$f" >"$WORK/out" 2>&1; then
    cat "$WORK/out"; echo "✘ Falló $(basename "$f")"; exit 1
  fi
  grep -E "NOTICE:  OK|✔" "$WORK/out" | sed -E 's/^.*NOTICE:  /   /' 
done
echo "✔ Migraciones y pruebas SQL OK"
