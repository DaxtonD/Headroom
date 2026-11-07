/**
 * The Fastify application.
 *
 * Built as a function so tests can create an app against a throwaway database
 * without starting a listener (`app.inject()` drives it in-process).
 *
 * One image serves everything: `/api/*` is this server, and everything else is
 * the built web app (HANDOFF section 10).
 */
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import type { Env } from "./env.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWebApp } from "./routes/web.js";
import { resolveSessionUser, type SessionUser } from "./auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, set by the auth hook. Undefined when signed out. */
    user?: SessionUser;
  }
  interface FastifyInstance {
    env: Env;
    db: Database;
  }
}

export interface BuildAppOptions {
  readonly env: Env;
  readonly db: Database;
}

/**
 * JSON has no bigint, and money is bigint cents, so every amount crosses the
 * wire as a decimal string (see `centsToJson` in @headroom/core). Without this
 * replacer a stray BigInt would throw inside the serializer and surface as an
 * opaque 500.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function buildApp({ env, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log cookies, authorization headers or request bodies: bodies
      // carry amounts and passwords.
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['set-cookie']"],
        remove: true,
      },
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } }
          : undefined,
    },
    // Trust the reverse proxy / Tailscale in front of us for client IPs, which
    // the login rate limit depends on.
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
  });

  app.decorate("env", env);
  app.decorate("db", db);
  app.decorateRequest("user", undefined);

  app.setSerializerCompiler(() => (data) => JSON.stringify(data, jsonReplacer));

  await app.register(helmet, {
    // The web app is served from the same origin; CSP is configured with the
    // PWA in M5, where the service worker and manifest are added.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: {},
  });

  await app.register(rateLimit, {
    // Off by default; the login route opts in. Carol refreshing the dashboard
    // many times a day must never be throttled.
    global: false,
  });

  // Resolve the session once per request, before any handler.
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    request.user = await resolveSessionUser(db.prisma, request);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, reqId: request.id }, "request failed");
      return reply.status(statusCode).send({
        error: "internal_error",
        message: "Something went wrong. The change was not saved.",
        requestId: request.id,
      });
    }

    request.log.info({ err: error.message, statusCode }, "request rejected");
    return reply.status(statusCode).send({
      error: error.code ?? "request_error",
      message: error.message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not_found", message: `No route for ${request.url}` });
    }
    // Non-API paths fall through to the web app's own handler.
    return reply.status(404).send({ error: "not_found", message: "Not found" });
  });

  await app.register(registerHealthRoutes, { prefix: "/api" });
  await app.register(registerAuthRoutes, { prefix: "/api" });

  // Serve the built web app last, so /api always wins.
  await registerWebApp(app, env);

  return app;
}
