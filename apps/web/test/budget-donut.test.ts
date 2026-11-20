/**
 * The budget ring, as a thing on a screen rather than as arithmetic.
 *
 * The maths is tested with values in `donut.test.ts`. What is left is the set
 * of promises the chart makes to the person reading it, and those are the
 * ones that get quietly broken by a later edit:
 *
 *  - the ring is not the accessible control, and must not pretend to be;
 *  - no share is ever carried by colour alone;
 *  - the colours come from the tokens that were checked, not from hex typed
 *    into a component;
 *  - an animation can be turned off.
 *
 * Source checks, because there is no DOM in this suite.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const donutTsx = source("src/components/BudgetDonut.tsx");
const donutCss = source("src/components/BudgetDonut.css");
const budgetTsx = source("src/pages/Budget.tsx");
const budgetCss = source("src/pages/Budget.css");
const tokens = source("src/styles/tokens.css");

describe("the list is the real control, not the wedges", () => {
  /**
   * A 1.6% wedge is a few pixels of arc. It cannot be a 44px touch target,
   * so the row underneath is the control and the wedge is a shortcut for a
   * pointer. The svg says nothing to a screen reader because the row says it
   * all, with the name and the amount written out.
   */
  it("hides the drawing from assistive technology", () => {
    expect(donutTsx).toMatch(/<svg[\s\S]{0,200}aria-hidden="true"/);
  });

  it("makes every line a real button that says whether it is chosen", () => {
    expect(budgetTsx).toMatch(/<button\s+type="button"\s*\n?\s*className=\{`budget__line-button/);
    expect(budgetTsx).toMatch(/aria-pressed=\{chosen\}/);
  });

  it("gives that button the minimum touch height", () => {
    const rule = /\.budget__line-button\s*\{[^}]*\}/.exec(budgetCss)?.[0] ?? "";
    expect(rule, "no .budget__line-button rule").not.toBe("");
    expect(rule).toMatch(/min-height:\s*var\(--hr-touch-min\)/);
  });
});

describe("identity is never colour alone", () => {
  it("puts a swatch on the row, so the ring has a legend", () => {
    expect(budgetTsx).toMatch(/budget__line-swatch/);
    expect(budgetCss).toMatch(/\.budget__line-swatch\s*\{/);
  });

  /**
   * The list keeps every figure. That is the table view the colour rules ask
   * for, and it is why the lighter wedges are allowed on a light card at all.
   */
  it("keeps the amount and the share beside every name", () => {
    expect(budgetTsx).toMatch(/budget__line-amount/);
    expect(budgetTsx).toMatch(/budget__share-pct/);
  });
});

describe("the colours are the ones that were checked", () => {
  it("are read from tokens, never written into the component", () => {
    expect(donutTsx).toMatch(/var\(--hr-series-\$\{slice\.slot \+ 1\}\)/);
    // A hex in here would be a colour nobody validated against the surfaces.
    expect(donutTsx).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(donutCss).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("exist in every theme, light and dark", () => {
    // Five themes; each needs all eight or it silently inherits Daylight's.
    const blocks = tokens.split(/^:root/m).filter((block) => block.includes("--hr-series-1:"));
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      for (let slot = 1; slot <= 8; slot += 1) {
        expect(block, `a theme is missing --hr-series-${slot}`).toMatch(
          new RegExp(`--hr-series-${slot}:`),
        );
      }
    }
  });

  /**
   * Eight is the whole validated set. A ninth would be invented rather than
   * chosen, which is why the tail folds instead.
   */
  it("stops at eight", () => {
    expect(tokens).not.toMatch(/--hr-series-9:/);
  });

  it("separates adjacent wedges with the surface, not a border colour", () => {
    const rule = /\.donut__slice\s*\{[^}]*\}/.exec(donutCss)?.[0] ?? "";
    expect(rule).toMatch(/stroke:\s*var\(--hr-card\)/);
  });
});

describe("the movement can be turned off", () => {
  it("checks the setting before animating", () => {
    expect(donutTsx).toMatch(/prefers-reduced-motion: reduce/);
    expect(donutTsx).toMatch(/if \(prefersReducedMotion\(\)\)/);
  });

  it("turns the css transitions off too", () => {
    expect(donutCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/,
    );
  });

  it("cancels its frame when it goes away", () => {
    // A loop left running after unmount sets state on a dead component and
    // keeps the phone's compositor awake for nothing.
    expect(donutTsx).toMatch(/cancelAnimationFrame\(frame\)/);
  });
});

describe("drilling in", () => {
  it("opens a folded wedge instead of selecting it", () => {
    expect(donutTsx).toMatch(/slice\.members\.length > 0/);
    expect(donutTsx).toMatch(/onDrill\(slice\.id\)/);
  });

  it("offers a way back out", () => {
    expect(donutTsx).toMatch(/onDrill\(null\)/);
    expect(donutTsx).toMatch(/Back to all of/);
  });

  /**
   * While a fold is open the list shows what is inside it, so it goes on
   * being the legend for the ring actually drawn.
   */
  it("narrows the list to the ring on screen", () => {
    expect(budgetTsx).toMatch(/const listed =/);
    expect(budgetTsx).toMatch(/openIds\.has\(keyOf\(line\)\)/);
  });
});
