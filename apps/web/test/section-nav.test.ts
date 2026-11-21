/**
 * Getting to one of Manage's eleven sections.
 *
 * Asked for from use, 2026-11-20: "scrolling to find the desired section is a
 * little cumbersome." `sectionNav.ts` says why this is a pinned bar of chips
 * rather than real tabs.
 *
 * Two halves. `chooseActive` and `scrollLeftFor` are pure and tested with
 * real numbers, because they are the only arithmetic here. The rest are
 * source checks against the three ways this quietly stops working: a chip
 * pointing at an id no section carries, the bar's height drifting away from
 * the stylesheet that draws it, and a jumped-to heading landing underneath
 * the two pinned things above it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JUMP_BAR_PX, chooseActive, scrollLeftFor } from "../src/lib/sectionNav.js";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const manageTsx = source("src/pages/Manage.tsx");
const manageCss = source("src/pages/Manage.css");
const navTs = source("src/lib/sectionNav.ts");
// The look and the markup are shared with the ledger's bar; only where it
// sticks belongs to Manage. See `JumpBar.tsx`.
const jumpBarTsx = source("src/components/JumpBar.tsx");
const jumpBarCss = source("src/components/JumpBar.css");

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

const ORDER = ["one", "two", "three", "four"];

/* -------------------------------------------------------------------------- */
/* Which chip is lit                                                          */
/* -------------------------------------------------------------------------- */

describe("chooseActive", () => {
  it("lights the only section in the band", () => {
    expect(chooseActive(ORDER, new Set(["three"]), null)).toBe("three");
  });

  /**
   * Two sections straddling the band is the ordinary case at a boundary. The
   * upper one wins, because that is the one being read INTO - the heading
   * below it has only just appeared under the bar.
   */
  it("takes the upper of two in the band, whatever order they arrived in", () => {
    expect(chooseActive(ORDER, new Set(["three", "two"]), null)).toBe("two");
    expect(chooseActive(ORDER, new Set(["two", "three"]), "four")).toBe("two");
  });

  /**
   * The end of the page: the last section is shorter than the band is tall,
   * so nothing is in it. Blanking the bar there would be both wrong and
   * visibly broken, so the last answer stands.
   */
  it("keeps the last answer when the band is empty", () => {
    expect(chooseActive(ORDER, new Set(), "four")).toBe("four");
  });

  /**
   * Archived is the one section that comes and goes. When the last of it is
   * brought back while its chip is lit, the previous answer names a section
   * that is no longer on the page.
   */
  it("falls back to the first section when the last answer has gone", () => {
    expect(chooseActive(ORDER, new Set(), "archived")).toBe("one");
  });

  it("has an answer even with nothing to choose from", () => {
    expect(chooseActive([], new Set(), null)).toBe(null);
    expect(chooseActive([], new Set(), "one")).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Keeping that chip on screen                                                */
/* -------------------------------------------------------------------------- */

describe("scrollLeftFor", () => {
  const view = { scrollLeft: 0, viewWidth: 300 };

  /**
   * The common case writes nothing. That matters: this runs whenever the
   * highlight moves, and a write every time would fight a finger scrolling
   * the strip by hand.
   */
  it("says nothing when the chip is already in view", () => {
    expect(scrollLeftFor({ ...view, chipLeft: 40, chipWidth: 80 })).toBe(null);
  });

  it("brings a chip off the right-hand edge into view, with room to spare", () => {
    // Ends at 420, the view ends at 300, so 132 of scroll puts its right edge
    // 12px inside the edge rather than flush against it.
    expect(scrollLeftFor({ ...view, chipLeft: 340, chipWidth: 80 })).toBe(132);
  });

  it("brings a chip off the left-hand edge back, with the same room", () => {
    expect(scrollLeftFor({ scrollLeft: 200, viewWidth: 300, chipLeft: 150, chipWidth: 80 })).toBe(
      138,
    );
  });

  /** The first chip, where the padding would ask for a negative offset. */
  it("never asks to scroll past the start", () => {
    expect(scrollLeftFor({ scrollLeft: 60, viewWidth: 300, chipLeft: 0, chipWidth: 80 })).toBe(0);
  });

  /**
   * A chip wider than the strip cannot be fully in view either way. Showing
   * its start is the useful answer - that is where its label begins.
   */
  it("shows the start of a chip too wide to fit", () => {
    expect(scrollLeftFor({ scrollLeft: 0, viewWidth: 100, chipLeft: 40, chipWidth: 200 })).toBe(28);
  });
});

/* -------------------------------------------------------------------------- */
/* The bar, and the page it is pinned to                                      */
/* -------------------------------------------------------------------------- */

describe("the bar", () => {
  it("is pinned under the header's measured height", () => {
    const jump = rule(manageCss, ".manage__jump");
    expect(jump).toContain("position: sticky");
    expect(jump).toContain("top: var(--hr-header-h)");
  });

  it("sits over the cards and under the app header", () => {
    const barZ = Number(/z-index:\s*(\d+)/.exec(rule(manageCss, ".manage__jump"))?.[1]);
    const headerZ = Number(
      /z-index:\s*(\d+)/.exec(rule(source("src/components/Shell.css"), ".shell-header"))?.[1],
    );
    expect(barZ).toBeLessThan(headerZ);
  });

  /**
   * The constant and the stylesheet are the same number reached two ways: the
   * observer needs it in JavaScript and cannot read CSS, and the scroll
   * offset needs it in CSS. 44px of chip, 4px of padding above and below, and
   * the hairline underneath.
   */
  it("is as tall as the stylesheet draws it", () => {
    expect(rule(jumpBarCss, ".jump-bar__chip")).toContain("min-height: var(--hr-touch-min)");
    expect(rule(jumpBarCss, ".jump-bar__list")).toContain("padding: var(--hr-space-1)");
    expect(rule(jumpBarCss, ".jump-bar")).toContain("border-bottom: 1px solid");

    const tokens = source("src/styles/tokens.css");
    const px = (name: string): number =>
      Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens)?.[1]);

    expect(px("--hr-touch-min") + 2 * px("--hr-space-1") + 1).toBe(JUMP_BAR_PX);
    expect(tokens).toContain(`--hr-jump-h: ${String(JUMP_BAR_PX)}px`);
  });

  /** 44px chips, like every other control on a phone. */
  it("has targets a thumb can hit", () => {
    expect(rule(jumpBarCss, ".jump-bar__chip")).toContain("min-height: var(--hr-touch-min)");
  });

  /**
   * Without this a jumped-to heading arrives behind the header and the bar,
   * which are both drawn over the top of the page - so the one section you
   * asked for would be the one you could not see.
   */
  it("leaves room for itself where a chip lands", () => {
    expect(manageCss).toContain(
      "scroll-margin-top: calc(var(--hr-header-h) + var(--hr-jump-h) + var(--hr-space-3))",
    );
  });

  /** Not colour alone, and not a tablist, because nothing here is hidden. */
  it("marks where you are in words as well as in fill", () => {
    expect(jumpBarTsx).toContain(
      'aria-current={target.id === activeId ? "location" : undefined}',
    );
    expect(jumpBarTsx).not.toContain('role="tablist"');
    // The label is the page's, because the two bars navigate different things.
    expect(manageTsx).toContain('label="Jump to a section"');
    expect(rule(jumpBarCss, ".jump-bar__chip--here")).toContain("background: var(--hr-primary)");
  });
});

describe("the chips and the sections", () => {
  /** Every id a chip names has a section carrying it, and the other way. */
  it("agree about every section on the page", () => {
    const list = manageTsx.slice(
      manageTsx.indexOf("function jumpTargets("),
      manageTsx.indexOf("function JumpBar("),
    );
    const chips = [...list.matchAll(/id: "([a-z-]+)"/g)].map((match) => match[1]);
    const sections = [...manageTsx.matchAll(/\bid="(manage-[a-z-]+)"/g)].map((match) => match[1]);

    expect(chips.length).toBe(11);
    expect([...chips].sort()).toEqual([...sections].sort());
  });

  /**
   * The shared `Section` takes its id as a prop, so a new section added
   * without one would not compile - which is the point of it being required.
   */
  it("make the shared section ask for one", () => {
    expect(manageTsx).toContain('<section className="hr-card manage__section" id={id}>');
    expect(manageTsx).toMatch(/\/\*\* What the jump bar's chip scrolls to[^*]*\*\/\s*\n\s*id: string;/);
  });

  /** The one section that comes and goes. */
  it("only offer Archived when there is something in it", () => {
    expect(manageTsx).toContain('...(hasArchived ? [{ id: "manage-archived", label: "Archived" }] : [])');
  });
});

describe("the observer", () => {
  /**
   * The same argument as `pinnedHeader.ts`: a scroll handler runs on every
   * frame of every flick, on the main thread.
   */
  it("watches rather than listening to scroll", () => {
    expect(navTs).toContain("new IntersectionObserver");
    expect(navTs).not.toContain('addEventListener("scroll"');
  });

  /** A fractional `rootMargin` is the one length that throws rather than being ignored. */
  it("gives it a whole number of pixels", () => {
    expect(navTs).toContain("Math.trunc(headerPx + offsetPx)");
  });

  /** Anyone who asked for less motion gets a jump, not a glide. */
  it("respects a reduced-motion setting", () => {
    expect(navTs).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
  });
});
