/**
 * Database access.
 *
 * Prisma 7 talks to Postgres through a driver adapter rather than its own
 * engine binary, so the connection is a `pg` pool we own. That is convenient
 * here: Headroom also needs raw `LISTEN/NOTIFY` for the live-update stream
 * (HANDOFF section 16.2), which Prisma cannot express, and that listener wants
 * its own dedicated connection rather than one borrowed from the query pool.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/prisma/client.js";
import type { Env } from "./env.js";

/**
 * A note on `bigint` columns, which is where all the money lives.
 *
 * Prisma's `BigInt` fields already arrive as JavaScript `BigInt`s, so nothing
 * needs doing for normal queries.
 *
 * Do NOT install a global `pg` type parser for OID 20 (int8) to "help" with
 * this. Prisma's driver adapter relies on the driver's default behaviour of
 * returning int8 as a string and converts the value itself; overriding the
 * parser globally makes every Prisma write fail with a confusing type error.
 *
 * Raw `pg` queries therefore return int8 as a string. Convert those at the
 * call site with `BigInt(value)` - never with `Number(value)`, which would
 * silently lose precision above 2^53.
 */

export interface Database {
  readonly prisma: PrismaClient;
  readonly pool: pg.Pool;
  /** Close the pool. Call on shutdown. */
  close(): Promise<void>;
}

export function createDatabase(env: Env): Database {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    // Two users on phones: a small pool is plenty, and it keeps the footprint
    // light on the Unraid box.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "headroom-api",
  });

  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log:
      env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace"
        ? [{ emit: "event", level: "query" }, "warn", "error"]
        : ["warn", "error"],
  });

  return {
    prisma,
    pool,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/**
 * A dedicated connection for `LISTEN`. Kept out of the query pool because a
 * listening connection is pinned for the life of the subscription.
 */
export async function createListener(env: Env): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    application_name: "headroom-listener",
  });
  await client.connect();
  return client;
}
