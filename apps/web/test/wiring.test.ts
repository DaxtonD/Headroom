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
  const queryLayerFiles = webFiles.filter(
    (file) => file.endsWith("manageQueries.ts") || file.endsWith("plannerQueries.ts"),
  );

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
      .replace(/\$\{[^}]*\}/g, ":param")
      .replace(/:[A-Za-z0-9_]+/g, ":param")
      .replace(/\/$/, "");

  const clientPaths = webFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [
      ...source.matchAll(/api\.(get|post|patch|put|delete)<[^>]*>?\(\s*[`"']([^`"']+)[`"']/g),
      ...source.matchAll(/api\.(get|post|patch|put|delete)\(\s*[`"']([^`"']+)[`"']/g),
    ].map((match) => ({
      method: match[1] as string,
      path: match[2] as string,
      file,
    }));
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
