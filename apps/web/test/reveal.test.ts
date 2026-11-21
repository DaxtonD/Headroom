/**
 * Bringing a tapped wedge's row into view.
 *
 * Asked for 2026-11-21: "when a pie is selected, scroll the matching item
 * into view." Tapping a wedge answers in two places - the figures in the
 * middle of the ring, and the row in the list with the name, the amount and
 * the share - and on a section with a dozen lines the second place was
 * usually off the bottom of the screen.
 *
 * The arithmetic is where this goes wrong, so the arithmetic is what is
 * checked here. Two failures in particular:
 *
 *  - scrolling an element to the top of the VIEWPORT parks it behind the app
 *    header and the pinned chart, which is a scroll that makes things worse;
 *  - scrolling when the row is already on screen moves it out from under the
 *    finger that is using it.
 *
 * Numbers are pixels of a phone: a 740px viewport with 70px of header and a
 * 260px chart docked under it, leaving a band of about 400px.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { revealTopFor } from "../src/lib/reveal.js";

const VIEW = 740;
const HEADER = 70;
const DOCK = 260;
const OBSCURED = HEADER + DOCK;
/** One row of the budget list: a name, an amount and a share bar. */
const ROW = 62;

function reveal(options: {
  scrollY?: number;
  elementTop: number;
  elementHeight?: number;
  obscuredTop?: number;
}): number | null {
  return revealTopFor({
    scrollY: options.scrollY ?? 1000,
    elementTop: options.elementTop,
    elementHeight: options.elementHeight ?? ROW,
    viewHeight: VIEW,
    obscuredTop: options.obscuredTop ?? OBSCURED,
  });
}

describe("a row that is already in view", () => {
  it("is left exactly where it is", () => {
    expect(reveal({ elementTop: 400 })).toBeNull();
    expect(reveal({ elementTop: OBSCURED + 8 })).toBeNull();
    expect(reveal({ elementTop: VIEW - ROW - 8 })).toBeNull();
  });

  /**
   * The common case, and the one that has to cost nothing: most of a short
   * list is on screen already, and a chart that re-scrolled the page on every
   * tap would be worse than one that never did.
   */
  it("is the answer for every row of a list that fits", () => {
    for (let top = OBSCURED + 8; top + ROW + 8 <= VIEW; top += 10) {
      expect(reveal({ elementTop: top }), `a row at ${String(top)}`).toBeNull();
    }
  });
});

describe("a row behind the pinned chart", () => {
  /**
   * Not the top of the screen: the top of the screen is the app header, and
   * under that is the chart that was just tapped. Both have to be cleared or
   * the row is scrolled somewhere nobody can see it.
   */
  it("comes out below the header and the dock, not to the top of the page", () => {
    // 100px from the top of the viewport, which is inside the docked chart.
    const top = reveal({ scrollY: 1000, elementTop: 100 });
    expect(top).toBe(1000 + 100 - OBSCURED - 8);
    // Which is up the page, since the row is above where it can be seen.
    expect(top).toBeLessThan(1000);
  });

  it("clears whatever is pinned, whatever that happens to measure", () => {
    // A taller chart on a bigger phone, or a drilled ring with a Back button
    // under it: the figure is measured at the call site, never written down.
    expect(reveal({ scrollY: 500, elementTop: 100, obscuredTop: 420 })).toBe(500 + 100 - 420 - 8);
  });

  it("never asks for a negative scroll at the top of the page", () => {
    expect(reveal({ scrollY: 10, elementTop: 0 })).toBe(0);
  });
});

describe("a row below the fold", () => {
  /**
   * Scrolled up by just enough. Taking it to the top instead would send the
   * page a long way down the section for a row two lines past the bottom,
   * which reads as having jumped somewhere else entirely.
   */
  it("is brought up by just enough to show it whole", () => {
    const top = reveal({ scrollY: 1000, elementTop: 720 });
    expect(top).toBe(1000 + 720 + ROW + 8 - VIEW);
    // Down the page, and by less than the distance to the top of the band.
    expect(top).toBeGreaterThan(1000);
    expect(top).toBeLessThan(1000 + 720 - OBSCURED - 8);
  });

  it("shows the whole of it, bottom edge included", () => {
    const top = reveal({ scrollY: 1000, elementTop: 700 }) as number;
    const moved = top - 1000;
    // Where the row ends up, and it has to be inside the screen.
    expect(700 - moved + ROW).toBeLessThanOrEqual(VIEW);
    expect(700 - moved).toBeGreaterThan(OBSCURED);
  });
});

describe("something taller than the screen", () => {
  /**
   * A whole section rather than one of its rows, which is what a drill-down
   * reveals. Some of it is always below the fold, so "bring it into view"
   * must not mean "scroll, always" - the start of it being visible is the
   * whole of the answer.
   */
  it("is left alone while its start is visible", () => {
    expect(reveal({ elementTop: 300, elementHeight: 2400, obscuredTop: HEADER })).toBeNull();
  });

  it("is still pulled back when its start has gone off the top", () => {
    expect(reveal({ scrollY: 900, elementTop: -400, elementHeight: 2400, obscuredTop: HEADER })).toBe(
      900 - 400 - HEADER - 8,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The wiring, since there is no DOM in this suite                            */
/* -------------------------------------------------------------------------- */

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const budgetTsx = source("src/pages/Budget.tsx");
const revealTs = source("src/lib/reveal.ts");

describe("the budget page", () => {
  /**
   * From the ring only. The list's own buttons must not scroll: the row is
   * already in front of you, and moving the page then takes it out from
   * under the finger that pressed it.
   */
  it("scrolls on a wedge and not on a row", () => {
    expect(budgetTsx).toContain("onSelect={chooseFromRing}");
    expect(budgetTsx).toContain("onClick={() => setChosenId(chosen ? null : id)}");
    const handler = budgetTsx.slice(
      budgetTsx.indexOf("const chooseFromRing"),
      budgetTsx.indexOf("const openRing"),
    );
    expect(handler).toContain("revealElement(row");
  });

  it("finds the row by the mark it puts on it", () => {
    expect(budgetTsx).toContain("data-line={id}");
    expect(budgetTsx).toContain('`[data-line="${CSS.escape(id)}"]`');
  });

  /**
   * Both measured, neither written down. The header is a line of text plus
   * 44px controls plus the notch; the dock is a chart whose height is a
   * clamp against the viewport, plus a Back button when a fold is open.
   */
  it("measures what is pinned rather than assuming it", () => {
    expect(budgetTsx).toContain("const headerPx = useHeaderHeight();");
    expect(budgetTsx).toContain("headerPx + (dockRef.current?.offsetHeight ?? 0)");
  });

  /** Opening a fold replaces a dozen rows with three; the ring has to stay. */
  it("keeps the section on screen when a fold is opened", () => {
    expect(budgetTsx).toContain("const openRing = (id: string | null): void => {");
    expect(budgetTsx).toContain("revealElement(sectionRef.current, headerPx)");
  });

  it("asks nobody who turned animation off to be scrolled smoothly", () => {
    expect(revealTs).toContain("prefers-reduced-motion: reduce");
    expect(revealTs).toContain("behavior: scrollBehaviour()");
  });
});
