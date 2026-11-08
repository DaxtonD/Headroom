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
import { createRequire } from "node:module";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import type { Env } from "./env.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBalanceRoutes } from "./routes/balance.js";
import { registerBudgetRoutes } from "./routes/budget.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerNetWorthRoutes } from "./routes/netWorth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerOccurrenceRoutes } from "./routes/occurrences.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerViewRoutes } from "./routes/views.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWebApp } from "./routes/web.js";
import { resolveSessionUser, type SessionUser } from "./auth/session.js";
import { HttpError } from "./lib/http.js";
import { LoginThrottle } from "./auth/loginThrottle.js";
import { ChangeStream } from "./lib/changeStream.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, set by the auth hook. Undefined when signed out. */
    user?: SessionUser;
  }
  interface FastifyInstance {
    env: Env;
    db: Database;
    /** Counts FAILED sign-in attempts per IP; a success clears the record. */
    loginThrottle: LoginThrottle;
    /** Relays Postgres change notifications to connected clients over SSE. */
    changeStream: ChangeStream;
  }
}

export interface BuildAppOptions {
  readonly env: Env;
  readonly db: Database;
  /**
   * Supplied by the server so it owns the lifecycle. Tests pass one that is
   * never started, since they drive the app with `inject` rather than over a
   * socket.
   */
  readonly changeStream?: ChangeStream;
}

/** True when pino-pretty is installed, which it is not in the production image. */
function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
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

export async function buildApp({ env, db, changeStream }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log cookies, authorization headers or request bodies: bodies
      // carry amounts and passwords.
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['set-cookie']"],
        remove: true,
      },
      // Pretty logs are a development convenience, and pino-pretty is a dev
      // dependency that is deliberately not in the production image. Asking
      // for it when it is absent makes pino throw at startup, so only use it
      // when it can actually be resolved: NODE_ENV=development against the
      // production image is a perfectly reasonable thing to do.
      transport:
        env.NODE_ENV === "development" && hasPinoPretty()
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
  app.decorate("loginThrottle", new LoginThrottle({ maxFailures: env.LOGIN_RATE_LIMIT }));
  // Tests pass no stream and get an inert one: nothing calls start(), so no
  // LISTEN connection is opened and publishes simply reach no subscribers.
  app.decorate("changeStream", changeStream ?? new ChangeStream(env));
  app.decorateRequest("user", undefined);

  // setReplySerializer, not setSerializerCompiler: the latter only applies to
  // routes that declare a response schema, so any route without one would hit
  // Fastify's default serializer and throw on the first BigInt it met.
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));

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

  // Registered but off by default, so Carol refreshing the dashboard many
  // times a day is never throttled. Login is protected by `loginThrottle`
  // instead, which counts only FAILED attempts: a plain request limiter would
  // also count successful sign-ins and could lock a real user out.
  await app.register(rateLimit, { global: false });

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

    // A 409 carries what the UI needs to offer "Keep theirs" or "Use mine":
    // the current row, which fields clashed, and who changed them. Dropping
    // the details would leave the client with nothing to show.
    const details = error instanceof HttpError ? error.details : undefined;

    return reply.status(statusCode).send({
      error: error.code ?? "request_error",
      message: error.message,
      requestId: request.id,
      ...(details ?? {}),
    });
  });

  await app.register(registerHealthRoutes, { prefix: "/api" });
  await app.register(registerAuthRoutes, { prefix: "/api" });
  await app.register(registerViewRoutes, { prefix: "/api" });
  await app.register(registerOccurrenceRoutes, { prefix: "/api" });
  await app.register(registerBalanceRoutes, { prefix: "/api" });
  await app.register(registerTemplateRoutes, { prefix: "/api" });
  await app.register(registerBudgetRoutes, { prefix: "/api" });
  await app.register(registerGoalRoutes, { prefix: "/api" });
  await app.register(registerNetWorthRoutes, { prefix: "/api" });
  await app.register(registerEventRoutes, { prefix: "/api" });

  // Serve the built web app last, so /api always wins.
  const web = await registerWebApp(app, env);

  // Exactly one not-found handler, because Fastify allows one per prefix and
  // two behaviours depend on it: an API miss is a JSON 404, while any other
  // path is a single-page-app route and gets the app shell, so a deep link
  // like /upcoming survives a cold load.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not_found", message: `No route for ${request.url}` });
    }

    if (web.hasWebApp) {
      return reply.status(200).type("text/html").sendFile("index.html");
    }

    return reply.status(404).send({ error: "not_found", message: "Not found" });
  });

  return app;
}
