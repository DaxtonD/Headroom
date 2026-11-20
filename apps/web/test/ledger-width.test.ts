/**
 * The ledger uses the width of the phone it is on.
 *
 * Reported from use, 2026-11-19: "a lot of wasted space on the left and right
 * edges of the screen... everything looks crammed together." Both halves are
 * one problem. Three insets stacked up before any content started:
 * `.shell-main` keeps a 16px gutter for every page, the period card added
 * 16px of its own, and the row inside added another 16px - so a row's content
 * began 48px in from each edge and the name, the chips and the two figures
 * fought over what was left of a 360px phone.
 *
 * The card now bleeds back through the shell's gutter and carries a smaller
 * inset, and the row matches it. Nothing was removed to make room; the space
 * moved from the margins into the text.
 *
 * These are source checks because there is no DOM here. What they are for is
 * the next person who reads a negative margin as a mistake and tidies it out,
 * or who restores the card's old padding without noticing it is now the thing
 * holding the content off the edge.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const ledgerCss = source("src/pages/Ledger.css");
const rowCss = source("src/components/OccurrenceRow.css");
const shellCss = source("src/components/Shell.css");
const ledgerTsx = source("src/pages/Ledger.tsx");

/** The body of the first `@media (min-width: 640px)` block in a file. */
function wideBlock(css: string): string {
  const at = css.indexOf("@media (min-width: 640px)");
  expect(at, "no 640px block").toBeGreaterThan(-1);

  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

describe("the shell still sets one gutter", () => {
  /**
   * The bleed is written as the negative of this. If the gutter ever stops
   * being `--hr-space-4` the two stop cancelling, and the card would either
   * overhang the screen or stop reaching it.
   */
  it("is the token the ledger cancels", () => {
    expect(shellCss).toMatch(/\.shell-main\s*\{[^}]*padding:\s*var\(--hr-space-4\)/);
  });
});

describe("the ledger reaches the edges on a phone", () => {
  it("bleeds the period card and the cards strip by exactly that gutter", () => {
    for (const selector of ["ledger__period", "ledger__cards"]) {
      // Anchored to the start of a line: a base rule sits at column 0 and the
            // overrides inside a media block are indented, so an unanchored
            // match finds whichever happens to come first in the file.
      const rule =
        new RegExp(`^\\.${selector}\\s*\\{[^}]*\\}`, "m").exec(ledgerCss)?.[0] ?? "";
      expect(rule, `no .${selector} rule`).not.toBe("");
      expect(rule, `.${selector} does not bleed`).toMatch(
        /margin-inline:\s*calc\(var\(--hr-space-4\)\s*\*\s*-1\)/,
      );
    }
  });

  /**
   * Below 640px the main column is the whole viewport, so a negative margin
   * exactly cancels its padding. From 640px up it is a centred 640px column
   * and the same margin would hang the card off both sides of it, so the
   * bleed has to stop at the same breakpoint it starts from.
   */
  it("takes the bleed back where the column is centred", () => {
    for (const selector of ["ledger__period", "ledger__cards"]) {
      // Each override must also come AFTER the rule it overrides: a media
      // query carries no extra specificity, so source order is what decides.
      const base = new RegExp(`^\\.${selector}\\s*\\{`, "m").exec(ledgerCss);
      const override = new RegExp(
        `@media \\(min-width: 640px\\) \\{[^@]*?\\.${selector}\\s*\\{[^}]*margin-inline:\\s*0`,
      ).exec(ledgerCss);

      expect(override, `.${selector} never takes its bleed back`).not.toBeNull();
      expect(
        (override?.index ?? -1) > (base?.index ?? 0),
        `the .${selector} override is above the rule it overrides, so it loses to it`,
      ).toBe(true);
    }
  });

  it("gives the card its corners and side borders back there too", () => {
    const wide = wideBlock(ledgerCss);
    expect(wide).toMatch(/border-radius:\s*var\(--hr-radius-card\)/);
  });
});

describe("the row does not add a third inset", () => {
  it("sits at the narrower inset on a phone", () => {
    const summary = /\.row__summary\s*\{[^}]*\}/.exec(rowCss)?.[0] ?? "";
    expect(summary).toMatch(/padding:\s*var\(--hr-space-3\);/);
  });

  it("keeps the tap target well over the minimum", () => {
    // The inset got smaller; the touchable height did not.
    const summary = /\.row__summary\s*\{[^}]*\}/.exec(rowCss)?.[0] ?? "";
    expect(summary).toMatch(/min-height:\s*64px/);
  });

  it("takes the wider inset back where the card has its gutter", () => {
    const wide = wideBlock(rowCss);
    expect(wide).toMatch(/\.row__summary\s*\{[^}]*padding:[^}]*var\(--hr-space-4\)/);
  });

  it("keeps the expanded panel lined up with the summary above it", () => {
    expect(rowCss).toMatch(/\.row__panel\s*\{[^}]*padding:\s*0 var\(--hr-space-3\)/);
    expect(wideBlock(rowCss)).toMatch(/\.row__panel\s*\{[^}]*padding:\s*0 var\(--hr-space-4\)/);
  });
});

describe("the card figures line up with each other", () => {
  /**
   * Reported in the same breath: the Visa's amount did not sit above the
   * TD's. The row is a flex row, and the tail - "owed" on one card, "owed,
   * $x by Wed, Dec 23" on another - was a sibling of the amount, so a longer
   * tail pushed the amount further left on that row alone.
   */
  it("stacks the amount and its tail in one right-aligned column", () => {
    const rule = /\.ledger__card-figures\s*\{[^}]*\}/.exec(ledgerCss)?.[0] ?? "";
    expect(rule, "no .ledger__card-figures rule").not.toBe("");
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/align-items:\s*flex-end/);
  });

  it("wraps them in that column in the markup", () => {
    expect(ledgerTsx).toMatch(
      /ledger__card-figures[\s\S]{0,400}ledger__card-owed[\s\S]{0,400}ledger__card-ahead/,
    );
  });

  /**
   * The actual cause, and worth naming: `grid-column: 2` outlived the grid
   * this row used to be, so it applied to nothing and hid the fact that the
   * tail had become an ordinary flex sibling.
   */
  it("has no grid property left over from the layout this used to be", () => {
    expect(ledgerCss).not.toMatch(/\.ledger__card-ahead\s*\{[^}]*grid-column/);
  });

  it("declares the name once, not twice", () => {
    const declarations = [...ledgerCss.matchAll(/^\.ledger__card-name\s*\{/gm)];
    expect(declarations).toHaveLength(1);
  });
});
