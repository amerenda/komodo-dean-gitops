#!/bin/bash
# Migrate OpenWebUI SQLite → PostgreSQL
#
# Run this ONCE on mac-mini-m4 before switching DATABASE_URL in the compose.
# Steps:
#   1. Stops OpenWebUI
#   2. Runs pgloader (in Docker) to copy all data from SQLite to Postgres
#   3. Starts OpenWebUI again (still on SQLite) so you can verify Postgres data
#   4. After verifying, merge the compose.yaml PR to switch DATABASE_URL permanently
#
# Prerequisites (already done):
#   - postgres DB 'openwebui' with user 'openwebui' created on core postgres
#   - BWS secret 'openwebui-dean-db-password' set
#
# Run as: bash mac-mini-m4/manual_runs/migrate-openwebui-sqlite-to-postgres.sh

set -euo pipefail

SQLITE_PATH="/Users/alex/komodo/openwebui/data/webui.db"
PG_PASSWORD="4789ae3a2b8b1bb8fdbbc59e383ed6329ec03d3e9b8a0725"
PG_DSN="postgresql://openwebui:${PG_PASSWORD}@127.0.0.1/openwebui"

echo "==> Stopping OpenWebUI..."
docker stop openwebui

echo "==> Verifying SQLite exists..."
ls -lh "$SQLITE_PATH"

echo "==> Running pgloader (SQLite → PostgreSQL)..."
docker run --rm \
  --network host \
  -v "/Users/alex/komodo/openwebui/data:/data:ro" \
  dimitri/pgloader:latest \
  pgloader \
    --verbose \
    "sqlite:///data/webui.db" \
    "$PG_DSN"

echo ""
echo "==> Migration complete. Verifying row counts in PostgreSQL..."
docker exec postgres psql -U openwebui -d openwebui -c "
SELECT schemaname, tablename, n_live_tup AS rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
"

echo ""
echo "==> Restarting OpenWebUI (still on SQLite for now)..."
docker start openwebui

echo ""
echo "Done. Verify the row counts above look right vs your SQLite:"
sqlite3 "$SQLITE_PATH" "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null || \
  echo "(sqlite3 not installed — check counts manually in pgAdmin or psql)"
echo ""
echo "When happy, merge the compose.yaml PR that adds DATABASE_URL."
