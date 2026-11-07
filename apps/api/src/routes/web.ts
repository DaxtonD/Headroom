/**
 * Serves the built web app from the same origin as the API, so one container
 * is the whole deployment (HANDOFF section 10).
 *
 * In development this does nothing: Vite serves the app on its own port and
 * proxies `/api` here, which keeps hot reload working.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";

/** Where the built web app lives when WEB_DIST_DIR is not set explicitly. */
function defaultDistDir(): string {
  // dist/routes/web.js -> apps/api/dist/routes -> apps/web/dist
  return resolve(import.meta.dirname, "../../../web/dist");
}

export async function registerWebApp(app: FastifyInstance, env: Env): Promise<void> {
  const distDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : defaultDistDir();

  if (!existsSync(join(distDir, "index.html"))) {
    app.log.info(
      { distDir },
      "no built web app found; serving the API only (this is expected in development, where Vite serves the app)",
    );

    app.get("/", async (_request, reply) =>
      reply.status(200).type("text/plain").send(
        [
          "Headroom API is running.",
          "",
          "The web app is not built into this process. In development, open the Vite",
          "dev server instead (pnpm dev). In production the built app is served here.",
          "",
          "Health check: /api/health",
        ].join("\n"),
      ),
    );
    return;
  }

  await app.register(fastifyStatic, {
    root: distDir,
    // The service worker and the HTML shell must never be cached by an
    // intermediary, or an update would never reach the phones.
    //
    // @fastify/static types this parameter as a FastifyReply but hands the
    // underlying ServerResponse to it at runtime, so set the header through
    // whichever API is actually present rather than trusting either one.
    setHeaders(target: unknown, path: string) {
      const setHeader = (value: string): void => {
        const candidate = target as {
          setHeader?: (name: string, value: string) => void;
          header?: (name: string, value: string) => void;
        };
        if (typeof candidate.setHeader === "function") {
          candidate.setHeader("cache-control", value);
        } else if (typeof candidate.header === "function") {
          candidate.header("cache-control", value);
        }
      };

      if (path.endsWith("index.html") || path.endsWith("sw.js") || path.endsWith("manifest.webmanifest")) {
        setHeader("no-cache");
      } else if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|svg|webp)$/i.test(path)) {
        // Vite fingerprints these, so they can be cached hard.
        setHeader("public, max-age=31536000, immutable");
      }
    },
  });

  // Single-page app: any non-API path that is not a real file is the shell,
  // so a deep link like /upcoming works on a cold load.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not_found", message: `No route for ${request.url}` });
    }
    return reply.status(200).type("text/html").sendFile("index.html");
  });

  app.log.info({ distDir }, "serving the built web app");
}
