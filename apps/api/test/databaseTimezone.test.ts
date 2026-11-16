/**
 * The app and the database have to agree what instant it is.
 *
 * ## Why this exists
 *
 * Production stored every app-written timestamp exactly six hours in the
 * future. Balances were dated ahead, which is how a balance could be typed,
 * saved, acknowledged with a 201, and then ignored by every screen because
 * an older row still carried the later `asOf`.
 *
 * It looked like a clock problem and was not. Every clock involved was
 * correct to the second - the host, both containers and the database all
 * agreed. Six hours is Saskatchewan's whole offset from UTC, and it was the
 * *database* applying it: production's Postgres is configured
 * `TimeZone = America/Regina`, and a `Date` handed to Prisma arrives without
 * an offset, so the server reads it in whatever zone it is set to.
 *
 * Nothing caught it because the throwaway Postgres these tests run against
 * is UTC, like almost every Postgres image, and on a UTC server the bug
 * cannot happen. So this file makes the test database behave like
 * production's and checks that the app is unaffected anyway.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import { migrateTestDatabase, testEnv } from "./helpers/harness.js";

const ZONE = "America/Regina";

let db: Database;
/** A connection with no opinion of its own, to show what the default is. */
let plain: pg.Client;

/** Change the database's own default timezone, as production's config does. */
async function setDatabaseZone(sql: string): Promise<void> {
  const env = testEnv();
  const admin = new pg.Client({ connectionString: env.DATABASE_URL });
  await admin.connect();
  const name = new URL(env.DATABASE_URL).pathname.slice(1);
  await admin.query(`ALTER DATABASE "${name}" ${sql}`);
  await admin.end();
}

beforeAll(async () => {
  migrateTestDatabase();

  // Every new session inherits this unless it says otherwise, which is
  // exactly the shape production is in.
  await setDatabaseZone(`SET timezone = '${ZONE}'`);

  db = createDatabase(testEnv());
  plain = new pg.Client({ connectionString: testEnv().DATABASE_URL });
  await plain.connect();
});

afterAll(async () => {
  await plain.end().catch(() => undefined);
  await db.close();
  await setDatabaseZone("RESET timezone");
});

const WHEN = new Date("2026-06-15T18:30:00.000Z");

async function utcOf(sql: string): Promise<string> {
  const rows = await db.prisma.$queryRawUnsafe<{ utc: string }[]>(sql);
  return rows[0]?.utc ?? "";
}

describe("a database that is not in UTC", () => {
  it("really is set up the way production's is", async () => {
    // Otherwise everything below passes for the wrong reason.
    const { rows } = await plain.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
    expect(rows[0]?.tz, "the hazard is absent, so this file proves nothing").toBe(ZONE);
  });

  it("does not get to decide what zone this app talks in", async () => {
    const rows = await db.prisma.$queryRawUnsafe<{ tz: string }[]>(
      "SELECT current_setting('TimeZone') AS tz",
    );
    expect(rows[0]?.tz).toBe("UTC");
  });
});

describe("an instant the app chose", () => {
  it("is stored as the instant it meant, through raw SQL", async () => {
    await db.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS tz_probe (id INT PRIMARY KEY, ts TIMESTAMPTZ(6))`,
    );
    try {
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO tz_probe (id, ts) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts`,
        WHEN,
      );
      expect(
        await utcOf(
          `SELECT to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
             FROM tz_probe WHERE id = 1`,
        ),
        "the instant shifted on its way into the database",
      ).toBe("2026-06-15T18:30:00Z");
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TABLE tz_probe`);
    }
  });

  it("is stored as the instant it meant, through Prisma's models", async () => {
    /*
     * The path that matters. A balance's `asOf` is a `Date` the app works
     * out and hands to Prisma - not a column with a database default - and
     * it is the one every figure on the home screen depends on.
     */
    const household = await db.prisma.household.create({
      data: { name: "Timezone probe", createdAt: WHEN },
    });
    try {
      expect(
        await utcOf(
          `SELECT to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
             FROM household WHERE id = '${household.id}'`,
        ),
        "a date handed to Prisma shifted on its way into the table",
      ).toBe("2026-06-15T18:30:00Z");

      const back = await db.prisma.household.findUniqueOrThrow({
        where: { id: household.id },
        select: { createdAt: true },
      });
      expect(back.createdAt.toISOString()).toBe(WHEN.toISOString());
    } finally {
      await db.prisma.household.delete({ where: { id: household.id } });
    }
  });

  it("agrees with the database about now", async () => {
    const before = Date.now();
    const now = await utcOf(
      `SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc`,
    );
    const after = Date.now();
    const seen = new Date(now).getTime();
    const drift = Math.min(Math.abs(seen - before), Math.abs(seen - after));
    expect(drift, `the database says ${now}; the app says a different instant`).toBeLessThan(60_000);
  });
});

describe("a plain calendar date", () => {
  it("stays on the day it was meant to be", async () => {
    /*
     * This one would have been catastrophic rather than merely wrong: every
     * dated thing in the ledger is a `@db.Date` built as midnight UTC, and a
     * shift across a day boundary would compute every figure against the
     * wrong day. It survived the bug by luck - six hours past midnight is
     * still the same morning - and should not have to rely on that.
     */
    await db.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS date_probe (id INT PRIMARY KEY, d DATE)`,
    );
    try {
      for (const day of ["2026-01-01", "2026-06-15", "2026-11-13", "2026-12-31"]) {
        await db.prisma.$executeRawUnsafe(
          `INSERT INTO date_probe (id, d) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET d = EXCLUDED.d`,
          new Date(`${day}T00:00:00.000Z`),
        );
        expect(
          await utcOf(`SELECT to_char(d,'YYYY-MM-DD') AS utc FROM date_probe WHERE id = 1`),
          `${day} was stored as a different day`,
        ).toBe(day);
      }
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TABLE date_probe`);
    }
  });
});
