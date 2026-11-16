/**
 * The service worker, which is now ours to keep working.
 *
 * It used to be generated. `generateSW` writes the whole file from the Vite
 * config, so there was nowhere to put a `push` listener, and notifications
 * were the one thing the household asked for that the page cannot do by
 * itself. `injectManifest` hands `src/sw.ts` the precache list and otherwise
 * leaves it alone.
 *
 * That trade moved four behaviours out of a tested library and into a file
 * in this repository. Each one fails silently if it goes:
 *
 *  - no precache and the app simply never works offline;
 *  - no navigation fallback and a cold start on /manage is a blank page;
 *  - `/api` not excluded and a request for money is answered with HTML;
 *  - `clients.claim()` added back and a new build swaps itself in under
 *    somebody halfway through typing a balance.
 *
 * None of that can be exercised here - there is no browser and no service
 * worker to run - so it is checked by reading the file. A weaker test than
 * running it, and a much stronger one than nothing, which is what the switch
 * would otherwise have left behind.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(WEB, path), "utf8").split("\r\n").join("\n");

const sw = read("src/sw.ts");
const config = read("vite.config.ts");

/**
 * The file with its comments removed.
 *
 * Every file in this repository explains itself at length, and these
 * explanations name the very things being searched for - "`clients.claim()`
 * is never called" is a sentence that fails a test looking for
 * `clients.claim(`. Asking "does the code do this" has to mean the code.
 */
const code = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("how the worker is built", () => {
  it("is our file, not a generated one", () => {
    expect(config).toContain('strategies: "injectManifest"');
    expect(config).toContain('filename: "sw.ts"');
    expect(config).toContain('srcDir: "src"');
  });

  it("is a classic worker, not a module one", () => {
    /*
     * A module worker has to be registered with `{ type: "module" }`, and a
     * browser that will not take one fails by there being no service worker
     * at all: no offline shell, no update bar, no notifications, and nothing
     * on screen to say so. The generated worker was classic.
     */
    expect(config).toContain('rollupFormat: "iife"');
  });

  it("is typechecked against WebWorker rather than DOM", () => {
    // A service worker has no `document` and no `window`. Reaching for
    // either should be a compile error, not a blank screen on a phone.
    const worker = read("tsconfig.worker.json");
    expect(worker).toContain('"WebWorker"');
    expect(worker).not.toContain('"DOM"');
    expect(worker).toContain("src/sw.ts");

    // And the app's own config must not try to compile it with DOM libs.
    expect(read("tsconfig.json")).toContain('"exclude": ["src/sw.ts"]');

    // Both configs have to actually run, or the second one checks nothing.
    const scripts = read("package.json");
    expect(scripts).toContain("tsconfig.worker.json");
  });
});

describe("what the generated worker did, and this one still does", () => {
  it("precaches the shell and cleans up after an older build", () => {
    expect(sw).toContain("precacheAndRoute(self.__WB_MANIFEST)");
    expect(sw).toContain("cleanupOutdatedCaches()");
  });

  it("serves the one HTML document for every route", () => {
    expect(sw).toContain("NavigationRoute");
    expect(sw).toContain('createHandlerBoundToURL("index.html")');
  });

  it("never answers an /api request with a page", () => {
    /*
     * A request for data must reach the server or fail honestly. This is
     * also what lets the app ask `/api/health` which build the server is on
     * when the worker itself is the thing that has gone wrong - the one
     * route out of a stale install.
     */
    expect(sw).toMatch(/denylist:\s*\[\/\^\\\/api\\\/\/\]/);
  });

  it("still caches the fonts the way it did", () => {
    expect(sw).toContain('cacheName: "google-fonts-stylesheets"');
    expect(sw).toContain("StaleWhileRevalidate");
    expect(sw).toContain('cacheName: "google-fonts-files"');
    expect(sw).toContain("CacheFirst");
    // A font cached forever under a URL that never changes, and a cap so it
    // cannot grow without bound.
    expect(sw).toContain("maxEntries: 16");
  });
});

describe("it still refuses to take over on its own", () => {
  it("skips waiting only when the page asks", () => {
    expect(sw).toContain('data.type === "SKIP_WAITING"');
    expect(sw).toContain("self.skipWaiting()");
  });

  it("never claims a page that is already open", () => {
    /*
     * The rule since M5: a new build must not swap itself in under somebody
     * halfway through typing a balance. `clientsClaim()` or `clients.claim()`
     * would do exactly that, and both are one line that looks harmless.
     */
    expect(code).not.toMatch(/clientsClaim\s*\(/);
    expect(code).not.toMatch(/clients\s*\.\s*claim\s*\(/);
  });

  it("still answers SKIP_WAITING now that it answers other messages too", () => {
    // One listener handling two message types is one `return` away from
    // handling neither.
    expect(code).toContain('data.type === "SKIP_WAITING"');
    expect(code).toContain('data.type === "WHICH_BUILD"');
  });

  it("calls skipWaiting in one place only", () => {
    // Anywhere other than the message handler is the autoUpdate behaviour
    // wearing a different hat.
    expect([...code.matchAll(/skipWaiting\s*\(/g)]).toHaveLength(1);
  });
});

describe("saying which worker is actually running", () => {
  /*
   * A push subscription belongs to the registration; a push is delivered to
   * whichever worker is *active*. An install still running a worker from
   * before the push handler existed accepts the subscription and then
   * receives nothing - the server sends, the push service accepts, and
   * nothing appears. Nothing distinguishes that from a dozen other causes.
   *
   * A worker new enough to answer is the same generation as one that can
   * receive a push, so silence is the diagnosis.
   */
  it("carries the same build stamp the page and the API carry", () => {
    expect(sw).toContain("import.meta.env.VITE_BUILD_ID");
  });

  it("replies on the port it was given", () => {
    expect(code).toContain("event.ports[0]");
    expect(code).toContain("port.postMessage");
  });

  it("is asked over a channel that cannot hang", () => {
    const lib = read("src/lib/serverBuild.ts");
    expect(lib).toContain('postMessage({ type: "WHICH_BUILD" }');
    expect(lib).toContain("MessageChannel");
    // A worker that never answers must not leave the screen waiting.
    expect(lib).toContain("setTimeout");
  });

  it("is shown beside the other two builds, not only after a test", () => {
    /*
     * The worker is the half that receives a push. A worker older than the
     * page means notifications silently do not arrive while every screen
     * looks current, so it belongs next to "this app" and "the server"
     * rather than behind a button.
     */
    const settings = read("src/pages/Settings.tsx");
    expect(settings).toContain("Background worker");
    expect(settings).toContain("useWorkerBuild");
  });

  it("reports what it found rather than asserting why", () => {
    /*
     * The first version said "this device is still running an older
     * background worker" for every silence, which is a guess dressed as a
     * diagnosis - it cannot tell an old worker from one that is not running.
     */
    const lib = read("src/lib/pushNotifications.ts");
    expect(lib).toContain("did not answer");
    expect(lib, "it has to name the builds so they can be compared").toContain("shortBuild(");
  });
});

describe("notifications", () => {
  it("always shows something, even for a payload it cannot read", () => {
    /*
     * A push that arrives and shows no notification makes Android show its
     * own "This site has been updated in the background" instead, which is
     * alarming and says nothing.
     */
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain("showNotification");
    expect(sw).toContain("FALLBACK");
  });

  it("only ever navigates somewhere inside the app", () => {
    // The payload comes off the network. A url from it that did not have to
    // start with "/" could point a tap anywhere at all.
    expect(sw).toContain('raw.url.startsWith("/")');
  });

  it("focuses the window that is already open", () => {
    // Otherwise a tap leaves the household with two copies of the app.
    expect(sw).toContain('addEventListener("notificationclick"');
    expect(sw).toContain("matchAll");
    expect(sw).toContain("client.focus()");
    expect(sw).toContain("openWindow");
  });
});
