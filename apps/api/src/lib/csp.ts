/**
 * The Content-Security-Policy the app is served under.
 *
 * Held back until the PWA landed, because a service worker, a manifest and a
 * set of icons all have to be allowed by name and writing the policy before
 * they existed would have meant guessing.
 *
 * What this is actually for. Everything on these screens is the household's
 * own money, and the one way a page like that leaks is a script that should
 * not be running: injected through a field somebody typed into, or pulled in
 * by a dependency that changed hands. A policy of `script-src 'self'` plus a
 * hash for the one inline script means a script from anywhere else does not
 * run, whatever put it on the page.
 *
 * ## The inline script, and why its hash is computed rather than written down
 *
 * `index.html` carries one inline script: it reads the chosen theme and text
 * size and applies them before the first paint, because doing it in React
 * instead means every load of a dark theme starts with a flash of white.
 * It cannot become an external file without putting a network round trip in
 * front of the first paint, and it cannot use a nonce without generating the
 * HTML per request, which this serves as a static file.
 *
 * So it is allowed by hash - and the hash is read out of the built file at
 * startup rather than pasted into this module. A hash written down by hand is
 * a hash that goes stale the first time somebody edits that script by a
 * character, and the symptom is the theme silently not applying on a cold
 * load, which is a long way from the change that caused it.
 *
 * ## What is deliberately permissive
 *
 * `style-src` allows `'unsafe-inline'`. React writes `style={{ ... }}` as an
 * inline style attribute - the people's own colours on their initials, the
 * theme swatches in Settings - and CSP has no way to allow those by hash that
 * is supported widely enough to rely on. It is a real weakening and a small
 * one: a style attribute can restyle a page, it cannot execute anything, and
 * `script-src` is what stops the attack this is here for.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Where the fonts come from. The only third party the app talks to. */
const FONT_STYLES = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

/** `<script>` bodies with no `src`, which are the ones needing a hash. */
function inlineScripts(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    if (/\ssrc\s*=/i.test(attributes)) continue;
    const body = match[2] ?? "";
    if (body.trim() !== "") found.push(body);
  }
  return found;
}

/**
 * `'sha256-...'` for each inline script in the built page.
 *
 * The hash is of the script's exact bytes, so this reads the built file -
 * never the source - and any whitespace a build step changes is already
 * accounted for.
 */
export function inlineScriptHashes(indexHtmlPath: string): string[] {
  let html: string;
  try {
    html = readFileSync(indexHtmlPath, "utf8");
  } catch {
    // No built app here, which is normal in development: Vite serves the
    // page and this policy only ever reaches API responses.
    return [];
  }

  return inlineScripts(html).map(
    (body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
  );
}

/**
 * The policy, as @fastify/helmet wants its directives.
 *
 * `useDefaults: false` is set alongside this at the call site, so what is
 * here is the whole policy and not a patch over somebody else's defaults.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[]): Record<string, string[]> {
  return {
    "default-src": ["'self'"],

    // The app and the API are one origin, so everything it needs is 'self'.
    // The hashes are the one inline script in index.html.
    "script-src": ["'self'", ...scriptHashes],
    // Workbox's worker and the runtime it imports, both same-origin.
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],

    // See the note above on 'unsafe-inline'.
    "style-src": ["'self'", "'unsafe-inline'", FONT_STYLES],
    "font-src": ["'self'", FONT_FILES],

    // `data:` for the theme swatches and anything inlined by the build.
    "img-src": ["'self'", "data:"],

    // The API and the change stream, both same-origin. Nothing here should
    // ever be sent anywhere else, and this is the line that says so.
    "connect-src": ["'self'"],

    // Nothing is embedded and nothing embeds this.
    "object-src": ["'none'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],

    // A form on these pages posts to this app or to nowhere.
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
  };
}
