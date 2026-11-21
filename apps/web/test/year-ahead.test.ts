/**
 * The four things added to the Year screen on 2026-11-20.
 *
 * The arithmetic lives in `packages/core/src/yearAhead.ts` and is tested
 * there against values. What is checked here is the half that is only ever
 * wrong on a screen: that a bigint arrives as a bigint rather than a Number,
 * that nothing on the page is carried by colour alone, and - the one with
 * real teeth - that the projection says in words how much of itself to
 * believe.
 *
 * Source checks, because there is no DOM in this suite.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const yearTsx = source("src/pages/Year.tsx");
const yearCss = source("src/pages/Year.css");
const queries = source("src/lib/plannerQueries.ts");

/**
 * The body of the year query's own function.
 *
 * `yearOptions`, not `useYear`: the read was split into options and a hook so
 * the tabs can be prefetched (`warmTabs.ts`), and the parsing - which is what
 * these checks are about - went with the options.
 */
const useYear = queries.slice(
  queries.indexOf("export function yearOptions("),
  queries.indexOf("export function yearOptions(") + 4000,
);

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

/* -------------------------------------------------------------------------- */
/* Money off the wire                                                         */
/* -------------------------------------------------------------------------- */

describe("the amounts coming back", () => {
  /**
   * Every one of these is money. A `Number` anywhere on this path is a silent
   * rounding of somebody's balance, which is the single rule this codebase
   * will not bend, so each new field is named here rather than trusted to a
   * spread.
   */
  it("turns every new field into cents, not a number", () => {
    for (const field of [
      "startBalanceCents",
      "uncoveredCents",
      "spareCents",
      "lumpTotalCents",
    ]) {
      expect(useYear, field).toContain(`toCents(`);
      expect(useYear, field).toContain(field);
    }

    expect(useYear).toContain("toCents(wire.setAside.totalCents)");
    expect(useYear).toContain("toCents(wire.setAside.evenCents)");
    expect(useYear).toContain("toCents(wire.setAside.levelCents)");
    expect(useYear).toContain("toCents(pair.coveredCents)");
    expect(useYear).toContain("lumps: month.lumps.map((lump) => ({ ...lump, cents: toCents(lump.cents) }))");
  });

  /**
   * A month the projection did not reach sends null, and null is not zero. A
   * zero would be drawn as "nothing happens in this month", which is a
   * confident wrong answer where there should be none at all.
   */
  it("keeps a month with no projection as null rather than zero", () => {
    expect(useYear).toContain("month.inCents === null ? null : toCents(month.inCents)");
    expect(useYear).toContain("month.outCents === null ? null : toCents(month.outCents)");
    expect(yearTsx).toContain("month.endBalanceCents !== null");
  });

  it("never parses an amount as a float", () => {
    expect(yearTsx).not.toContain("parseFloat");
    expect(yearTsx).not.toContain("Number(");
  });
});

/* -------------------------------------------------------------------------- */
/* What pays for what                                                         */
/* -------------------------------------------------------------------------- */

describe("what pays for what", () => {
  it("names both months in every pairing", () => {
    expect(yearTsx).toContain("pair.windfallLabel");
    expect(yearTsx).toContain("pair.squeezeLabel");
    expect(yearTsx).toContain("formatCents(pair.coveredCents)");
  });

  /**
   * The one the section is worth building for. A warning tint on its own
   * would make this a colour anybody could miss; the sentence under it says
   * which month and why, so the tint is reinforcement rather than the
   * message.
   */
  it("spells out a payment that lands before the cheque for it", () => {
    expect(yearTsx).toContain("pair.squeezeFirst");
    expect(yearTsx).toContain("comes first, so this has to be found before the cheque");
    expect(rule(yearCss, ".year__pair--early")).toContain("var(--hr-warning-bg)");
  });

  it("says what is left over and what is not covered at all", () => {
    expect(yearTsx).toContain("data.spareCents > 0n");
    expect(yearTsx).toContain("data.uncoveredCents > 0n");
    expect(yearTsx).toContain("that can go to savings");
  });

  /** Nothing unusual in the window means nothing to say, not an empty card. */
  it("is not rendered at all when there is nothing to pair", () => {
    expect(yearTsx).toContain("if (data.pairs.length === 0 && data.uncoveredCents === 0n) return null;");
  });
});

/* -------------------------------------------------------------------------- */
/* What to put aside                                                          */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The sentence is a sentence                                                 */
/* -------------------------------------------------------------------------- */

describe("a pairing's line", () => {
  /**
   * Reported from use on 2026-11-20 as text that looked clipped. Nothing was
   * missing: `.year__pair-line` is a flex container, so every `strong` and
   * every run of text between them had become its own flex item, and
   * `space-between` spread the sentence into columns -
   * "Dec 2026" | "'s extra cheque covers" | "Oct 2027" - each wrapping
   * separately.
   *
   * The fix is one wrapper, so the row has exactly two items: the sentence,
   * and its amount.
   */
  it("is one flex item, not one per word", () => {
    const at = yearTsx.indexOf('<p className="year__pair-line">');
    expect(at).toBeGreaterThan(-1);
    const line = yearTsx.slice(at, yearTsx.indexOf("</p>", at));

    // The whole sentence lives inside the wrapper...
    const text = line.slice(
      line.indexOf('<span className="year__pair-text">'),
      line.indexOf("</span>", line.indexOf('<span className="year__pair-text">')),
    );
    expect(text).toContain("pair.windfallLabel");
    expect(text).toContain("extra cheque covers");
    expect(text).toContain("pair.squeezeLabel");

    // ...and the amount is the only other thing in the row.
    expect(line).toContain('<span className="year__pair-amount hr-amount">');
  });

  /**
   * A flex item's floor is its min-content width unless it is told otherwise,
   * which is the trap `Shell.css` describes for the whole page. Without this
   * the sentence would push the amount off the edge of the card rather than
   * wrapping.
   */
  it("lets the sentence wrap instead of shoving the amount off the card", () => {
    expect(rule(yearCss, ".year__pair-text")).toContain("min-width: 0");
    expect(rule(yearCss, ".year__pair-amount")).toContain("flex: 0 0 auto");
    expect(rule(yearCss, ".year__pair-amount")).toContain("white-space: nowrap");
  });
});

describe("what to put aside", () => {
  /**
   * The level figure is the headline and the even share is the explanation.
   * The other way round would be the mistake this whole computation exists to
   * avoid: an even share is the number anybody would reach for, and it is the
   * one that leaves the household short when a policy renews in March.
   */
  it("leads with the figure that is never short", () => {
    const aside = yearTsx.slice(yearTsx.indexOf("function PutAside("));
    expect(aside).toContain('className="year__aside-figure hr-amount">{formatCents(setAside.levelCents)}');
    // The even share appears only in the explanation underneath.
    expect(aside.indexOf("setAside.levelCents")).toBeLessThan(aside.indexOf("setAside.evenCents"));
  });

  it("blames the month that forces the figure up", () => {
    expect(yearTsx).toContain("setAside.bindingLabel !== null");
    expect(yearTsx).toContain("needs its money");
  });

  /** When the two agree there is no month to blame, and it says so instead. */
  it("says why when the two figures are the same", () => {
    expect(yearTsx).toContain("Which is also the even share");
  });

  it("lists the bills themselves, with their dates and their cadence", () => {
    expect(yearTsx).toContain("formatDayMonthAndYear(lump.date)");
    expect(yearTsx).toContain('lump.cadence === "yearly" ? "once a year" : "every three months"');
  });

  it("shows a bill as money going out", () => {
    // Negated at the edge, because the engine carries a lump as a positive
    // magnitude and the screen has to show a minus.
    expect(yearTsx).toContain("formatCents(-lump.cents)");
  });

  it("is not rendered when nothing skips a month", () => {
    expect(yearTsx).toContain("if (setAside.billCount === 0) return null;");
  });
});

/* -------------------------------------------------------------------------- */
/* Where the balance ends up                                                  */
/* -------------------------------------------------------------------------- */

describe("the projected balance", () => {
  /**
   * The only thing on this screen that is a guess. Everything else is read
   * off the schedules and is as true in fourteen months as tomorrow; this
   * assumes every bill costs what it costs today and that nothing is bought
   * in between. Saying so is not a disclaimer to be tidied away - without it
   * the figure cannot be acted on at all.
   */
  it("says where the ledger stops and the guessing starts", () => {
    expect(yearTsx).toContain("formatDayMonthAndYear(data.ledgerThrough)");
    expect(yearTsx).toContain("the ledger&rsquo;s own rows");
    expect(yearTsx).toContain("assume every bill costs what it");
    expect(yearTsx).toContain("read the shape rather than the figure");
  });

  it("names the month that ends lowest, in words and on the row", () => {
    expect(yearTsx).toContain("data.lowestStart");
    expect(yearTsx).toContain("the lowest any month");
    expect(yearTsx).toContain("the lowest of the year");
  });

  /** An account going under is said, not just coloured. */
  it("marks a month that ends below zero without relying on the colour", () => {
    expect(yearTsx).toContain("month.endBalanceCents < 0n");
    expect(rule(yearCss, ".year__month-balance--under")).toContain("font-weight: 600");
    expect(rule(yearCss, ".year__lowest--under")).toContain("font-weight: 600");
  });

  /** No chequing account means no balance to project, and no empty figures. */
  it("is left out when there is no account to project", () => {
    expect(yearTsx).toContain("if (!data.hasBalance) return null;");
    expect(yearTsx).toContain("data.hasBalance && month.endBalanceCents !== null");
  });
});

/* -------------------------------------------------------------------------- */
/* The screen as a whole                                                      */
/* -------------------------------------------------------------------------- */

describe("the page", () => {
  it("still leads with the months worth planning for", () => {
    /*
     * The order the sections are RENDERED in, which is the order they appear
     * inside `Year` - not the order of the strings in the file, since each of
     * the new sections is a component defined below it. Searching the whole
     * file matches this module's own opening comment first.
     */
    const body = yearTsx.slice(
      yearTsx.indexOf("export function Year("),
      yearTsx.indexOf("function WhatPaysForWhat("),
    );

    const order = ["Worth planning for", "<WhatPaysForWhat", "<PutAside", "Month by month"].map(
      (needle) => body.indexOf(needle),
    );

    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  /** The two sections that can be empty are components, so they can bail. */
  it("renders the new sections through their own components", () => {
    expect(yearTsx).toContain("<WhatPaysForWhat data={data} />");
    expect(yearTsx).toContain("<PutAside data={data} />");
    expect(yearTsx).toContain("<Projection data={data} />");
  });
});
