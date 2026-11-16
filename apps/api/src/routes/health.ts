/**
 * Health check (HANDOFF section 10): the container's health probe and the
 * first thing to curl when something looks wrong.
 *
 * Unauthenticated on purpose, and it deliberately reveals nothing about the
 * household: status, version, server time and whether the database answers.
 */
import type { FastifyInstance } from "fastify";
import { CORE_VERSION } from "@headroom/core";

const STARTED_AT = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    let database: "up" | "down" = "down";
    let databaseError: string | undefined;
    let databaseTime: string | undefined;
    let databaseTimezone: string | undefined;

    try {
      /*
       * The database's own clock, not just a liveness ping.
       *
       * Found in production: the app container was running nearly six hours
       * ahead of the Postgres it writes to. Every timestamp the app sets -
       * a balance's `asOf`, an activity row's `at` - was six hours in the
       * future, and worse, so was the server's idea of *today*, which every
       * figure on every screen is derived from. Nothing anywhere said so.
       *
       * Two clocks that must agree, and only one of them was ever visible.
       */
      const rows = await app.db.prisma.$queryRaw<{ now: Date; tz: string }[]>`
        SELECT now() as now, current_setting('TimeZone') as tz`;
      database = "up";
      databaseTime = rows[0]?.now.toISOString();
      databaseTimezone = rows[0]?.tz;
    } catch (error) {
      databaseError = error instanceof Error ? error.message : "unknown error";
      app.log.error({ err: error }, "health check: database unreachable");
    }

    const healthy = database === "up";

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      database,
      // Only present when something is wrong, and it is a driver message, not
      // household data.
      ...(databaseError ? { databaseError } : {}),
      coreVersion: CORE_VERSION,
      /*
       * The commit this image was built from. The web bundle in the same
       * image carries the same value, so a client comparing the two can tell
       * whether what it is running came from this server's build - which is
       * how a phone holding a stale service-worker cache gets found out.
       */
      buildId: app.env.BUILD_ID,
      // The server clock is authoritative for every timestamp in Headroom
      // (section 16.1 rule 10), so expose it for diagnosis.
      serverTime: new Date().toISOString(),
      /*
       * Null if the database could not be asked. A difference of more than a
       * few seconds means one of the two is wrong, and since the app's clock
       * decides what day it is, "wrong" there changes every figure on every
       * screen rather than just a timestamp.
       */
      databaseTime: databaseTime ?? null,
      clockSkewSeconds:
        databaseTime === undefined
          ? null
          // `trunc`, not `round`: the money guard forbids Math.round and a
          // second either way means nothing here anyway.
          : Math.trunc((Date.now() - new Date(databaseTime).getTime()) / 1000),
      timezone: app.env.TZ,
      /*
       * The zone *this app's own connections* talk in, which `db.ts` pins to
       * UTC. Production's server is configured America/Regina, and before
       * the pin that meant every timestamp the app wrote landed six hours
       * late. Reported because the diagnosis took a day and this one line
       * would have ended it in a minute.
       */
      databaseTimezone: databaseTimezone ?? null,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });
}
