/**
 * Every design token a stylesheet uses has to exist.
 *
 * CSS fails silently and asymmetrically, which is what makes this worth a
 * test. A `var(--hr-missing)` in a shorthand such as `border: 1px solid
 * var(--hr-missing)` makes the WHOLE declaration invalid at computed-value
 * time, so the border disappears rather than falling back to something; in a
 * longhand such as `color`, the property inherits instead. Either way nothing
 * errors, nothing logs, and the screen simply looks slightly wrong.
 *
 * That is not hypothetical: `--hr-negative` was referenced by the destructive
 * "Remove this" button and by the Year screen's squeeze months, and was never
 * defined. The button had no red border and no red text - it looked like an
 * ordinary link - through every typecheck, lint and test run.
 *
 * Contrast itself is checked by eye against the mockups and by the M5
 * accessibility pass. This only checks that the tokens resolve at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(import.meta.dirname, "..", "src");

function cssFilesUnder(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...cssFilesUnder(full));
    else if (entry.endsWith(".css")) found.push(full);
  }
  return found;
}

const cssFiles = cssFilesUnder(WEB_SRC);
const allCss = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");

/** `--hr-space-4: 16px;` - a definition, anywhere. */
const defined = new Set(
  [...allCss.matchAll(/(--hr-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
);

/** `var(--hr-space-4)` - a use, with or without a fallback. */
const used = [...allCss.matchAll(/var\(\s*(--hr-[a-z0-9-]+)\s*([,)])/g)].map((match) => ({
  token: match[1] as string,
  /** A `var(--x, fallback)` is safe even when `--x` does not exist. */
  hasFallback: match[2] === ",",
}));

describe("design tokens", () => {
  it("finds the stylesheets and the tokens in them", () => {
    // If either of these reads nothing, the regexes have stopped matching and
    // the check below would pass while testing nothing at all.
    expect(cssFiles.length).toBeGreaterThan(5);
    expect(defined.size).toBeGreaterThan(20);
    expect(used.length).toBeGreaterThan(50);
  });

  it("defines every token that is used without a fallback", () => {
    const missing = [
      ...new Set(
        used
          .filter((use) => !use.hasFallback && !defined.has(use.token))
          .map((use) => use.token),
      ),
    ].sort();

    expect(missing).toEqual([]);
  });

  it("keeps the token file as the single source", () => {
    // Tokens belong in tokens.css. A colour defined inside a screen's own
    // stylesheet is a palette change that would not reach the other screens.
    const tokensFile = cssFiles.find((file) => file.endsWith("tokens.css"));
    expect(tokensFile).toBeDefined();

    const elsewhere = cssFiles
      .filter((file) => file !== tokensFile)
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/^\s*(--hr-[a-z0-9-]+)\s*:/gm)].map(
          (match) => `${file}: ${match[1] as string}`,
        );
      });

    expect(elsewhere).toEqual([]);
  });

  it("writes no colour outside the token file", () => {
    /*
     * A literal colour in a screen's own stylesheet is a colour no theme can
     * change. Every one of these was found when the themes went in: a white
     * button label stayed white on a pale green button, the sheet's dim
     * backdrop stayed the light theme's near-black, and the hero's hairline
     * stayed white on a theme whose hero is not dark.
     *
     * Lint cannot see this and neither can a typecheck. It shows up only as
     * one element looking wrong in one theme, which is exactly the kind of
     * thing nobody reports and everybody squints at.
     */
    // Matched inside a declaration's value, so an id selector such as `#root`
    // is never mistaken for a colour.
    const colourInValue = /:[^;{}]*?(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g;

    // This regex is the whole test, so it is checked against a sample first.
    // A pattern that silently stopped matching would pass this file forever.
    expect("a { color: #ffffff; }".match(colourInValue)).not.toBeNull();
    expect("b { background: rgba(0, 0, 0, 0.5); }".match(colourInValue)).not.toBeNull();
    expect("#root { color: var(--hr-ink); }".match(colourInValue)).toBeNull();

    const tokensFile = cssFiles.find((file) => file.endsWith("tokens.css"));

    const literals = cssFiles
      .filter((file) => file !== tokensFile)
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(colourInValue)].map(
          (match) => `${file}: ${match[1] as string}`,
        );
      });

    expect(literals).toEqual([]);
  });
});
