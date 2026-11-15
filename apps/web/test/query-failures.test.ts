/**
 * A screen that cannot load its data has to say so.
 *
 * This exists because of a bug that was invisible in exactly the way the
 * checks here are meant to catch. A field on the API response was renamed,
 * the client still read the old name, and the read threw inside the query
 * function. Both affected sections of the Savings screen were written as
 * `{overview.data ? ( ... ) : null}` and nothing else, so they did not report
 * an error - they silently were not on the screen at all. The report was "I
 * don't see banked hours or reimbursements anywhere in the UI anymore", which
 * is a much worse thing to be told than "that section failed to load".
 *
 * Two other screens had the same shape with a worse ending, because they fall
 * back to an empty state rather than to nothing:
 *
 *  - Manage printed "No categories yet." A screen that could not reach the
 *    server was stating, as a fact, that the household owns nothing - on the
 *    screen they would open in order to add something.
 *  - The ledger printed "No pay periods yet - add those on Manage". That is
 *    advice, it is wrong, and following it adds a second pay schedule and puts
 *    every cheque on the ledger twice.
 *
 * An empty state and a failure are different answers, and the failure is the
 * one that must not be guessed at.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = resolve(import.meta.dirname, "..", "src", "pages");

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

interface Page {
  readonly name: string;
  readonly text: string;
}

const pages: readonly Page[] = readdirSync(PAGES)
  .filter((entry) => entry.endsWith(".tsx"))
  .map((entry) => ({
    name: entry,
    text: withoutComments(readFileSync(resolve(PAGES, entry), "utf8")),
  }));

/** Identifiers the page reads `.data` from, excluding mutations. */
function queriesRead(text: string): readonly string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b([a-z][A-Za-z0-9]*)\.data\b/g)) {
    const name = match[1] as string;
    // A mutation reports through try/catch at the call site, not a rendered
    // state, and is recognised here by having a `mutateAsync`.
    if (new RegExp(`\\b${name}\\.mutateAsync\\b`).test(text)) continue;
    names.add(name);
  }
  return [...names];
}

describe("a screen that cannot load its data", () => {
  it("found the pages", () => {
    // Otherwise every check below passes having read nothing.
    expect(pages.length).toBeGreaterThanOrEqual(6);
    expect(pages.some((page) => page.name === "Savings.tsx")).toBe(true);
  });

  it("agrees with itself about what counts as a query", () => {
    const text = [
      "const a = useThing();",
      "a.data;",
      "const b = useOther();",
      "b.data;",
      "b.mutateAsync({});",
    ].join("\n");
    expect(queriesRead(text)).toEqual(["a"]);
  });

  it("gives every conditionally-rendered section its own error branch", () => {
    /*
     * The broad rule below is satisfied by a single mention anywhere in the
     * file, so a page with two such sections keeps passing it after one of
     * them loses its branch - which is the likelier regression, since the two
     * are written separately and only one gets edited.
     *
     * This is the narrow, structural rule: a section rendered as
     * `{something.data ? (` must carry that query's error branch within the
     * few lines above it. It matches only the shape that caused the outage,
     * and it fails when either section loses its branch.
     */
    const naked: string[] = [];

    for (const page of pages) {
      const lines = page.text.split("\n");
      lines.forEach((line, index) => {
        const match = /\{\s*([a-z][A-Za-z0-9]*)\.data \? \(/.exec(line);
        if (!match) return;
        const name = match[1] as string;
        const above = lines.slice(Math.max(0, index - 4), index).join("\n");
        if (!new RegExp(`\\b${name}\\.isError\\b`).test(above)) {
          naked.push(`${page.name}:${String(index + 1)}: ${name}.data has no ${name}.isError above`);
        }
      });
    }

    expect(naked.sort()).toEqual([]);
  });

  it("finds the shape it is looking for", () => {
    // The narrow rule is a line-shape match, so it is worth proving it both
    // fires and clears rather than trusting that it found anything at all.
    const savings = pages.find((page) => page.name === "Savings.tsx");
    expect(savings?.text).toMatch(/\{\s*overview\.data \? \(/);
    expect(savings?.text).toMatch(/overview\.isError \?[\s\S]{0,160}\{overview\.data \? \(/);
  });

  it("handles the error state of every query it reads", () => {
    const silent: string[] = [];

    for (const page of pages) {
      for (const name of queriesRead(page.text)) {
        if (!new RegExp(`\\b${name}\\.isError\\b`).test(page.text)) {
          silent.push(`${page.name}: reads ${name}.data but never ${name}.isError`);
        }
      }
    }

    /*
     * A failure here means that if this query fails, the part of the screen
     * that depends on it will either vanish without a word or assert
     * something untrue about the household's money.
     */
    expect(silent.sort()).toEqual([]);
  });
});
