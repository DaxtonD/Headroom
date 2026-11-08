/**
 * The live-update stream (HANDOFF section 16.2).
 *
 * Server-Sent Events, not WebSockets: the traffic is one-directional "something
 * changed" pings, SSE reconnects by itself, and it needs no extra protocol
 * through a reverse proxy.
 *
 * A ping carries no amounts. The client invalidates the matching query and
 * refetches through the authenticated API, so the server stays the only source
 * of truth.
 */
import type { FastifyInstance } from "fastify";
import { HttpError } from "../lib/http.js";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/events", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer by default, which would hold pings back.
      "x-accel-buffering": "no",
    });

    const write = (event: string, data: unknown): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tells the client it is connected, so it can drop any "reconnecting"
    // notice and re-enable editing.
    write("ready", { at: new Date().toISOString(), heartbeatSeconds: app.env.SSE_HEARTBEAT_SECONDS });

    const unsubscribe = app.changeStream.subscribe(user.householdId, (ping) => {
      write("changed", ping);
    });

    // Without a heartbeat an idle connection is silently dropped by proxies
    // and phones, and the client would never know to reconnect.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      // A comment line is a valid SSE keep-alive and raises no client event.
      reply.raw.write(`: keep-alive ${Date.now()}\n\n`);
    }, app.env.SSE_HEARTBEAT_SECONDS * 1000);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    request.raw.on("close", close);
    request.raw.on("error", close);

    // Fastify must not try to send a body of its own for this route.
    return reply;
  });
}
