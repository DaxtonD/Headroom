/**
 * Serves the built web app from the same origin as the API, so one container
 * is the whole deployment (HANDOFF section 10).
 *
 * In development this serves nothing: Vite serves the app on its own port and
 * proxies `/api` here, which keeps hot reload working.
 *
 * This module deliberately does NOT install a not-found handler. Fastify
 * allows only one per prefix, and the single handler lives in `app.ts` so that
 * API 404s and the single-page-app fallback are decided in one place.
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

/**
 * True for a build output whose name carries a content hash.
 *
 * Vite names these `index-BqJInBcQ.js`: the hash follows a HYPHEN and is
 * mixed-case base64url, not a lowercase hex segment between dots. Everything
 * Vite fingerprints also lands under `assets/`, which is the reliable signal.
 */
function isFingerprinted(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.includes("/assets/")) return false;
  return /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(normalized);
}

export interface WebAppRegistration {
  /** True when a built web app was found and is being served. */
  readonly hasWebApp: boolean;
  readonly distDir: string;
}

export async function registerWebApp(app: FastifyInstance, env: Env): Promise<WebAppRegistration> {
  const distDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : defaultDistDir();

  if (!existsSync(join(distDir, "index.html"))) {
    app.log.info(
      { distDir },
      "no built web app found; serving the API only (expected in development, where Vite serves the app)",
    );

    app.get("/", async (_request, reply) =>
      reply
        .status(200)
        .type("text/plain")
        .send(
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

    return { hasWebApp: false, distDir };
  }

  await app.register(fastifyStatic, {
    root: distDir,
    // Off, so a path that is not a real file falls through to the not-found
    // handler in app.ts, which serves the app shell for deep links.
    wildcard: false,
    // The plugin sets its own `cache-control: public, max-age=0` and would
    // override whatever setHeaders writes, so turn it off and decide here.
    cacheControl: false,
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
      } else if (isFingerprinted(path)) {
        // Vite fingerprints these, so they can be cached hard: a new build
        // produces a new filename.
        setHeader("public, max-age=31536000, immutable");
      } else {
        // Anything unrecognised gets revalidated rather than cached blindly.
        setHeader("public, max-age=0, must-revalidate");
      }
    },
  });

  // @fastify/static already serves index.html at "/" via its `index` option,
  // so there is no root route to add here. Deep links such as /upcoming are
  // not real files, so they fall through to the not-found handler in app.ts,
  // which sends the same shell.

  app.log.info({ distDir }, "serving the built web app");
  return { hasWebApp: true, distDir };
}
