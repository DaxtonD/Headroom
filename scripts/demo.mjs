#!/usr/bin/env node
/**
 * Runs the demo container for looking at the app.
 *
 *   node scripts/demo.mjs up                      http://localhost:8484
 *   node scripts/demo.mjs up --lan                http://<this machine's IP>:8484
 *   node scripts/demo.mjs up --origin https://dev.headroom.example.com
 *   node scripts/demo.mjs down
 *
 * This is for development only. It uses a throwaway database with invented
 * amounts, never the household's real figures.
 *
 * The reason the origin is a flag rather than a constant: `APP_ORIGIN` has to
 * match the address the browser actually uses, and `COOKIE_SECURE` has to
 * match its scheme. Get either wrong and the symptom is a login that appears
 * to work and then forgets you, because a Secure cookie is silently dropped
 * over plain http. This script derives both from one value so they cannot
 * disagree.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

const CONTAINER = "headroom-demo";
const IMAGE = "headroom:dev";
const HOST_PORT = 8484;
const DB_NAME = "headroom_demo";
const TEST_DB_CONTAINER = "headroom-test-db";

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}

function requireDocker() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.error("Docker is not running. Start Docker Desktop and try again.");
    process.exit(1);
  }
}

/** This machine's address on the house network. */
function lanAddress() {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // Skip the virtual adapters Docker, WSL and VPNs leave behind.
      if (/^(172\.(1[6-9]|2\d|3[01])|169\.254)\./.test(address.address)) continue;
      if (/vEthernet|WSL|Loopback|VPN|wireguard|tun|tap/i.test(name)) continue;
      return address.address;
    }
  }
  return undefined;
}

function parseArgs(argv) {
  const command = argv[0] ?? "up";
  let origin;
  let lan = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lan") lan = true;
    else if (arg === "--origin") {
      origin = argv[i + 1];
      i += 1;
      if (!origin) {
        console.error("--origin needs a URL, e.g. --origin https://dev.headroom.example.com");
        process.exit(64);
      }
    }
  }

  if (!origin) {
    if (lan) {
      const address = lanAddress();
      if (!address) {
        console.error("Could not work out this machine's LAN address. Pass --origin instead.");
        process.exit(1);
      }
      origin = `http://${address}:${HOST_PORT}`;
    } else {
      origin = `http://localhost:${HOST_PORT}`;
    }
  }

  return { command, origin };
}

function up(origin) {
  requireDocker();

  // The one rule that matters: a Secure cookie is only ever sent over HTTPS,
  // so the two settings are derived together from the origin's scheme.
  const isHttps = origin.startsWith("https://");
  const cookieSecure = isHttps ? "true" : "false";

  if (docker(["inspect", TEST_DB_CONTAINER]).status !== 0) {
    console.error(
      `The database container "${TEST_DB_CONTAINER}" is not there. Start it first:\n  node scripts/testdb.mjs up`,
    );
    process.exit(1);
  }

  docker(["rm", "--force", CONTAINER]);

  const run = docker([
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--env",
    `APP_ORIGIN=${origin}`,
    "--env",
    `COOKIE_SECURE=${cookieSecure}`,
    // Plain http is only allowed outside production, and the app enforces that.
    "--env",
    `NODE_ENV=${isHttps ? "production" : "development"}`,
    "--env",
    `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    "--env",
    `DATABASE_URL=postgresql://postgres:headroom-test@host.docker.internal:55432/${DB_NAME}?schema=public`,
    // Published on every interface, so a phone or a reverse proxy can reach it.
    "--publish",
    `0.0.0.0:${HOST_PORT}:3000`,
    IMAGE,
  ]);

  if (run.status !== 0) {
    console.error(`Could not start ${CONTAINER}:\n${run.stderr}`);
    process.exit(1);
  }

  console.log(`${CONTAINER} is starting.`);
  console.log(`  APP_ORIGIN    ${origin}`);
  console.log(`  COOKIE_SECURE ${cookieSecure}`);
  console.log(`  published on  0.0.0.0:${HOST_PORT}`);
  if (!isHttps) {
    console.log("");
    console.log("Note: browsers only treat localhost as a secure context, so the PWA parts");
    console.log("(service worker, install prompt) will not work over plain http on a LAN IP.");
  }
  console.log("");
  console.log(`Follow the log with:  docker logs -f ${CONTAINER}`);
}

function down() {
  requireDocker();
  if (docker(["inspect", CONTAINER]).status !== 0) {
    console.log(`${CONTAINER} is not there; nothing to remove.`);
    return;
  }
  execFileSync("docker", ["rm", "--force", CONTAINER], { stdio: "inherit" });
}

const { command, origin } = parseArgs(process.argv.slice(2));

switch (command) {
  case "up":
    up(origin);
    break;
  case "down":
    down();
    break;
  default:
    console.error(`Unknown command "${command}". Use up or down.`);
    process.exit(64);
}
