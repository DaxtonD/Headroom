#!/bin/sh
# Container entrypoint: migrate, then serve (HANDOFF section 10).
#
# Migrations run before the server accepts traffic, so the schema can never be
# behind the code that is already answering requests.
set -eu

echo "Headroom: waiting for the database..."

# The database may still be starting, and on Unraid it may be a separate box.
# Retry rather than crash-looping the container.
attempt=1
max_attempts=30
until node -e '
  const pg = require("pg");
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  client.connect()
    .then(() => client.query("SELECT 1"))
    .then(() => client.end())
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.message); process.exit(1); });
' 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Headroom: database still unreachable after ${max_attempts} attempts. Giving up." >&2
    echo "Check DATABASE_URL in .env, and that the database accepts connections from this container." >&2
    exit 1
  fi
  echo "Headroom: database not ready (attempt ${attempt}/${max_attempts}); retrying in 2s..."
  attempt=$((attempt + 1))
  sleep 2
done

echo "Headroom: applying database migrations..."
cd /app/apps/api
pnpm exec prisma migrate deploy
cd /app

echo "Headroom: starting the server..."
exec "$@"
