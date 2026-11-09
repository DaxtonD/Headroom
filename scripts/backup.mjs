#!/usr/bin/env node
/**
 * Back up and restore the Headroom database.
 *
 *   node scripts/backup.mjs dump              write a new dump
 *   node scripts/backup.mjs verify <file>     restore it into a throwaway
 *                                             database and check it arrived
 *   node scripts/backup.mjs list              show the dumps you have
 *   node scripts/backup.mjs restore <file>    OVERWRITE the real database
 *
 * Why this exists before the backup sidecar in M6: entering a household's
 * finances by hand takes an evening, and an untested backup is not a backup.
 * `verify` is the point of the whole script - it restores into a scratch
 * database and counts what came back, so "I have a dump" and "I can get my
 * data back" stop being two different claims.
 *
 * It shells out to `pg_dump` inside a `postgres:17-alpine` container rather
 * than needing Postgres client tools installed on this machine, and the
 * container's version therefore always matches the server's major version.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMP_DIR = process.env["BACKUP_DIR"] ?? join(REPO_ROOT, "backups");
const IMAGE = "postgres:17-alpine";

/** The scratch database `verify` restores into. Never the real one. */
const VERIFY_DB = "headroom_verify";

/* -------------------------------------------------------------------------- */
/* Reading the connection string                                              */
/* -------------------------------------------------------------------------- */

/**
 * `DATABASE_URL` from the environment, else from `.env`.
 *
 * Parsed here rather than with a dotenv dependency because this script has to
 * run before anything is installed.
 */
function databaseUrl() {
  if (process.env["DATABASE_URL"]) return process.env["DATABASE_URL"];

  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    fail(
      "No DATABASE_URL in the environment and no .env file.\n" +
        "Copy .env.example to .env and fill in DATABASE_URL first.",
    );
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }

  fail("DATABASE_URL is not set in .env.");
}

/**
 * Parameters Prisma understands and libpq does not.
 *
 * `.env.example` ships `?schema=public`, and `pg_dump` refuses it outright
 * with "invalid URI query parameter", so every command here would have failed
 * on the connection string the setup instructions tell you to write.
 *
 * Dropping `schema` means a dump covers every schema in the database rather
 * than one. For Headroom that is the same thing - everything lives in
 * `public` - and dumping more than asked is the safe direction to err.
 */
const PRISMA_ONLY_PARAMS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "statement_cache_size",
  "socket_timeout",
];

function libpqUrl(url) {
  try {
    const parsed = new URL(url);
    for (const name of PRISMA_ONLY_PARAMS) parsed.searchParams.delete(name);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The same URL as a container can see it.
 *
 * `localhost` inside a container is the container, not this machine, so a URL
 * pointing at localhost has to be rewritten or every command would fail with
 * "connection refused" and no hint as to why.
 */
function urlForContainer(url) {
  return libpqUrl(url).replace(
    /@(localhost|127\.0\.0\.1)(?=[:/])/,
    "@host.docker.internal",
  );
}

function describe(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** The same server, different database. Used for the scratch restore target. */
function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function requireDocker() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    fail("Docker is not available or not running. Start Docker Desktop and try again.");
  }
}

/**
 * Run a Postgres client tool in a container.
 *
 * `--add-host` is what makes `host.docker.internal` work on Linux as well as
 * on Docker Desktop, so the same command serves this machine and Unraid.
 */
function pg(args, { input, text = false } = {}) {
  // Always captured, never inherited: a dump is bytes that have to reach a
  // file, and letting them inherit the terminal printed the database to the
  // screen and wrote a file of `null`.
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--add-host",
      "host.docker.internal:host-gateway",
      IMAGE,
      ...args,
    ],
    {
      ...(text ? { encoding: "utf8" } : {}),
      input,
      maxBuffer: 1024 * 1024 * 1024,
    },
  );

  if (result.error) fail(`Could not run docker: ${result.error.message}`);
  return result;
}

/** stderr as a string, whichever mode the call used. */
function stderrOf(result) {
  if (!result.stderr) return "";
  return typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

function dump() {
  requireDocker();
  const url = databaseUrl();
  mkdirSync(DUMP_DIR, { recursive: true });

  const file = join(DUMP_DIR, `headroom-${timestamp()}.dump`);
  console.log(`Dumping ${describe(url)} ...`);

  // Custom format: compressed, and restorable with pg_restore into a database
  // that already exists.
  const result = pg(["pg_dump", "--format=custom", "--no-owner", "--no-acl", urlForContainer(url)]);

  if (result.status !== 0) {
    fail(
      `pg_dump failed.\n${result.stderr?.toString() ?? ""}\n` +
        "Check DATABASE_URL, and that the server is reachable from a container.",
    );
  }

  writeFileSync(file, result.stdout);
  const size = statSync(file).size;

  if (size < 1024) {
    fail(`The dump is only ${human(size)}, which is too small to be real. Nothing was kept.`);
  }

  console.log(`\n  ${file}\n  ${human(size)}\n`);
  console.log("Now prove you can get it back:");
  console.log(`  node scripts/backup.mjs verify "${file}"\n`);
  return file;
}

/**
 * Restore a dump into a scratch database and count what arrived.
 *
 * This is the only part that turns a file into a backup you can rely on. It
 * never touches the real database: it creates `headroom_verify` on the same
 * server, restores into that, counts rows, and drops it again.
 */
function verify(file) {
  requireDocker();
  if (!file) fail("Which dump? node scripts/backup.mjs verify <file>");
  if (!existsSync(file)) fail(`No such file: ${file}`);

  const url = databaseUrl();
  const admin = urlForContainer(withDatabase(url, "postgres"));
  const target = urlForContainer(withDatabase(url, VERIFY_DB));

  console.log(`Verifying ${file}`);
  console.log(`  into the scratch database "${VERIFY_DB}" on ${describe(url)}`);
  console.log("  (the real database is not touched)\n");

  // Fresh every time, so a stale scratch database cannot make a bad dump look
  // good.
  psql(admin, `DROP DATABASE IF EXISTS ${VERIFY_DB};`);
  psql(admin, `CREATE DATABASE ${VERIFY_DB};`);

  const restored = pg(["pg_restore", "--no-owner", "--no-acl", "--dbname", target], {
    input: readFileSync(file),
    text: true,
  });

  // pg_restore warns about things that do not matter here (missing roles), so
  // the row counts below are the real check rather than the exit status.
  if (restored.status !== 0 && restored.stderr) {
    console.log("pg_restore reported:\n" + restored.stderr.trim() + "\n");
  }

  const counts = psql(
    target,
    `SELECT 'household' AS t, count(*) FROM household
     UNION ALL SELECT 'user', count(*) FROM "user"
     UNION ALL SELECT 'account', count(*) FROM account
     UNION ALL SELECT 'balance_snapshot', count(*) FROM balance_snapshot
     UNION ALL SELECT 'pay_schedule', count(*) FROM pay_schedule
     UNION ALL SELECT 'template', count(*) FROM template
     UNION ALL SELECT 'occurrence', count(*) FROM occurrence
     UNION ALL SELECT 'budget_line', count(*) FROM budget_line
     UNION ALL SELECT 'goal', count(*) FROM goal
     UNION ALL SELECT 'mortgage', count(*) FROM mortgage
     UNION ALL SELECT 'prepayment', count(*) FROM prepayment
     UNION ALL SELECT 'asset', count(*) FROM asset
     ORDER BY t;`,
    { tolerateFailure: true },
  );

  if (counts.status !== 0) {
    psql(admin, `DROP DATABASE IF EXISTS ${VERIFY_DB};`);
    fail(
      "The restored database could not be read, so this dump cannot be trusted.\n" +
        (counts.stderr ?? ""),
    );
  }

  const rows = counts.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 2);

  console.log("Restored row counts:\n");
  let total = 0;
  for (const [table, count] of rows) {
    total += Number(count);
    console.log(`  ${table.padEnd(18)} ${count}`);
  }

  psql(admin, `DROP DATABASE IF EXISTS ${VERIFY_DB};`);

  if (rows.length === 0 || total === 0) {
    fail(
      "\nThe dump restored, but every table is empty. That is not a usable backup.\n" +
        "Check that DATABASE_URL points at the database you think it does.",
    );
  }

  const household = rows.find(([table]) => table === "household");
  if (!household || Number(household[1]) === 0) {
    fail("\nThe restore produced no household row, so this dump is not usable.");
  }

  console.log(`\nVerified: ${total} rows restored and read back. The scratch database is gone.\n`);
}

function psql(url, sql, { tolerateFailure = false } = {}) {
  const result = pg(
    ["psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--dbname", url, "--command", sql],
    { text: true },
  );
  if (!tolerateFailure && result.status !== 0) {
    fail(`psql failed:\n${stderrOf(result)}`);
  }
  return result;
}

function list() {
  if (!existsSync(DUMP_DIR)) {
    console.log(`No dumps yet. ${DUMP_DIR} does not exist.`);
    return;
  }

  const files = readdirSync(DUMP_DIR)
    .filter((name) => name.endsWith(".dump"))
    .map((name) => {
      const full = join(DUMP_DIR, name);
      return { name, size: statSync(full).size, at: statSync(full).mtime };
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  if (files.length === 0) {
    console.log(`No dumps in ${DUMP_DIR}.`);
    return;
  }

  console.log(`${DUMP_DIR}\n`);
  for (const file of files) {
    console.log(
      `  ${file.at.toISOString().slice(0, 19).replace("T", " ")}  ${human(file.size).padStart(9)}  ${file.name}`,
    );
  }
  console.log("");
}

/**
 * Put a dump back into the real database.
 *
 * Destructive and deliberately awkward: it needs `--yes` and it prints what it
 * is about to overwrite first. `--clean` drops the existing objects, so this
 * replaces the contents rather than merging into them.
 */
function restore(file, argv) {
  requireDocker();
  if (!file) fail("Which dump? node scripts/backup.mjs restore <file> --yes");
  if (!existsSync(file)) fail(`No such file: ${file}`);

  const url = databaseUrl();

  if (!argv.includes("--yes")) {
    console.log(`\nThis would REPLACE everything in ${describe(url)}`);
    console.log(`with the contents of ${file}.`);
    console.log("\nNothing has been changed. To go ahead, add --yes:");
    console.log(`  node scripts/backup.mjs restore "${file}" --yes\n`);
    process.exit(1);
  }

  console.log(`Restoring ${file} into ${describe(url)} ...`);

  const result = pg(
    ["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", urlForContainer(url)],
    { input: readFileSync(file), text: true },
  );

  if (stderrOf(result).trim()) console.log(stderrOf(result).trim());
  console.log("\nRestored. Open the app and check the balance and the ledger.\n");
}

/* -------------------------------------------------------------------------- */

const [command = "help", ...rest] = process.argv.slice(2);

switch (command) {
  case "dump":
    dump();
    break;
  case "verify":
    verify(rest[0]);
    break;
  case "list":
    list();
    break;
  case "restore":
    restore(rest[0], rest);
    break;
  default:
    console.log(
      [
        "Headroom backups",
        "",
        "  node scripts/backup.mjs dump              write a new dump",
        "  node scripts/backup.mjs verify <file>     prove it restores",
        "  node scripts/backup.mjs list              show the dumps you have",
        "  node scripts/backup.mjs restore <file> --yes   overwrite the database",
        "",
        `Dumps go in ${DUMP_DIR} (override with BACKUP_DIR).`,
        "DATABASE_URL is read from the environment, else from .env.",
        "",
      ].join("\n"),
    );
}
