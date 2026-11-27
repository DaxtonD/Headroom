/**
 * Knowing which build is running.
 *
 * An installed app served an old bundle for an afternoon while the server was
 * serving a new one. Nothing could say so: `/api/health` reported a version
 * constant unchanged since M0, the service worker's update bar never fired,
 * and the only way to establish what was happening was to open the site in a
 * browser that had never opened it before. The report was "the PWA doesn't
 * update when the new version is pulled and running", which is exactly right
 * and took a day to get to.
 *
 * So both halves of the image are stamped with the commit, and the app
 * compares its own stamp with the server's. These tests cover the comparison
 * and - just as important - the plumbing that supplies the value, because a
 * stamp that silently becomes "unknown" turns the whole mechanism off while
 * leaving every screen looking fine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSameBuild, isStaleBuild, isStamped, shortBuild, shouldOfferRefresh } from "../src/lib/buildId.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Read a repository file with its line endings normalised.
 *
 * The working copy on Windows has CRLF while git stores LF, so a check
 * anchored to a line would pass on one machine and fail on another.
 */
function read(path: string): string {
  return readFileSync(resolve(REPO, path), "utf8").split("\r\n").join("\n");
}

describe("comparing builds", () => {
  it("is stale only when the two differ", () => {
    expect(isStaleBuild("aaaaaaa", "bbbbbbb")).toBe(true);
    expect(isStaleBuild("aaaaaaa", "aaaaaaa")).toBe(false);
  });

  it("never calls an unstamped build stale", () => {
    /*
     * A dev server talking to a CI-built API, or an image someone built by
     * hand, would otherwise announce itself as out of date on every load -
     * and a warning that cries wolf is worse than none, because the real one
     * stops being read.
     */
    expect(isStaleBuild("dev", "abc1234")).toBe(false);
    expect(isStaleBuild("abc1234", "unknown")).toBe(false);
    expect(isStaleBuild("", "abc1234")).toBe(false);
    expect(isStaleBuild("unknown", "dev")).toBe(false);
  });

  it("knows which values mean nothing", () => {
    expect(isStamped("dev")).toBe(false);
    expect(isStamped("unknown")).toBe(false);
    expect(isStamped("")).toBe(false);
    expect(isStamped("6efc9d7")).toBe(true);
  });

  it("knows the same build when it sees it, and only then", () => {
    expect(isSameBuild("abc1234", "abc1234")).toBe(true);
    expect(isSameBuild("abc1234", "def5678")).toBe(false);
    // Not the opposite of stale: two unknowns are not a match either.
    expect(isSameBuild("dev", "dev")).toBe(false);
    expect(isSameBuild("unknown", "unknown")).toBe(false);
  });

  it("shortens a sha but leaves anything else alone", () => {
    expect(shortBuild("6efc9d7a1b2c3d4e5f60718293a4b5c6d7e8f901")).toBe("6efc9d7");
    expect(shortBuild("dev")).toBe("dev");
    expect(shortBuild("v1.2.3")).toBe("v1.2.3");
  });
});

describe("offering a refresh", () => {
  /*
   * Reported from production: "the app continues to prompt that a new
   * version of Headroom is available despite the app and server version
   * matching." A service worker parked in `waiting` re-announces itself on
   * every open and stays parked until every client closes, which an
   * installed app that is only ever backgrounded never does. Tapping the bar
   * could not clear it, because the build it offered was the one running.
   */
  it("says nothing when the server is serving the build already running", () => {
    expect(shouldOfferRefresh(true, "abc1234", "abc1234")).toBe(false);
  });

  it("still offers a build that really is newer", () => {
    expect(shouldOfferRefresh(true, "abc1234", "def5678")).toBe(true);
  });

  it("offers nothing when the worker has nothing waiting", () => {
    expect(shouldOfferRefresh(false, "abc1234", "def5678")).toBe(false);
    expect(shouldOfferRefresh(false, "abc1234", null)).toBe(false);
  });

  it("errs towards offering when it cannot tell", () => {
    /*
     * The suppression runs on positive evidence only. Hiding a real update
     * because the server could not be reached, or because a hand-built image
     * carries no stamp, is the worse of the two failures: the household
     * would be stuck on an old build with nothing on screen saying so, which
     * is the bug this whole mechanism was added for.
     */
    expect(shouldOfferRefresh(true, "abc1234", null)).toBe(true);
    expect(shouldOfferRefresh(true, "dev", "abc1234")).toBe(true);
    expect(shouldOfferRefresh(true, "abc1234", "unknown")).toBe(true);
    expect(shouldOfferRefresh(true, "dev", "dev")).toBe(true);
  });

  it("is what the bar actually asks", () => {
    /*
     * Structural, because the logic above is only worth anything if the
     * component consults it. Rendering on a bare `needRefresh` is exactly
     * the bug, and it reads as perfectly reasonable code.
     */
    const source = read("apps/web/src/components/UpdateReady.tsx");
    expect(source).toContain("shouldOfferRefresh(needRefresh, BUILD_ID, serverBuild)");
    expect(source, "a bare needRefresh check is the bug").not.toMatch(/if \(!needRefresh\) return/);
  });

  it("reloads by the route that does not trust the worker", () => {
    /*
     * Both bars reload through `loadServerBuild`, which waits to see whether
     * a worker took over and unregisters it when it did not.
     * `updateServiceWorker` posts the same message and reloads immediately,
     * so the reload is served by the worker still in charge - the old one -
     * and the bar comes straight back.
     */
    const source = read("apps/web/src/components/UpdateReady.tsx");
    const reloads = [...source.matchAll(/onClick=\{\(\) => void (\w+)\(/g)].map((m) => m[1]);
    expect(reloads).not.toHaveLength(0);
    for (const call of reloads) expect(call).toBe("loadServerBuild");
  });

  it("waits for the handover before reloading", () => {
    // Posting SKIP_WAITING and reloading in the same breath reloads through
    // the worker that is still in charge, which serves the old bundle again.
    const source = read("apps/web/src/lib/serverBuild.ts");
    expect(source).toContain("controllerchange");
    const post = source.indexOf('postMessage({ type: "SKIP_WAITING" })');
    const wait = source.indexOf("await takeover");
    expect(post).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(post);
    /*
     * And when a worker that EXISTS and is newer will not take over, that
     * registration goes.
     *
     * This asserted `if (!tookOver)`, which was the bug reported on
     * 2026-11-25: "no promotion" is also the answer when there was nothing
     * newer to promote, so the healthy case was answered by unregistering -
     * which takes the device's push subscription with it. The outcome is a
     * tri-state now and only the provable one is destructive.
     */
    expect(source).toContain('"nothing-to-promote"');
    expect(source).toMatch(/entry\.outcome === "stuck"/u);
    expect(source).not.toMatch(/if \(!tookOver\)/);
  });
});

/**
 * Why the worker kept lagging several builds behind the app and the server.
 *
 * Reported from use on 2026-11-22, and not new: "the background worker never
 * matches the app or server version after an update", resolving itself after
 * a day or two. The mechanism was a chain of three small things.
 *
 * `registration.update()` resolves once the worker SCRIPT has been fetched
 * and the install has been *started* - not finished - and installing means
 * precaching over half a megabyte. The promotion then looked only for a
 * `waiting` worker, found none because the new one was still `installing`,
 * concluded after three seconds that the lifecycle would not cooperate, and
 * **unregistered** it. `unregister()` on a registration that still has clients
 * is deferred by the browser; the reload that followed was not. So the page
 * came back fresh from the network - new bundle - beside a registration whose
 * active worker was still the old one. New app, new server, old worker.
 *
 * An installed app that is only ever backgrounded never drops to zero clients,
 * so that state persisted until Android eventually killed the app, which is
 * the "day or two".
 */
describe("promoting a worker that is still installing", () => {
  const source = read("apps/web/src/lib/serverBuild.ts");

  it("looks at the installing worker, not only the waiting one", () => {
    // The whole bug in one expression. Right after `update()` a brand-new
    // worker is almost always still installing, so looking only at `waiting`
    // found nothing exactly when there was something to find.
    expect(source).toContain("registration.waiting ?? registration.installing");
  });

  it("lets a precache finish rather than timing out over it", () => {
    expect(source).toContain('candidate.state === "installing"');
    expect(source).toMatch(/waitForState\(\s*candidate/u);

    // Long enough for half a megabyte on mobile data. The old single wall
    // was three seconds for the whole promotion, install included.
    const cap = /const INSTALL_CAP_MS = (\d[\d_]*)/u.exec(source)?.[1]?.replace(/_/gu, "");
    expect(Number(cap)).toBeGreaterThanOrEqual(15_000);
  });

  it("counts reaching activated as taking over, not only controllerchange", () => {
    /*
     * `controllerchange` only fires for a page the new worker claims, and
     * this app does not claim on activation. For a page the OLD worker
     * controls it may never fire - so a worker that had taken over perfectly
     * well was judged to have failed, and unregistered.
     *
     * Reaching `activated` is enough: from that moment the registration's
     * active worker is the new one, which is what the reload gets served by.
     */
    const takeover = source.slice(source.indexOf("async function waitForTakeover"));
    const body = takeover.slice(0, takeover.indexOf("\n}"));
    expect(body).toContain("controllerchange");
    expect(body).toMatch(/worker\.state === "activated"/u);
  });

  it("gives up early on a worker that can never get there", () => {
    // Redundant means replaced or failed. Waiting out the timeout would only
    // delay the fallback without changing its answer.
    const takeover = source.slice(source.indexOf("async function waitForTakeover"));
    expect(takeover.slice(0, takeover.indexOf("\n}"))).toMatch(/redundant/u);
  });

  it("tries every registration before resorting to unregistering any", () => {
    /*
     * Unregistering is the step that produced the mismatch, because the
     * reload takes effect and the unregister does not. It stays available -
     * a lifecycle that truly will not move needs it - but it is now the last
     * resort it was written as rather than the common path.
     */
    expect(source).toContain("await promote(registration, serverBuild)");
    const promote = source.indexOf("await promote(registration, serverBuild)");
    const unregister = source.indexOf(".unregister()");
    expect(promote).toBeGreaterThan(-1);
    expect(promote).toBeLessThan(unregister);
  });

  it("needs the server's build before it will destroy anything", () => {
    /*
     * The proof that a registration is stuck rather than merely current.
     * Without it the two are indistinguishable, which is how the common case
     * came to be answered with the destructive one. Where it cannot tell -
     * the worker did not answer, or nothing is known about the server - it
     * leaves the registration alone.
     */
    const promote = source.slice(source.indexOf("async function promote"));
    const body = promote.slice(0, promote.indexOf("\n}"));
    expect(body).toMatch(/serverBuild === null\) return "nothing-to-promote"/u);
    expect(body).toMatch(/build === serverBuild \? "nothing-to-promote" : "stuck"/u);
  });
});

/**
 * A page that nothing is serving.
 *
 * The other half of the same report. After the unregister-and-reload above,
 * the page has no controller at all - and because `clients.claim()` is never
 * called on activation, nothing ever adopted it. It works, because it came
 * from the network, but it has no offline cache for the rest of its life.
 */
describe("adopting an uncontrolled page", () => {
  const source = read("apps/web/src/lib/serverBuild.ts");

  it("asks only when there is no controller to replace", () => {
    /*
     * The M5 rule stands for the case it was written for: a new build must
     * not swap itself in under somebody mid-edit. This is not that case, and
     * the guard is what keeps the two apart.
     */
    const claim = source.slice(source.indexOf("export async function claimIfUncontrolled"));
    const body = claim.slice(0, claim.indexOf("\n}"));
    expect(body).toContain("navigator.serviceWorker.controller !== null) return");
  });

  it("asks only a worker of its own build", () => {
    // A newer worker would answer this page's hashed chunk requests from a
    // newer precache, and the first screen not yet opened would 404.
    const claim = source.slice(source.indexOf("export async function claimIfUncontrolled"));
    const body = claim.slice(0, claim.indexOf("\n}"));
    expect(body).toMatch(/askBuild\(active/u);
    expect(body).toMatch(/build !== BUILD_ID\)/u);
    // The claim itself is reached only after that guard.
    const guard = body.indexOf("build !== BUILD_ID)");
    const asks = body.indexOf('postMessage({ type: "CLAIM" })');
    expect(guard).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(guard);
  });

  it("asks for the right worker instead of only declining the wrong one", () => {
    /*
     * The mismatch branch used to return and do nothing else, so a device
     * sat uncontrolled behind an old worker until the browser's own update
     * check came round - "it seems like it resolves itself after a day or
     * two", 2026-11-25. Once per page, because an update is a half-megabyte
     * fetch and this is called repeatedly.
     */
    const claim = source.slice(source.indexOf("export async function claimIfUncontrolled"));
    expect(claim.slice(0, claim.indexOf("\n}"))).toContain("askForNewWorker(registration)");
    const asker = source.slice(source.indexOf("async function askForNewWorker"));
    const body = asker.slice(0, asker.indexOf("\n}"));
    expect(body).toContain("if (updateRequested) return;");
    expect(body).toContain("registration.update()");
  });

  it("keeps asking while the worker is still installing", () => {
    // A worker mid-install has no `active` yet, so one attempt on mount
    // answers about timing rather than about state.
    const hook = source.slice(source.indexOf("export function useClaimIfUncontrolled"));
    expect(hook).toContain("attempts < 5");
    expect(hook).toContain("navigator.serviceWorker.controller !== null) return");
  });

  it("runs on every load, not only once somebody is signed in", () => {
    // A page nothing is serving has no offline cache whoever is looking at
    // it, including on the sign-in screen.
    const bar = read("apps/web/src/components/UpdateReady.tsx");
    expect(bar).toContain("useClaimIfUncontrolled()");
  });
});

/**
 * Settings has to be able to tell the two apart.
 *
 * `controlled` was computed and then thrown away, so an old worker still in
 * charge and a correct worker that had not adopted the page read identically
 * on screen. That is why this could only be guessed at when it was reported -
 * which is the exact failure the three build lines were added to prevent.
 */
describe("what the worker line says", () => {
  it("says when a worker is running but not serving this page", () => {
    const settings = read("apps/web/src/pages/Settings.tsx");
    expect(settings).toContain("worker.controlled ?");
    expect(settings).toContain("not serving this page yet");
  });
});

describe("the plumbing that supplies the stamp", () => {
  const dockerfile = read("Dockerfile");
  const ci = read(".github/workflows/ci.yml");

  it("still has all of its stages", () => {
    /*
     * Added after breaking the image. "FROM base AS runtime" is a prefix of
     * "FROM base AS runtime-deps", so a single textual replacement aimed at
     * the runtime stage landed on the deps stage and renamed it - which made
     * every `COPY --from=runtime-deps` resolve to a public image instead of a
     * local stage. The build failed outright, but the check below passed,
     * because it only looked for a stage whose first line was
     * "base AS runtime" and the mangled one qualified.
     */
    const names = [...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((match) => match[1]);
    expect(names).toEqual(["base", "deps", "build", "runtime-deps", "runtime"]);

    // Every stage a later stage copies from has to be one of those names.
    for (const match of dockerfile.matchAll(/--from=([A-Za-z0-9_-]+)/g)) {
      expect(names).toContain(match[1]);
    }
  });

  it("declares the build argument in both stages that need it", () => {
    // Docker scopes ARG per stage, so one declaration is not enough: the web
    // bundle is stamped in `build` and the API reads its own in `runtime`.
    const stages = dockerfile.split(/^FROM /m);
    const build = stages.find((stage) => stage.startsWith("deps AS build"));
    const runtime = stages.find((stage) => /^base AS runtime$/m.test(stage.split("\n")[0] ?? ""));

    expect(build, "no build stage found").toBeDefined();
    expect(runtime, "no runtime stage found").toBeDefined();
    expect(build).toMatch(/ARG BUILD_ID/);
    expect(runtime).toMatch(/ARG BUILD_ID/);
    expect(runtime).toMatch(/ENV BUILD_ID=\$BUILD_ID/);
  });

  it("passes it to the web build, where Vite can bake it in", () => {
    // Without this the bundle reports "dev" in production and the comparison
    // silently stops happening.
    expect(dockerfile).toMatch(/VITE_BUILD_ID="\$BUILD_ID" pnpm -F @headroom\/web build/);
  });

  it("is given the commit by CI, for every image it builds", () => {
    const passes = [...ci.matchAll(/BUILD_ID=\$\{\{ github\.sha \}\}/g)];
    const builds = [...ci.matchAll(/docker\/build-push-action/g)];

    expect(builds.length).toBeGreaterThanOrEqual(1);
    // Every docker build gets one, so the image that is tested and the image
    // that is published cannot be stamped differently - or not at all.
    expect(passes).toHaveLength(builds.length);
  });

  it("documents the variable, as every new one must be", () => {
    expect(read(".env.example")).toMatch(/BUILD_ID/);
  });
});
