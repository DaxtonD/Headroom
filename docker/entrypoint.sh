#!/bin/sh
# Container entrypoint: wait for the database, migrate, then serve
# (HANDOFF section 10).
#
# Migrations run before the server accepts traffic, so the schema can never be
# behind the code that is already answering requests.
#
# Configuration problems are deliberately NOT diagnosed here. If DATABASE_URL
# is missing this script steps aside and lets the app start, because the app
# validates every variable at once with Zod and prints one complete report
# before exiting 78 (EX_CONFIG). Two places guessing at config errors would
# produce two different, partial messages.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Headroom: DATABASE_URL is not set; starting the app so it can report the configuration problem."
  exec "$@"
fi

# `pg` lives in apps/api/node_modules under pnpm's layout, so the wait script
# has to resolve modules from there rather than from /app.
cd /app/apps/api

echo "Headroom: waiting for the database..."

attempt=1
max_attempts=30
until node -e '
  const pg = require("pg");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 4000,
  });
  client.connect()
    .then(() => client.query("SELECT 1"))
    .then(() => client.end())
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.message); process.exit(1); });
'; do
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
pnpm exec prisma migrate deploy

cd /app
echo "Headroom: starting the server..."
exec "$@"
