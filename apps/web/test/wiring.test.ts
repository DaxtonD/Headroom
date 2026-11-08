/**
 * Does the UI actually reach the API, and does anything reach the UI?
 *
 * Two bugs motivated this file, and both had green tests on either side of the
 * seam they crossed:
 *
 *  1. `usePatchGoal`, `useCreateAsset`, `useCreateCategory` and friends were
 *     written, typechecked and exported — and wired to no button at all. The
 *     Manage screen listed goals, categories and net worth as read-only text,
 *     so the only way to correct one was SQL. Nothing failed, because nothing
 *     asserted that a mutation hook is reachable by a person.
 *
 *  2. An amount typed as $186 arrived as $18,600, because the two sides
 *     disagreed about the wire format. `wire.test.ts` covers that one now.
 *
 * So these are source-level checks rather than behaviour tests. They are cheap
 * and they catch the one thing unit tests on each side structurally cannot:
 * a client and a server that are each correct and not connected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(import.meta.dirname, "..", "src");
const API_SRC = resolve(import.meta.dirname, "..", "..", "api", "src");

function filesUnder(dir: string, extensions: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

const webFiles = filesUnder(WEB_SRC, [".ts", ".tsx"]);
const componentFiles = webFiles.filter((file) => file.endsWith(".tsx"));
const apiSource = filesUnder(API_SRC, [".ts"])
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("every mutation hook is reachable from the interface", () => {
  // The query layer's whole purpose is to be called by a component. A hook
  // nobody calls is a feature nobody can use.
  // Every query module, matched by shape rather than by name. Listing two file
  // names here meant a third one - savingsQueries.ts - would have been exempt
  // from the check the moment it was created, which is exactly the hole this
  // test exists to close.
  const queryLayerFiles = webFiles.filter((file) => /queries\.ts$/i.test(file));

  const hooks = queryLayerFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/^export function (use[A-Za-z0-9]+)\(/gm)].map((match) => ({
      name: match[1] as string,
      file,
    }));
  });

  it("finds the hooks to check", () => {
    // A guard on the guard: if the regex stops matching, the suite must fail
    // loudly rather than silently pass with an empty list.
    expect(hooks.length).toBeGreaterThan(15);
  });

  const componentSource = componentFiles
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const hook of hooks) {
    it(`${hook.name} is used by a component`, () => {
      expect(componentSource).toContain(hook.name);
    });
  }
});

describe("every path the client calls exists on the server", () => {
  /** `/api/goals/${id}` and `/api/goals/:id` have to compare equal. */
  const normalise = (path: string): string =>
    path
      .replace(/^\/api/, "")
      // A query string is not part of the route, and Fastify does not register
      // one. Left in, `/api/year?months=14` could never match `/year`.
      .replace(/\?.*$/, "")
      .replace(/\$\{[^}]*\}/g, ":param")
      .replace(/:[A-Za-z0-9_]+/g, ":param")
      .replace(/\/$/, "");

  /**
   * Every call site, found without trying to parse its type argument.
   *
   * The previous version matched `api.get<...>(` with `<[^>]*>`, which cannot
   * span a multi-line generic that itself contains a `>` - and five of the
   * app's calls look exactly like that, including every whole-screen read.
   * They were silently absent from the comparison, so `/api/year`,
   * `/api/budget`, `/api/goals-overview`, `/api/net-worth` and
   * `/api/setup` were never checked against the server at all.
   *
   * So: find the method, then take the first endpoint-shaped string literal
   * before the next call site. No generic parsing involved.
   */
  const CALL_SITE = /api\.(get|post|patch|put|delete)[(<]/g;

  const callSites = webFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(CALL_SITE)].map((match) => ({
      file,
      method: match[1] as string,
      index: match.index,
      source,
    }));
  });

  const clientPaths = callSites.flatMap((site, position) => {
    const next = callSites[position + 1];
    // Bounded at the next call in the same file, so a URL built in a variable
    // cannot silently borrow the following call's path.
    const until =
      next && next.file === site.file ? next.index : site.source.length;
    const window = site.source.slice(site.index, until);

    const found = /[`"'](\/api\/[^`"']*)[`"']/.exec(window);
    return found
      ? [{ method: site.method, path: found[1] as string, file: site.file }]
      : [];
  });

  const serverRoutes = new Set(
    [...apiSource.matchAll(/app\.(get|post|patch|put|delete)(?:<[^;]*?>)?\(\s*[`"']([^`"']+)[`"']/g)].map(
      (match) => `${match[1] as string} ${normalise(match[2] as string)}`,
    ),
  );

  it("finds the calls to check", () => {
    expect(clientPaths.length).toBeGreaterThan(15);
    expect(serverRoutes.size).toBeGreaterThan(15);
  });

  it("can read every call that exists", () => {
    // A guard on the guard, and it has already earned its place twice: a
    // ternary URL in `useYear` produced no path at all, and five multi-line
    // generics defeated the old regex. Both times the suite stayed green with
    // endpoints entirely unchecked.
    //
    // Any call whose URL this file cannot read now fails here instead of
    // quietly dropping out of the comparison.
    const unreadable = callSites.filter((site, position) => {
      const next = callSites[position + 1];
      const until =
        next && next.file === site.file ? next.index : site.source.length;
      return !/[`"'](\/api\/[^`"']*)[`"']/.test(site.source.slice(site.index, until));
    });

    expect(
      unreadable.map((site) => `${site.file}:${String(site.method)}`),
    ).toEqual([]);
    expect(clientPaths.length).toBe(callSites.length);
  });

  for (const call of clientPaths) {
    // The event stream is an EventSource, not a route registered this way.
    if (call.path.startsWith("/api/events")) continue;

    it(`${call.method.toUpperCase()} ${call.path} is served`, () => {
      expect(serverRoutes).toContain(`${call.method} ${normalise(call.path)}`);
    });
  }
});

describe("the Manage screen can edit everything it lists", () => {
  const manage = readFileSync(join(WEB_SRC, "pages", "Manage.tsx"), "utf8");

  // Each of these is a kind of thing the household has to be able to maintain.
  // Listing one without a form to change it is the bug this file exists for.
  const forms = ["BillForm", "CategoryForm", "GoalForm", "AssetForm", "PaydayForm"];

  for (const form of forms) {
    it(`opens ${form}`, () => {
      expect(manage).toContain(`<${form}`);
    });
  }

  it("offers an edit control on every row", () => {
    // The shared Row renders the Edit button, so every list built from it is
    // editable by construction.
    expect(manage).toMatch(/aria-label=\{`Edit \$\{name\}`\}/);
  });
});
