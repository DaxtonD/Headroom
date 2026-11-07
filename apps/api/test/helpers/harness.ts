/**
 * Test harness: a real Postgres, a real Fastify app, no mocks.
 *
 * The integrity rules in HANDOFF section 16 are mostly enforced by Postgres
 * (row locks, unique constraints, triggers, CHECKs), so testing them against a
 * mock would prove nothing. CLAUDE.md requires these tests to run against a
 * real database.
 *
 * Safety: the connection string must look like a throwaway test database. A
 * test run truncates every table, so pointing it at the household's real data
 * would destroy it. `assertDisposableDatabase` refuses anything that does not
 * clearly identify itself as a test database.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createDatabase, type Database } from "../../src/db.js";
import { parseEnv, type Env } from "../../src/env.js";

const API_DIR = resolve(import.meta.dirname, "../..");

/** What `scripts/testdb.mjs` starts, unless CI supplies its own Postgres. */
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:headroom-test@127.0.0.1:55432/headroom_test?schema=public";

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Refuse to run against anything that is not obviously disposable.
 *
 * This is a guard against a mistyped TEST_DATABASE_URL, not a security
 * boundary: the tests below truncate every table in the schema.
 */
export function assertDisposableDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a URL: ${url}`);
  }

  const databaseName = parsed.pathname.replace(/^\//, "");
  const looksDisposable = /test|ci|tmp|scratch/i.test(databaseName);

  if (!looksDisposable) {
    throw new Error(
      [
        `Refusing to run destructive tests against database "${databaseName}".`,
        "",
        "These tests truncate every table. The database name must contain",
        '"test", "ci", "tmp" or "scratch" so it cannot be the real one.',
        "",
        "Start a throwaway Postgres with:  node scripts/testdb.mjs up",
      ].join("\n"),
    );
  }
}

/** Apply migrations to the test database. Idempotent. */
export function migrateTestDatabase(): void {
  const url = testDatabaseUrl();
  assertDisposableDatabase(url);

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: API_DIR,
    stdio: "pipe",
    env: {
      ...process.env,
      // prisma.config.ts leaves this alone when it is already set, so the
      // root .env can never redirect this at the real database.
      DATABASE_URL: url,
    },
  });
}

export function testEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    // Browsers treat localhost as a secure context, so the PWA rules are met
    // without a certificate in tests.
    APP_ORIGIN: "http://localhost:3000",
    COOKIE_SECURE: "false",
    DATABASE_URL: testDatabaseUrl(),
    SESSION_SECRET: "test-session-secret-".padEnd(64, "0"),
    LOG_LEVEL: "silent",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly env: Env;
  /** Empty every table, leaving the schema in place. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Tables emptied between tests, children before parents. Listed explicitly
 * rather than discovered, so adding a table is a deliberate decision here.
 */
const TABLES = [
  "activity",
  "idempotency_key",
  "balance_snapshot",
  "occurrence",
  "template",
  "budget_line",
  "goal",
  "reimbursement",
  "banked_hours_entry",
  "asset",
  "retirement_settings",
  "pay_schedule",
  "session",
  "account",
  "user",
  "household",
] as const;

export async function createHarness(envOverrides: Partial<Record<string, string>> = {}): Promise<Harness> {
  const env = testEnv(envOverrides);
  assertDisposableDatabase(env.DATABASE_URL);

  const db = createDatabase(env);
  const app = await buildApp({ env, db });
  await app.ready();

  const reset = async (): Promise<void> => {
    // balance_snapshot and activity have triggers that forbid DELETE, so
    // TRUNCATE is the only way to clear them. TRUNCATE fires no row triggers,
    // which is exactly why it works here.
    await db.pool.query(`TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(", ")} CASCADE`);
  };

  return {
    app,
    db,
    env,
    reset,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** A household with two people, mirroring the real setup. */
export async function seedHousehold(harness: Harness) {
  const { hashPassword } = await import("../../src/auth/password.js");

  const household = await harness.db.prisma.household.create({
    data: { name: "Test household" },
  });

  const passwordHash = await hashPassword("correct-horse-battery-staple");

  const carol = await harness.db.prisma.user.create({
    data: {
      householdId: household.id,
      name: "Carol",
      initial: "C",
      email: "carol@example.test",
      passwordHash,
      colorFg: "#2A3C8F",
      colorBg: "#E3E7F7",
    },
  });

  const dax = await harness.db.prisma.user.create({
    data: {
      householdId: household.id,
      name: "Dax",
      initial: "D",
      email: "dax@example.test",
      passwordHash,
      colorFg: "#7A4A00",
      colorBg: "#F3E6CF",
    },
  });

  const account = await harness.db.prisma.account.create({
    data: { householdId: household.id, name: "Chequing" },
  });

  return { household, carol, dax, account, password: "correct-horse-battery-staple" };
}

/** Sign in and return the cookie header to replay on later requests. */
export async function signIn(harness: Harness, email: string, password: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed (${response.statusCode}): ${response.body}`);
  }

  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const session = cookies.find((value) => typeof value === "string" && value.startsWith("headroom_session="));

  if (!session) throw new Error("Sign-in did not set a session cookie.");
  return session.split(";")[0] ?? "";
}
