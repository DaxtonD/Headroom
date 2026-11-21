/**
 * The budget ring stays on screen while its list is being used.
 *
 * Reported from use, 2026-11-20: "the pie chart scrolls out of view when
 * making selections." The ring and the list below it are one control - tapping
 * a line puts that line's real figures in the middle of the ring - so a list
 * longer than about five lines meant the answer had already scrolled away by
 * the time you asked the question.
 *
 * Source checks, because there is no DOM here. What they are for is the three
 * ways this quietly stops working: the offset becoming a number somebody typed
 * instead of the header's measured height, the dock losing the opaque
 * background that rows pass behind, and the plot losing the cap that stops a
 * square chart filling a landscape phone.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const budgetCss = source("src/pages/Budget.css");
const budgetTsx = source("src/pages/Budget.tsx");
const donutCss = source("src/components/BudgetDonut.css");
const globalCss = source("src/styles/global.css");
const tokensCss = source("src/styles/tokens.css");

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

const dock = rule(budgetCss, ".budget__chart-dock");

describe("the dock", () => {
  it("wraps the ring, and only the ring", () => {
    // The opening tag carries a ref as well now - the ring measures the dock
    // to know how much of the screen it is covering when it scrolls a row
    // into view - so this looks for the class rather than the whole tag.
    const at = budgetTsx.indexOf('className="budget__chart-dock"');
    expect(at, "no dock in Budget.tsx").toBeGreaterThan(-1);
    const inner = budgetTsx.slice(at, budgetTsx.indexOf("</div>", at));
    expect(inner).toContain("<BudgetDonut");
    // Not the list as well: the list is the thing that has to scroll.
    expect(inner).not.toContain("budget__lines");
  });

  it("sticks rather than being fixed to the viewport", () => {
    expect(dock).toContain("position: sticky");
    expect(dock).not.toContain("position: fixed");
  });

  /**
   * The header measures itself and publishes `--hr-header-h`; see
   * `pinnedHeader.ts`, which exists because that height is a line of text plus
   * 44px controls plus `env(safe-area-inset-top)` and nobody can write it
   * down. A literal here would be a few pixels out in a browser tab and a
   * whole notch out in the installed app.
   */
  it("hangs off the header's measured height, not a number", () => {
    expect(dock).toContain("top: var(--hr-header-h)");
    expect(tokensCss).toContain("--hr-header-h:");
  });

  /**
   * Three parts of one fact: a row must pass BEHIND the dock. Without the
   * background it passes through it; without the stacking it passes over it;
   * without the bleed it shows down either side of it, because the card's
   * padding is wider than the chart.
   */
  it("is an opaque rectangle the full width of the card", () => {
    expect(dock).toContain("background: var(--hr-card)");
    expect(dock).toMatch(/z-index:\s*2\b/);
    expect(dock).toContain("margin-inline: calc(var(--hr-space-5) * -1)");
    expect(dock).toContain("padding: 0 var(--hr-space-5)");
  });

  /** Under the app header, which is the one thing it must never cover. */
  it("sits below the header in the stack", () => {
    const header = rule(source("src/components/Shell.css"), ".shell-header");
    const headerZ = Number(/z-index:\s*(\d+)/.exec(header)?.[1]);
    const dockZ = Number(/z-index:\s*(\d+)/.exec(dock)?.[1]);
    expect(dockZ).toBeLessThan(headerZ);
  });

  /**
   * Sticky is silently cancelled by an `overflow` other than `visible` on any
   * ancestor - and the dock's ancestor is the card every section is built
   * from. This has no symptom other than the chart simply not sticking.
   */
  it("sits in a card that does not clip it", () => {
    expect(rule(globalCss, ".hr-card")).not.toContain("overflow");
    expect(rule(budgetCss, ".budget__section")).not.toContain("overflow");
  });
});

describe("the plot it holds", () => {
  /**
   * The chart is square, so a width cap is a height cap. Pinned, an
   * uncapped 320px ring leaves a phone in landscape with no list under it -
   * which is the thing the dock was built to keep reachable.
   */
  it("can never be taller than two fifths of the screen", () => {
    const plot = rule(donutCss, ".donut__plot");
    expect(plot).toContain("aspect-ratio: 1");
    expect(plot).toContain("max-width: clamp(220px, 42vh, 320px)");
  });

  /**
   * The floor is load-bearing, not taste. The hole is 50 of a 200-unit box
   * across its radius, so it is half the ring wide, and the figures are drawn
   * inside it at 44% of the plot. Below about 220px "$1,540.00" stops fitting
   * in its own hole and spills over the wedges.
   */
  it("keeps a floor big enough for the figures in the middle", () => {
    expect(rule(donutCss, ".donut__centre")).toContain("width: 44%");
    const floor = /clamp\((\d+)px/.exec(rule(donutCss, ".donut__plot"))?.[1];
    expect(Number(floor)).toBeGreaterThanOrEqual(220);
  });
});
