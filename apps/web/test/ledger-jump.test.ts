/**
 * Chips that jump between pay periods, and where they sit while scrolling.
 *
 * Asked for on 2026-11-20, right after the same control landed on Manage:
 * "let's do the same thing on the ledger to navigate the weeks. When the
 * screen scrolls, the chips can nest under the cross-faded
 * balance/balance/one-off buttons."
 *
 * The nesting is the whole of the interesting part, and it is the part that
 * cannot be eyeballed from the source: the balance line is `position: fixed`
 * and takes up no space in the scroll, so nothing moves the chips out of its
 * way on its own. They have to be told, and told a measured figure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const ledgerTsx = source("src/pages/Ledger.tsx");
const ledgerCss = source("src/pages/Ledger.css");
const manageCss = source("src/pages/Manage.css");
const jumpBarTsx = source("src/components/JumpBar.tsx");
const jumpBarCss = source("src/components/JumpBar.css");
const pinned = source("src/lib/pinnedHeader.ts");

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

/* -------------------------------------------------------------------------- */
/* One control, two screens                                                   */
/* -------------------------------------------------------------------------- */

describe("the bar", () => {
  it("is the same component Manage uses", () => {
    expect(ledgerTsx).toContain("<JumpBar");
    expect(source("src/pages/Manage.tsx")).toContain("<JumpBar");
  });

  /**
   * The look is shared and the position is not, because the two screens pin
   * it to different things. A copy of the chip styles under a second name is
   * how the two would start drifting apart.
   */
  it("keeps its look in one place and its position in two", () => {
    expect(jumpBarCss).toContain(".jump-bar__chip {");
    expect(ledgerCss).not.toContain("jump-bar__chip");
    expect(manageCss).not.toContain("jump-bar__chip");

    expect(rule(ledgerCss, ".ledger__jump")).toContain("position: sticky");
    expect(rule(manageCss, ".manage__jump")).toContain("position: sticky");
    // The shared stylesheet says nothing about where it goes.
    expect(jumpBarCss).not.toContain("position: sticky");
    expect(jumpBarCss).not.toContain("top:");
  });

  /** Each bar says what it navigates; they are not the same thing. */
  it("is labelled for the page it is on", () => {
    expect(ledgerTsx).toContain('label="Jump to a pay period"');
    expect(jumpBarTsx).toContain("aria-label={label}");
  });

  /** One window is not a list, and a bar with one chip navigates nothing. */
  it("is not drawn when there is only one period", () => {
    expect(ledgerTsx).toContain("periods.length > 1 ?");
  });
});

/* -------------------------------------------------------------------------- */
/* Nesting under the balance line                                             */
/* -------------------------------------------------------------------------- */

describe("where it sits", () => {
  it("hangs off the header's measured height to begin with", () => {
    expect(rule(ledgerCss, ".ledger__jump")).toContain("top: var(--hr-header-h)");
  });

  /**
   * The ask, in one declaration. The balance line is fixed and occupies no
   * space, so the gap has to be made deliberately - and from the line's REAL
   * height, which is a figure, two buttons and whichever of the five text
   * sizes is set.
   */
  it("drops below the balance line once that has slid in", () => {
    expect(rule(ledgerCss, ".ledger__jump--under-balance")).toContain(
      "top: calc(var(--hr-header-h) + var(--hr-ledger-pinned-h, 0px))",
    );
    expect(ledgerTsx).toContain('heroGone ? " ledger__jump--under-balance" : ""');
  });

  /**
   * A class rather than always leaving the gap. With the line away, a gap its
   * height would be a strip of content scrolling between the header and the
   * chips, which reads as broken.
   */
  it("closes the gap again when the line goes", () => {
    const base = rule(ledgerCss, ".ledger__jump");
    expect(base).not.toContain("--hr-ledger-pinned-h");
  });

  it("measures that line rather than guessing at it", () => {
    expect(pinned).toContain("export function usePublishedHeight(");
    expect(pinned).toContain("getBoundingClientRect().height");
    expect(ledgerTsx).toContain('usePublishedHeight("--hr-ledger-pinned-h")');
    expect(ledgerTsx).toContain("ref={pinnedRef}");
  });

  /** It must never cover the line above it, nor the header above that. */
  it("sits below both of the things it tucks under", () => {
    const z = (css: string, selector: string): number =>
      Number(/z-index:\s*(\d+)/.exec(rule(css, selector))?.[1]);

    expect(z(ledgerCss, ".ledger__jump")).toBeLessThan(z(ledgerCss, ".ledger__pinned"));
    expect(z(ledgerCss, ".ledger__pinned")).toBeLessThan(
      z(source("src/components/Shell.css"), ".shell-header"),
    );
  });

  /** Moves with the line rather than jumping the moment it starts sliding. */
  it("moves in step with the line, unless motion is turned down", () => {
    expect(rule(ledgerCss, ".ledger__jump")).toContain("transition: top 200ms ease");
    expect(rule(ledgerCss, ".ledger__pinned")).toContain("200ms ease");

    const reduced = ledgerCss.slice(ledgerCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".ledger__jump");
    expect(reduced).toContain("transition: none");
  });
});

/* -------------------------------------------------------------------------- */
/* Where a chip lands you                                                     */
/* -------------------------------------------------------------------------- */

describe("jumping", () => {
  /** Three things are drawn over the page here, not one. */
  it("clears the header, the balance line and the chips themselves", () => {
    expect(rule(ledgerCss, ".ledger__period")).toContain(
      "var(--hr-header-h) + var(--hr-ledger-pinned-h, 0px) + var(--hr-jump-h)",
    );
  });

  it("gives every period the id its chip names", () => {
    expect(ledgerTsx).toContain("id: `ledger-period-${String(index)}`");
    expect(ledgerTsx).toContain("id={`ledger-period-${String(index)}`}");
  });

  /**
   * The chips sit below the hero, so they can only be stuck once it has gone
   * - which is also when the balance line is there. The band the highlight is
   * chosen in has to allow for both, or a chip lights while its period is
   * still hidden behind them.
   */
  it("counts the balance line in the band it picks the lit chip from", () => {
    expect(ledgerTsx).toContain(
      "useSectionSpy(jumpTargets, JUMP_BAR_PX + (heroGone ? pinnedHeight : 0))",
    );
  });

  /** A chip and the heading it scrolls to say the same thing. */
  it("labels a chip with the window's own label", () => {
    const targets = ledgerTsx.slice(
      ledgerTsx.indexOf("const jumpTargets"),
      ledgerTsx.indexOf("const spy ="),
    );
    expect(targets).toContain("label: period.label");
  });
});
