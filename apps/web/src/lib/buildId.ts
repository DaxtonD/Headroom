/**
 * Which build of the app this is.
 *
 * Baked in by Vite at build time from `VITE_BUILD_ID`, which the Dockerfile
 * sets from a build argument CI fills in with the commit sha. The API in the
 * same image reports the same value from `/api/health`, which is what lets
 * the running app notice it is not the build the server is serving.
 *
 * ## Why this exists
 *
 * An installed PWA kept serving an old bundle after a new image was deployed,
 * and nothing anywhere could say so. `/api/health` reported
 * `coreVersion: "0.1.0"` - a constant that has not changed since M0 - so a
 * stale app and a stale image looked identical from the outside, and the only
 * way to tell them apart was to open the site in a browser that had never
 * been used before. That is not a diagnostic anybody should need.
 *
 * `"dev"` in a dev server, and `"unknown"` for an image built outside CI.
 * Neither is compared against anything, because a difference between two
 * values that both mean "no idea" is not news.
 */

/** The build this bundle came from, or a word meaning "not stamped". */
export const BUILD_ID: string = String(import.meta.env.VITE_BUILD_ID ?? "dev") || "dev";

/** Values that mean "this was not stamped", so a mismatch proves nothing. */
const UNSTAMPED = new Set(["dev", "unknown", ""]);

export function isStamped(value: string): boolean {
  return !UNSTAMPED.has(value);
}

/**
 * Is the app running a different build from the one the server is serving?
 *
 * Only ever true when both sides are stamped. A local dev server talking to a
 * CI-built API would otherwise claim to be out of date on every load.
 */
export function isStaleBuild(appBuild: string, serverBuild: string): boolean {
  if (!isStamped(appBuild) || !isStamped(serverBuild)) return false;
  return appBuild !== serverBuild;
}

/** Enough of a commit sha to recognise, without being a wall of hex. */
export function shortBuild(value: string): string {
  return isStamped(value) && /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 7) : value;
}
