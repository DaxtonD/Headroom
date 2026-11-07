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

    try {
      await app.db.prisma.$queryRaw`SELECT 1`;
      database = "up";
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
      // The server clock is authoritative for every timestamp in Headroom
      // (section 16.1 rule 10), so expose it for diagnosis.
      serverTime: new Date().toISOString(),
      timezone: app.env.TZ,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });
}
