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
import { EnvValidationError, getEnv } from "./env.js";

const SESSION_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  const app = await buildApp({ env, db });

  const purgeTimer = setInterval(() => {
    purgeExpiredSessions(db.prisma)
      .then((count) => {
        if (count > 0) app.log.info({ count }, "purged expired sessions");
      })
      .catch((error: unknown) => app.log.error({ err: error }, "session purge failed"));
  }, SESSION_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    clearInterval(purgeTimer);
    try {
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
    await db.close();
    process.exit(1);
  }
}

await main();
