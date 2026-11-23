/**
 * "Move Hydro to Dec 9 and it clears", on screen.
 *
 * Asked for on 2026-11-22, from what the household already does by hand:
 * pushing a variable bill into a later pay period when chequing is low, and
 * mentioning it the next morning.
 *
 * ## The line this file is really protecting
 *
 * **The app offers, it does not act.** A flexible item has no real due date in
 * this model - its date is "the day you plan to pay it", not a day anybody is
 * owed - so nothing in the app knows whether a bill can actually wait. The
 * household does. So every suggestion is a statement of what *would* happen,
 * and the last step is always a person's tap on the row.
 *
 * A build that made the move directly would be one line shorter and would be
 * making a payment decision on the household's behalf. That is the regression
 * this file exists to catch.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite. Whether a suggestion is *correct* is tested
 * as behaviour in `packages/core/test/suggestMoves.test.ts`, which applies
 * each one and re-runs the whole timeline. What a grep covers well is the
 * wiring and the wording going quietly wrong.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

const ledger = read("pages", "Ledger.tsx");
const ledgerCss = read("pages", "Ledger.css");
const row = read("components", "OccurrenceRow.tsx");
const queries = read("lib", "queries.ts");

describe("where the suggestions appear", () => {
  it("is inside the shortfall warning, because it answers it", () => {
    // The warning says how much is missing; these say what would fix it. Two
    // separate blocks would be two places to look for one piece of news.
    const warning = ledger.slice(ledger.indexOf('className="ledger__warning"'));
    const fixes = warning.indexOf("ledger__fixes");
    const closes = warning.indexOf("</section>");

    expect(fixes).toBeGreaterThan(-1);
    expect(fixes).toBeLessThan(closes);
  });

  it("shows nothing when there is nothing to suggest", () => {
    // Which is almost always: the engine returns an empty list unless
    // something is actually short.
    expect(ledger).toContain("data.suggestedMoves.length > 0");
  });
});

describe("what each one says", () => {
  it("names the bill and the day it would move to", () => {
    expect(ledger).toContain("move.name");
    expect(ledger).toContain("formatDateShort(move.toDate)");
  });

  it("shows the effect, so the offer can be judged rather than trusted", () => {
    // The amount being moved and where the low point lands afterwards. Both
    // come from the engine's own re-run, not from arithmetic done here.
    expect(ledger).toContain("formatCents(move.cents)");
    expect(ledger).toContain("formatCents(move.lowestAfterCents)");
  });

  it("is worded as what would happen, not as an instruction", () => {
    /*
     * The app cannot know whether a bill can wait, so it must not tell
     * anybody to move one. "This would clear it" is a fact about the
     * arithmetic; "move this" would be a payment decision.
     */
    expect(ledger).toContain("would clear it");
    expect(ledger).not.toMatch(/You should move/u);
  });

  it("says so differently when there is more than one", () => {
    // "Any one of these would clear it" - they are alternatives, and reading
    // them as a list of steps would be the wrong action entirely.
    expect(ledger).toContain("Any one of these would clear it");
  });
});

describe("what tapping one does", () => {
  it("opens the row and brings it into view", () => {
    expect(ledger).toContain("setExpandedId(move.eventId)");
    expect(ledger).toContain("scrollIntoView");
  });

  it("can find the row it names", () => {
    // The suggestion is useless if tapping it leaves you to go looking, so
    // the row carries an id for exactly this.
    expect(ledger).toContain("`row-${move.eventId}`");
    expect(row).toContain("id={`row-${row.id}`}");
  });

  it("does not make the move itself", () => {
    /*
     * The whole point. The handler expands a row; it does not patch an
     * occurrence. A build where this called a mutation would have taken a
     * payment decision away from the household.
     */
    const handler = ledger.slice(ledger.indexOf('className="ledger__fix"'));
    const end = handler.indexOf("</button>");

    expect(handler.slice(0, end)).not.toMatch(/mutate|save\(|anchorOccurrenceId/u);
  });

  it("is a real button, at a real touch size", () => {
    expect(ledger).toContain('<button\n                      className="ledger__fix"');
    const rule = ledgerCss.slice(ledgerCss.indexOf(".ledger__fix {"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("--hr-touch-min");
  });
});

describe("what the screen is told", () => {
  it("takes the suggestions from the engine, already verified", () => {
    /*
     * Each one has been applied to the events and the whole timeline run
     * again. Nothing here re-derives whether a move would work - that would
     * be the rule written twice, and the copy on the phone would be the one
     * that was wrong.
     */
    expect(queries).toContain("readonly suggestedMoves: readonly SuggestedMove[];");
    expect(ledger).not.toContain("suggestMoves(");
  });

  it("survives a server too old to send them", () => {
    // An installed app can outrun its server, and a shortfall warning with no
    // suggestions is the old behaviour rather than a broken screen.
    expect(queries).toMatch(/readonly suggestedMoves\?:/u);
    expect(queries).toContain("wire.suggestedMoves ?? []");
  });
});
