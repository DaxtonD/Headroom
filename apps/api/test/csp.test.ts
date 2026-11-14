/**
 * The Content-Security-Policy, checked against the page it is protecting.
 *
 * The failure worth guarding is specific. `index.html` carries one inline
 * script - it applies the chosen theme before the first paint, so a dark
 * theme does not start with a flash of white - and CSP can only allow it by
 * hash. Edit that script by one character without updating the hash and the
 * browser silently refuses to run it: the theme stops applying on a cold
 * load, nothing else breaks, nothing is logged anywhere anybody looks, and
 * the cause is nowhere near the symptom.
 *
 * So the hash is computed from the built page at startup rather than written
 * down, and this proves it: it hashes every inline script in the real built
 * file and insists the policy names each one.
 *
 * Skips without a build, like the other tests that need one.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inlineScriptHashes } from "../src/lib/csp.js";
import { createHarness, type Harness } from "./helpers/harness.js";

const DIST = resolve(import.meta.dirname, "..", "..", "web", "dist");
const INDEX = resolve(DIST, "index.html");
const built = existsSync(INDEX);

/** The directives, as `{ "script-src": "'self' 'sha256-…'" }`. */
function parse(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name as string, values.join(" ")];
      }),
  );
}

describe.skipIf(!built)("the content security policy", () => {
  let harness: Harness;
  let directives: Record<string, string>;

  beforeAll(async () => {
    harness = await createHarness({ WEB_DIST_DIR: DIST });
    const response = await harness.app.inject({ method: "GET", url: "/" });
    const header = response.headers["content-security-policy"];
    expect(header, "no CSP on the page itself").toBeTruthy();
    directives = parse(String(header));
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("allows every inline script the built page actually contains", () => {
    const html = readFileSync(INDEX, "utf8");

    // Worked out here independently of the code under test, so the two
    // agreeing means something.
    const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((match) => !/\ssrc\s*=/i.test(match[1] ?? ""))
      .map((match) => match[2] ?? "")
      .filter((body) => body.trim() !== "");

    expect(inline.length, "no inline script in the page - has it moved?").toBeGreaterThan(0);

    for (const body of inline) {
      const hash = createHash("sha256").update(body, "utf8").digest("base64");
      expect(
        directives["script-src"],
        `an inline script is not allowed by the policy: ${body.trim().slice(0, 60)}…`,
      ).toContain(`'sha256-${hash}'`);
    }
  });

  it("allows nothing else to run", () => {
    expect(directives["script-src"]).toContain("'self'");
    // The two that turn a CSP into decoration.
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["object-src"]).toBe("'none'");
    expect(directives["base-uri"]).toBe("'self'");
  });

  it("keeps the household's figures on this origin", () => {
    // The line that says the balances are never sent anywhere else.
    expect(directives["connect-src"]).toBe("'self'");
    // And nobody frames this to read it.
    expect(directives["frame-ancestors"]).toBe("'none'");
  });

  it("still lets the things the page needs through", () => {
    // The webfonts, or the whole app falls back to a system font.
    expect(directives["style-src"]).toContain("https://fonts.googleapis.com");
    expect(directives["font-src"]).toContain("https://fonts.gstatic.com");
    // The service worker and the manifest, both same-origin.
    expect(directives["worker-src"]).toBe("'self'");
    expect(directives["manifest-src"]).toBe("'self'");
    // React writes inline style attributes; see the note in lib/csp.ts.
    expect(directives["style-src"]).toContain("'unsafe-inline'");
  });

  it("covers the API as well as the page", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["content-security-policy"]).toBeTruthy();
  });
});

describe("hashing the page", () => {
  it("ignores scripts that have a src", () => {
    // Those are covered by 'self'; hashing them would be meaningless.
    const html = `<script type="module" src="/assets/index-abc.js"></script>`;
    const file = resolve(import.meta.dirname, "fixtures-csp-src.html");
    writeThenRead(file, html, (hashes) => expect(hashes).toEqual([]));
  });

  it("hashes each inline script separately", () => {
    const html = `<script>one()</script><script>two()</script>`;
    const file = resolve(import.meta.dirname, "fixtures-csp-two.html");
    writeThenRead(file, html, (hashes) => {
      expect(hashes.length).toBe(2);
      expect(new Set(hashes).size).toBe(2);
    });
  });

  it("returns nothing when there is no built page, rather than throwing", () => {
    // Development: Vite serves the page and this policy only reaches the API.
    expect(inlineScriptHashes(resolve(import.meta.dirname, "no-such-file.html"))).toEqual([]);
  });
});

function writeThenRead(file: string, html: string, check: (hashes: string[]) => void): void {
  writeFileSync(file, html, "utf8");
  try {
    check(inlineScriptHashes(file));
  } finally {
    rmSync(file, { force: true });
  }
}
