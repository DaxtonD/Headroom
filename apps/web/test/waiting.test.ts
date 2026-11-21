/**
 * Tabs that no longer feel stuck.
 *
 * Reported from use on 2026-11-21: "we might need to revisit the cache idea.
 * Often, when I click on a tab the UI gets stuck... like it's waiting for the
 * data to load before it's displayed."
 *
 * It was. Every screen here gates its first render on `isPending`, which is
 * right - a budget page drawn before the budget has arrived is a page of
 * zeroes, and a confident wrong number about money is worse than an honest
 * wait. So the fix is in how often that wait happens, and what it looks like
 * when it does.
 *
 * Three parts, and this file holds each of them to what it is for:
 *
 *  1. **The cache outlives the screen.** TanStack throws a query's data away
 *     five minutes after the last screen using it unmounts, so any tab
 *     revisited after five minutes was a cold fetch against a blank page.
 *  2. **The tabs are warmed.** The FIRST visit of a session has nothing
 *     cached whatever the lifetime, because nothing has ever asked.
 *  3. **The wait is a shape.** An empty page and a broken page look the same.
 *
 * And one thing that must NOT have happened, which is the whole reason this
 * file is careful: the household decided on 2026-11-14 that no figure of
 * theirs is written to a phone, and asked again on 2026-11-21 for the
 * in-memory fix only. A cache that persisted would also have fixed the
 * symptom, and would have quietly reversed a decision.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const main = source("src/main.tsx");
const warm = source("src/lib/warmTabs.ts");
const appTsx = source("src/App.tsx");
const session = source("src/lib/session.ts");
const loading = source("src/components/Loading.tsx");
const loadingCss = source("src/components/Loading.css");
const planner = source("src/lib/plannerQueries.ts");
const savings = source("src/lib/savingsQueries.ts");

describe("the cache lasts as long as the app is open", () => {
  it("keeps a query's data after the screen using it has gone", () => {
    expect(main).toContain("gcTime: Infinity");
  });

  /**
   * Which is not a licence to show old numbers. All three of these still
   * hold, and they are what makes a long-lived cache safe: what it changes is
   * whether there is something on screen WHILE the refetch happens.
   */
  it("still refetches as eagerly as it did", () => {
    expect(main).toContain("staleTime: 30_000");
    expect(main).toContain("refetchOnWindowFocus: true");
    expect(main).toContain("refetchOnReconnect: true");
    // A ping from the other phone invalidates everything it could have
    // touched, and coming back to the app does the same.
    expect(source("src/lib/useLiveUpdates.ts")).toContain("invalidateQueries");
    expect(source("src/lib/useLiveUpdates.ts")).toContain("visibilitychange");
  });

  /** The keys that multiply with what is typed into them bound themselves. */
  it("does not keep every what-if forever", () => {
    expect(savings).toContain("gcTime: query === null ? Infinity : 5 * 60_000");
    expect(planner).toContain("gcTime: months === undefined ? Infinity : 5 * 60_000");
  });

  /** In memory, and nowhere else. */
  it("writes nothing to the device", () => {
    for (const file of [main, warm, appTsx]) {
      expect(file).not.toMatch(/persistQueryClient|createSyncStoragePersister|IndexedDB|idb/i);
      expect(file).not.toMatch(/localStorage|sessionStorage/);
    }
    expect(source("package.json")).not.toMatch(/persist-client/);
  });

  /** And the next person at this phone sees none of it. */
  it("is dropped entirely on sign-out", () => {
    expect(session).toContain("queryClient.clear()");
  });
});

describe("the tabs are warmed", () => {
  it("asks for all four tab screens", () => {
    for (const options of [
      "budgetOptions()",
      "yearOptions()",
      "savingsOptions()",
      "setupOptions()",
      "billsOptions()",
    ]) {
      expect(warm, options).toContain(`prefetchQuery(${options})`);
    }
  });

  /**
   * Never ahead of the screen somebody is looking at. The ledger is what
   * opens several times a day and what the brief asks to be instant; four
   * speculative requests in front of it would be the wrong trade exactly.
   */
  it("waits until the browser is doing nothing", () => {
    expect(warm).toContain("requestIdleCallback");
    // Safari was late to it, so there has to be an answer without it.
    expect(warm).toContain("window.setTimeout(task");
  });

  it("cancels itself rather than firing into a dead app", () => {
    expect(warm).toContain("cancelIdleCallback");
    expect(warm).toContain("window.clearTimeout(timer)");
  });

  it("does nothing at all until somebody is signed in", () => {
    expect(warm).toContain("if (!enabled) return;");
    expect(appTsx).toContain("useWarmTabs(Boolean(session.data));");
  });

  /** A phone with no connection has nothing to warm and only failures to get. */
  it("does nothing while offline", () => {
    expect(warm).toContain("navigator.onLine === false");
  });

  /**
   * `prefetchQuery`, not `fetchQuery`: it leaves a fresh entry alone and it
   * never throws, so a warm that fails costs nothing and says nothing. The
   * screen reports its own failure if it is ever opened on one.
   */
  it("is quiet about failing", () => {
    expect(warm).toContain("prefetchQuery");
    // `.fetchQuery(`, so the word inside `prefetchQuery` does not match.
    expect(warm).not.toMatch(/\.fetchQuery\(/);
  });
});

describe("what a wait looks like", () => {
  it("is the shape of the screen that is coming", () => {
    for (const page of ["Budget", "Year", "Savings", "NetWorth", "Manage"]) {
      const file = source(`src/pages/${page}.tsx`);
      expect(file, page).toContain("<Loading");
      // The empty div each of these used to return.
      expect(file, page).not.toMatch(/<div className="\w+" aria-busy="true">\s*\n\s*<p className="hr-visually-hidden">/);
    }
  });

  /**
   * No placeholder figures, ever - not even greyed out. This is a screen
   * about money and a number nobody has fetched is a lie in the one place
   * this app cannot afford one. Blocks cannot be misread as an amount.
   */
  it("shows no number it has not got", () => {
    expect(loading).not.toMatch(/\$|\d+\.\d\d/);
    expect(loading).not.toContain("formatCents");
  });

  it("says what it is waiting for, out of sight", () => {
    expect(loading).toContain('<p className="hr-visually-hidden">{label}</p>');
    expect(loading).toContain('aria-busy="true"');
    // The blocks are decoration and have nothing to say.
    expect(loading).toContain('aria-hidden="true"');
  });

  it("wears the tokens rather than a grey of its own", () => {
    expect(loadingCss).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(loadingCss).toContain("var(--hr-neutral-bg)");
  });

  it("holds still for anybody who asked for no motion", () => {
    expect(loadingCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/,
    );
  });
});
