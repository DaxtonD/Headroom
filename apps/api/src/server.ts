/**
 * Process entry point.
 *
 * Order matters: validate the environment first and exit loudly if it is
 * wrong, then connect, then listen. An app that handles money should refuse to
 * run half-configured rather than start and misbehave.
 */
import { buildApp } from "./app.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { createDatabase } from "./db.js";
import { generateForAllHouseholds } from "./lib/generateService.js";
import { ChangeStream } from "./lib/changeStream.js";
import { purgeIdempotencyKeys } from "./lib/idempotency.js";
import { EnvValidationError, getEnv } from "./env.js";

const SESSION_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Deliberately console, not the logger: the logger needs config too.
      console.error(`\n${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  // The server clock is authoritative for every timestamp Headroom stores, so
  // pin the zone rather than inheriting whatever the host happens to use.
  process.env.TZ = env.TZ;

  const db = createDatabase(env);

  // The change stream owns a dedicated LISTEN connection, so the server owns
  // its lifecycle rather than the app factory.
  const changeStream = new ChangeStream(env);
  const app = await buildApp({ env, db, changeStream });

  // Fastify's logger only exists once the app is built, so hand it over now.
  changeStream.setLogger({
    info: (object, message) => app.log.info(object as object, message),
    warn: (object, message) => app.log.warn(object as object, message),
    error: (object, message) => app.log.error(object as object, message),
  });

  await changeStream.start();

  const sessionPurgeTimer = setInterval(() => {
    purgeExpiredSessions(db.prisma)
      .then((count) => {
        if (count > 0) app.log.info({ count }, "purged expired sessions");
      })
      .catch((error: unknown) => app.log.error({ err: error }, "session purge failed"));
  }, SESSION_PURGE_INTERVAL_MS);
  sessionPurgeTimer.unref();

  // Idempotency receipts only need to outlive a retry.
  const keyPurgeTimer = setInterval(() => {
    purgeIdempotencyKeys(db.prisma, env.IDEMPOTENCY_KEY_TTL_HOURS)
      .then((count) => {
        if (count > 0) app.log.info({ count }, "purged idempotency keys");
      })
      .catch((error: unknown) => app.log.error({ err: error }, "idempotency purge failed"));
  }, IDEMPOTENCY_PURGE_INTERVAL_MS);
  keyPurgeTimer.unref();

  /**
   * Keep every household's upcoming items filled in.
   *
   * Generation otherwise only happens after a write. The horizon moves
   * forward every day, so a quiet fortnight would shorten the ledger rather
   * than extend it - and an upgrade that adds something every household
   * should have (paydays bringing their paycheque) would not reach anyone
   * until they next edited something.
   *
   * Runs once at startup for that second reason, then on the interval.
   */
  const sweep = (): void => {
    generateForAllHouseholds(db.prisma, {
      info: (object, message) => app.log.info(object as object, message),
      warn: (object, message) => app.log.warn(object as object, message),
    }).catch((error: unknown) => app.log.error({ err: error }, "generation sweep failed"));
  };

  const generationTimer = setInterval(sweep, env.GENERATION_SWEEP_HOURS * 60 * 60 * 1000);
  generationTimer.unref();
  sweep();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    clearInterval(sessionPurgeTimer);
    clearInterval(keyPurgeTimer);
    clearInterval(generationTimer);
    try {
      await changeStream.stop();
      await app.close();
      await db.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandled rejection");
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      { origin: env.APP_ORIGIN, timezone: env.TZ, nodeEnv: env.NODE_ENV },
      "Headroom is listening",
    );
  } catch (error) {
    app.log.error({ err: error }, "failed to start");
    await changeStream.stop();
    await db.close();
    process.exit(1);
  }
}

await main();
