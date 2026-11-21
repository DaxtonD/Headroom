/**
 * The compact ledger.
 *
 * Asked for on 2026-11-21, for the person this app replaced a spreadsheet
 * for: "I like the current UI. She might appreciate seeing more at a glance,
 * like her spreadsheet. This view needs to make more appear on the screen, so
 * we'll need to make some sacrifices on what and how things are displayed. We
 * probably lose the badge and the chips might need to be removed or
 * abbreviated." And on the shape of it: "one column like it is now. We just
 * compact the rows."
 *
 * ## What this holds
 *
 * Source checks, because there is no DOM in this suite - and the three things
 * worth holding are all things a later edit breaks silently.
 *
 * **One row component.** The compact view is a stylesheet keyed off
 * `data-density` on `<html>`. The alternative - a second row written for the
 * compact view - would be two components to keep in step on every future
 * change to a row, and the first thing to drift between them would be the
 * money. There is no symptom to notice until the two disagree.
 *
 * **Hidden, not removed.** Everything given up is hidden VISUALLY and stays
 * in the accessibility tree. A `display: none` on the badges would be shorter
 * and would make compact a worse ledger rather than a tighter one, and no
 * amount of looking at the screen would show it.
 *
 * **44px, still.** The brief's floor for anything a thumb has to hit, and the
 * whole row is the tap target. "More on the screen" has a limit and this is
 * it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DENSITIES } from "../src/lib/appearance.js";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const rowCss = source("src/components/OccurrenceRow.css");
const rowTsx = source("src/components/OccurrenceRow.tsx");
const ledgerCss = source("src/pages/Ledger.css");
const shellTsx = source("src/components/Shell.tsx");
const shellCss = source("src/components/Shell.css");
const appearance = source("src/lib/appearance.ts");
const mainTsx = source("src/main.tsx");

/** Every compact rule, as text, so a question can be asked of the set. */
const compactRules = [rowCss, ledgerCss]
  .flatMap((css) => [...css.matchAll(/\[data-density="compact"\][^{]*\{[^}]*\}/g)])
  .map((match) => match[0]);

describe("how the compact view is built", () => {
  it("has rules at all, in both stylesheets", () => {
    // If this ever reads nothing the regex has stopped matching and every
    // check below would pass against an empty set.
    expect(compactRules.length).toBeGreaterThan(10);
    expect(rowCss).toContain('[data-density="compact"]');
    expect(ledgerCss).toContain('[data-density="compact"]');
  });

  /**
   * One row component, in both views. Every behaviour a row has - the amount
   * editor, verify, mark as paid, moving a flexible bill, the conflict
   * handling, the remove - is therefore identical in compact by construction
   * rather than by having been remembered.
   */
  it("is a stylesheet, not a second row", () => {
    expect(rowTsx).not.toMatch(/compact/i);
    expect(rowTsx).not.toMatch(/density/i);
    expect(source("src/pages/Ledger.tsx")).not.toMatch(/data-density/);
  });

  /** Scoped to the ledger: it is the ledger's density, not the app's. */
  it("changes the ledger and nothing else", () => {
    for (const rule of compactRules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      expect(selector, rule.slice(0, 80)).toMatch(/\.ledger/);
    }
  });

  /** Put on the document before React draws, so nothing is laid out twice. */
  it("is applied before the first render", () => {
    expect(appearance).toContain('root.dataset["density"] = appearance.density;');
    expect(mainTsx).toContain("applyAppearance(getAppearance());");
    expect(mainTsx.indexOf("applyAppearance(getAppearance())")).toBeLessThan(
      mainTsx.indexOf("createRoot(container)"),
    );
  });

  it("offers exactly the two names the stylesheets key off", () => {
    expect(DENSITIES.map((density) => density.key)).toEqual(["comfortable", "compact"]);
    expect(compactRules.length).toBeGreaterThan(0);
    // "comfortable" needs no rules of its own: it is the ledger as written.
    expect(rowCss).not.toContain('[data-density="comfortable"]');
    expect(ledgerCss).not.toContain('[data-density="comfortable"]');
  });
});

describe("what a compact row gives up", () => {
  /**
   * The badge, the second line of chips, the owner line and the first of the
   * chips on the top line. All of them hidden the way `.hr-visually-hidden`
   * does it, so a screen reader is told the same thing in both views.
   */
  it("hides them from the eye and not from a screen reader", () => {
    const hiding = compactRules.find((rule) => rule.includes("clip-path: inset(50%)"));
    expect(hiding, "nothing is being visually hidden").toBeDefined();

    const rule = hiding as string;
    expect(rule).toContain(".badge");
    expect(rule).toContain(".row__chips--about");
    expect(rule).toContain(".row__owner");
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("width: 1px");

    // The one thing that must not be used for any of them.
    for (const compact of compactRules) {
      expect(compact, compact.slice(0, 80)).not.toMatch(/display:\s*none/);
    }
  });

  /**
   * Of the two chips on the top line, the LAST survives - the one that says
   * what kind of row this is and when it falls. `OccurrenceRow.tsx` renders
   * it unconditionally and after the optional one, which is what makes
   * `:not(:last-child)` the right question to ask.
   */
  it("keeps the chip that says what kind of row it is, and when", () => {
    const hiding = compactRules.find((rule) => rule.includes("clip-path: inset(50%)")) as string;
    expect(hiding).toContain(".row__chips > .chip:not(:last-child)");

    // The order in the component is what that selector depends on.
    const chips = rowTsx.slice(
      rowTsx.indexOf('<span className="row__chips">'),
      rowTsx.indexOf("row__chips--about"),
    );
    expect(chips.indexOf("Received")).toBeLessThan(chips.indexOf("Payday"));
    // Always rendered, which is why it is always last.
    expect(chips).toMatch(/\) : row\.isDated \? \(/);
  });

  /** Every figure stays. A denser view that showed fewer is a different one. */
  it("gives up no number anywhere", () => {
    const hiding = compactRules.find((rule) => rule.includes("clip-path: inset(50%)")) as string;
    for (const figure of [
      "row__amount",
      "row__running",
      "ledger__now-amount",
      "ledger__block-left",
      "ledger__subtotal-row",
      "ledger__subtotal-note",
      "hr-amount",
    ]) {
      expect(hiding, `${figure} must not be hidden`).not.toContain(figure);
    }
  });
});

describe("what a compact row keeps", () => {
  /** The floor the brief sets for anything a thumb has to hit. */
  it("is still 44px of row to press", () => {
    const summary = compactRules.find((rule) => rule.includes(".row__summary {")) as string;
    expect(summary).toContain("min-height: var(--hr-touch-min)");
    expect(summary).not.toMatch(/min-height:\s*\d/);
  });

  it("keeps the 44px floor on everything else that is pressable", () => {
    for (const rule of compactRules) {
      const height = /min-height:\s*(\d+)px/.exec(rule)?.[1];
      if (height === undefined) continue;
      // A row that is not a target - the subtotal lines - may go below it.
      // Anything with a min-height in pixels at all must say which it is.
      expect(Number(height), rule.slice(0, 80)).toBeGreaterThanOrEqual(22);
    }
  });

  /**
   * An expanded row goes back to being roomy: the panel is where an amount is
   * typed and a conflict resolved, and none of that is improved by being 20%
   * smaller.
   */
  it("un-compacts a row that has been opened", () => {
    expect(rowCss).toContain('[data-density="compact"] .ledger__rows .row--expanded .row__summary');
  });

  /** The hero is the instant answer this screen exists for. "I like the current UI." */
  it("leaves the top of the ledger alone", () => {
    for (const rule of compactRules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      expect(selector).not.toMatch(/ledger__hero|ledger__pinned|ledger__cards|ledger__warning/);
    }
  });
});

describe("the button in the header", () => {
  it("is where the owner asked for it, not in Settings", () => {
    expect(shellTsx).toContain('aria-label={compact ? "Comfortable rows" : "Compact rows"}');
    expect(shellTsx).toContain("aria-pressed={compact}");
    expect(source("src/pages/Settings.tsx")).not.toMatch(/DENSITIES|density:/);
  });

  it("is a real button at the header's own size", () => {
    expect(shellTsx).toMatch(/<button\s+className=\{`shell-header__settings/);
    expect(shellCss).toMatch(/\.shell-header__settings\s*\{[^}]*min-height:\s*var\(--hr-touch-min\)/);
  });

  /** Dropped on request to make room for it. */
  it("replaced the greeting rather than being squeezed in beside it", () => {
    expect(shellTsx).not.toContain("shell-header__greeting");
    expect(shellTsx).not.toContain("firstNameOf");
    expect(shellCss).not.toContain(".shell-header__greeting {");
  });

  /** The glyph says how many rows you get, which is the one honest icon for this. */
  it("draws the density it is showing", () => {
    expect(shellTsx).toContain("const rows = dense ? 5 : 3;");
    expect(shellTsx).toContain("<RowsIcon dense={compact} />");
  });
});
