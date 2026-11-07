#!/usr/bin/env node
/**
 * Manages the throwaway Postgres that tests and migrations run against.
 *
 * It is deliberately separate from the household's real database: the
 * integrity tests in HANDOFF section 16.8 create, mutate and delete rows, and
 * must never be pointed at live financial data.
 *
 *   node scripts/testdb.mjs up     start it and print the connection string
 *   node scripts/testdb.mjs down   remove it
 *   node scripts/testdb.mjs url    print the connection string
 *
 * In CI there is already a Postgres service container, so set
 * TEST_DATABASE_URL and this script is not needed.
 */
import { execFileSync, spawnSync } from "node:child_process";

const CONTAINER = "headroom-test-db";
const IMAGE = "postgres:17-alpine";
const HOST_PORT = 55432;
const PASSWORD = "headroom-test";
const DB = "headroom_test";

export const TEST_DATABASE_URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:${HOST_PORT}/${DB}?schema=public`;

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}

function requireDocker() {
  const probe = docker(["version", "--format", "{{.Server.Version}}"]);
  if (probe.status !== 0) {
    console.error(
      "Docker is not available or not running. Start Docker Desktop, or set TEST_DATABASE_URL to a Postgres you control.",
    );
    process.exit(1);
  }
}

function containerState() {
  const result = docker(["inspect", "-f", "{{.State.Status}}", CONTAINER]);
  if (result.status !== 0) return "absent";
  return result.stdout.trim();
}

async function waitForReady(timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    const ready = docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", DB]);
    if (ready.status === 0) return;
    lastError = `${ready.stdout ?? ""}${ready.stderr ?? ""}`.trim();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error(`Postgres did not become ready within ${timeoutMs / 1000}s. Last message: ${lastError}`);
  process.exit(1);
}

async function up() {
  requireDocker();
  const state = containerState();

  if (state === "running") {
    await waitForReady();
    console.log(TEST_DATABASE_URL);
    return;
  }

  if (state === "absent") {
    const run = docker([
      "run",
      "--detach",
      "--name",
      CONTAINER,
      "--env",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "--env",
      `POSTGRES_DB=${DB}`,
      // The test database is disposable; keeping it in a tmpfs makes it fast
      // and guarantees nothing survives a restart.
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--publish",
      `127.0.0.1:${HOST_PORT}:5432`,
      IMAGE,
      // Durability is pointless for a disposable database, and turning it off
      // makes the integrity tests noticeably quicker.
      "-c",
      "fsync=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "synchronous_commit=off",
    ]);

    if (run.status !== 0) {
      console.error(`Could not start ${CONTAINER}:\n${run.stderr}`);
      process.exit(1);
    }
  } else {
    const start = docker(["start", CONTAINER]);
    if (start.status !== 0) {
      console.error(`Could not start the existing ${CONTAINER}:\n${start.stderr}`);
      process.exit(1);
    }
  }

  await waitForReady();
  console.log(TEST_DATABASE_URL);
}

function down() {
  requireDocker();
  if (containerState() === "absent") {
    console.log(`${CONTAINER} is not there; nothing to remove.`);
    return;
  }
  execFileSync("docker", ["rm", "--force", "--volumes", CONTAINER], { stdio: "inherit" });
}

const command = process.argv[2] ?? "up";

switch (command) {
  case "up":
    await up();
    break;
  case "down":
    down();
    break;
  case "url":
    console.log(TEST_DATABASE_URL);
    break;
  default:
    console.error(`Unknown command "${command}". Use up, down or url.`);
    process.exit(64);
}
