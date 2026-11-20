/**
 * A payday carries a badge, and it can be seen.
 *
 * Reported from use, 2026-11-20: "Pay days on the ledger do not show a badge.
 * They just show a +." The screenshot showed a bill above it wearing a filled
 * green circle with the initial of whoever paid it, and the paycheque under it
 * wearing a plus sign floating on the row.
 *
 * The badge was there the whole time. It was a 32px circle filled with
 * `--hr-green-tint`, sitting on `--hr-payday-row` - a few percent apart in
 * every light theme, and on an expanded payday row the *same token*. So it had
 * no edge anyone could see, and nothing could be read off it: not whether the
 * money had landed, not who had said so.
 *
 * It is a `.badge` now like every other row's, with a "+" so money in still
 * reads as money in. These are source checks, because there is no DOM here;
 * what they are for is the next person who makes this badge a tint again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const badgesTsx = source("src/components/Badges.tsx");
const badgesCss = source("src/components/Badges.css");
const rowTsx = source("src/components/OccurrenceRow.tsx");
const rowCss = source("src/components/OccurrenceRow.css");
const contrastTest = source("test/theme-contrast.test.ts");

/** The body of one CSS rule, by selector. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

describe("the row", () => {
  it("gives a paycheque the badge, not a bare mark", () => {
    expect(rowTsx).toContain("<PaydayBadge received={row.settled} paidBy={row.paidBy} />");
    expect(rowTsx).toContain("PaydayBadge");
  });

  /**
   * Both halves: the element and the rule that styled it. A dead rule left
   * behind is how the next person concludes the old mark is still in use.
   */
  it("has no trace of the mark that could not be seen", () => {
    expect(rowTsx).not.toContain("row__payday-mark");
    expect(rowCss).not.toContain("row__payday-mark");
  });

  /** One badge in the gutter, whatever the row is. */
  it("still shows paid and verified badges on everything else", () => {
    expect(rowTsx).toContain("<PaidBadge paidBy={row.paidBy} />");
    expect(rowTsx).toContain("<VerificationBadge");
  });
});

describe("the badge itself", () => {
  it("is built on the same 32px circle as the others", () => {
    expect(badgesTsx).toMatch(/className=\{`badge \$\{received \? "badge--received" : "badge--incoming"\}`\}/);
    expect(rule(badgesCss, ".badge")).toContain("width: 32px");
  });

  it("carries a plus, so money in reads as money in", () => {
    const fn = badgesTsx.slice(badgesTsx.indexOf("export function PaydayBadge"));
    expect(fn.slice(0, fn.indexOf("export type"))).toContain("+");
  });

  /**
   * The regression this file exists for. A fill is what made the old mark
   * invisible, and the surface it sits on is a tint - so the thing that
   * separates this badge from the row has to be a border drawn in a colour
   * that is checked against that surface.
   */
  it("is drawn with a border and not a tint while the money is still coming", () => {
    const incoming = rule(badgesCss, ".badge--incoming");
    expect(incoming).toMatch(/border:\s*2px solid var\(--hr-positive\)/);
    expect(incoming).not.toMatch(/\bbackground:/);
  });

  it("fills the same way as paid once the money is in", () => {
    const received = rule(badgesCss, ".badge--received");
    const paid = rule(badgesCss, ".badge--paid");
    expect(received).toContain("background: var(--hr-primary)");
    expect(received).toContain("color: var(--hr-on-primary)");
    // The same two declarations, so the ledger never grows two different
    // looking kinds of "the money has moved".
    expect(received.replace(".badge--received", "")).toBe(paid.replace(".badge--paid", ""));
  });

  /**
   * `paidBy` and nothing else, exactly as `PaidBadge` does it: a paycheque
   * settled by the balance checklist has nobody attached, and an initial
   * invented for it would be a worse answer than none.
   */
  it("names whoever marked it, when there is one", () => {
    const fn = badgesTsx.slice(badgesTsx.indexOf("export function PaydayBadge"));
    expect(fn).toContain("received && paidBy ?");
    expect(fn).toContain("initialOf(paidBy)");
    expect(fn).toContain("`Received, marked by ${paidBy.name}`");
  });

  /** Never colour alone: the shape and the accessible name both say it. */
  it("says in words which state it is in", () => {
    const fn = badgesTsx.slice(badgesTsx.indexOf("export function PaydayBadge"));
    expect(fn).toContain('role="img"');
    expect(fn).toContain("aria-label={label}");
    expect(fn).toContain('"Payday"');
  });
});

describe("the colour it is drawn in", () => {
  /**
   * The border is `--hr-positive` and it sits on `--hr-payday-row`. That pair
   * is already in the contrast table at the text minimum, which is stricter
   * than the 3:1 a border needs - so there is nothing new to check here, only
   * something to keep. If this pairing ever leaves that table, this badge goes
   * back to being invisible in whatever theme stops being checked.
   */
  it("is a pair the contrast test already walks", () => {
    const positive = contrastTest.slice(
      contrastTest.indexOf('text: "--hr-positive"'),
      contrastTest.indexOf('text: "--hr-negative"'),
    );
    expect(positive).toContain("--hr-payday-row");
    expect(positive).toContain("--hr-green-tint");
  });
});
