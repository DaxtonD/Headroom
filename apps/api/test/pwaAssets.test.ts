/**
 * The server serves the things that make the app installable.
 *
 * Every one of these is silent when it breaks. A manifest served as plain
 * text is ignored and the install prompt simply never appears; a `sw.js`
 * answered with the HTML shell - which is what a single-page-app fallback
 * does to any path that is not a real file - fails to register with an error
 * nobody is looking at; and a service worker cached by an intermediary pins
 * a household to an old build for as long as that cache lives. None of it
 * shows up on the screen as anything other than "it is not installable" or
 * "my phone still has the old version".
 *
 * Needs the web app built, which the API suite does not do, so it skips when
 * there is no `dist` - the same bargain as the golden seed tests.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness.js";

const DIST = resolve(import.meta.dirname, "..", "..", "web", "dist");
const built = existsSync(resolve(DIST, "index.html"));

describe.skipIf(!built)("the built app, as the server hands it out", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ WEB_DIST_DIR: DIST });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (url: string) => harness.app.inject({ method: "GET", url });

  it("serves the manifest as a manifest", async () => {
    const response = await get("/manifest.webmanifest");
    expect(response.statusCode).toBe(200);

    // Chrome will not install from something served as text/html.
    expect(response.headers["content-type"]).toMatch(/json/);

    const manifest = JSON.parse(response.body) as {
      name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose?: string }[];
      shortcuts?: { url: string }[];
    };
    expect(manifest.name).toBe("Headroom");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
  });

  it("serves every icon the manifest promises", async () => {
    const manifest = JSON.parse((await get("/manifest.webmanifest")).body) as {
      icons: { src: string; sizes: string; purpose?: string }[];
    };

    // A manifest naming an icon that 404s is a manifest Chrome refuses to
    // install from, and nothing says which icon.
    for (const icon of manifest.icons) {
      const response = await get(`/${icon.src.replace(/^\//, "")}`);
      expect(response.statusCode, `${icon.src} is not being served`).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
    }

    // Android needs one it can crop to its own shape; without it the launcher
    // puts our square on a white rounded tile of its own.
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  it("serves the shortcut's target, and iOS's icon, which the manifest does not list", async () => {
    const shortcut = await get("/?update-balance=1");
    expect(shortcut.statusCode).toBe(200);
    expect(shortcut.headers["content-type"]).toContain("text/html");

    // iOS ignores the manifest's icons entirely and reads this one.
    const apple = await get("/apple-touch-icon.png");
    expect(apple.statusCode).toBe(200);

    const favicon = await get("/favicon.ico");
    expect(favicon.statusCode).toBe(200);
  });

  it("serves the service worker as a script, not as the app shell", async () => {
    const response = await get("/sw.js");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    // The giveaway when the single-page fallback has swallowed it.
    expect(response.body.startsWith("<!doctype")).toBe(false);
  });

  it("never lets the worker or the shell be cached", async () => {
    // An intermediary holding either of these pins a phone to an old build.
    for (const path of ["/sw.js", "/manifest.webmanifest", "/"]) {
      const response = await get(path);
      expect(response.headers["cache-control"], `${path} is cacheable`).toContain("no-cache");
    }
  });

  it("still answers a deep link with the app, and an API miss with JSON", async () => {
    // The service worker's navigateFallback does this offline; the server has
    // to do the same on a cold load, or an installed shortcut to /manage 404s.
    const deep = await get("/manage");
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");

    const missing = await get("/api/not-a-route");
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: "not_found" });
  });
});
