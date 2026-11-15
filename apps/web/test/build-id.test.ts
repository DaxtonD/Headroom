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
import { isStaleBuild, isStamped, shortBuild } from "../src/lib/buildId.js";

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

  it("shortens a sha but leaves anything else alone", () => {
    expect(shortBuild("6efc9d7a1b2c3d4e5f60718293a4b5c6d7e8f901")).toBe("6efc9d7");
    expect(shortBuild("dev")).toBe("dev");
    expect(shortBuild("v1.2.3")).toBe("v1.2.3");
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
