/**
 * What the screen does once a row has settled.
 *
 * ## The bug this replaces
 *
 * Somebody marked a bill paid. The row stayed, correctly marked. Two minutes
 * later they opened the balance update, typed the figure from the bank and
 * saved - and the bill vanished off the ledger.
 *
 * Nothing was broken. Every paid row arrived PRE-TICKED in the "did any of
 * these come out?" checklist, saving cleared whatever was ticked, and a
 * cleared row left the timeline. Each step did what it was written to do, and
 * together they turned one Save into "delete this", with nothing on screen
 * saying so.
 *
 * Two things had to change and both are checked here. A settled row stays on
 * the ledger and says it is settled. And the checklist no longer ticks
 * anything on the household's behalf - a settled row never reaches it now, so
 * there is nothing to pre-tick and nothing to sweep away.
 *
 * ## Why it is a source check
 *
 * There is no DOM in this suite. The engine and API tests cover the
 * arithmetic - that a settled row counts in nothing, and that the same bill
 * cannot come out twice. What a grep covers perfectly well is the regression
 * that would undo the fix: the display going back to reading `paid`, or the
 * pre-tick coming back.
 *
 * The distinction being protected is that `paid` is the gesture and `settled`
 * is the consequence. A row taken into a typed balance by the checklist is
 * settled without anybody marking it paid, so a display driven off `paid`
 * leaves it looking outstanding with the money already spent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const component = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", "components", `${name}.tsx`), "utf8");

const row = component("OccurrenceRow");
const sheet = component("UpdateBalanceSheet");
const queries = readFileSync(
  resolve(import.meta.dirname, "..", "src", "lib", "queries.ts"),
  "utf8",
);

describe("a settled row on the ledger", () => {
  it("is struck through for being settled, not for being ticked", () => {
    // `row--paid` carries the line-through and the dimming.
    expect(row).toContain("row.settled ? \"row--paid\"");
    expect(row).not.toMatch(/row\.paid \? "row--paid"/);
  });

  it("gets its Paid chip from the same flag", () => {
    expect(row).toContain("{row.settled ? (");
    expect(row).not.toContain("{row.paid ? (\n              <Chip");
  });

  it("still prints a running balance", () => {
    /*
     * An earlier attempt replaced the figure with the words "in your
     * balance", which left a column of rows with no numbers beside them and
     * read as though something had broken. The balance walks past a settled
     * row unchanged; showing that is more honest than hiding it.
     */
    const figures = /<span className="row__figures">[\s\S]*?<\/span>\s*<\/button>/.exec(row)?.[0] ?? "";
    expect(figures, "the figures block should be findable").not.toBe("");
    expect(figures).toContain("row__running--settled");
    expect(figures).toContain("{formatCents(row.runningCents)}");
    // Scoped to this block on purpose: the phrase is a fine label elsewhere
    // on the row, and a bad substitute for the number itself.
    expect(figures).not.toContain("in your balance");
  });

  it("no longer claims that ticking moves nothing", () => {
    // The note said the figures change only when a balance is typed in. That
    // stopped being true the moment the balance started following the tick.
    expect(row).not.toContain("It still counts towards the running balance");
  });
});

describe("the balance checklist", () => {
  it("ticks nothing on the household's behalf", () => {
    // The pre-tick, in one expression. This is the line that made a bill
    // disappear.
    expect(sheet).not.toMatch(/filter\(\s*\(candidate\) => candidate\.paid\s*\)/);
    expect(sheet).not.toContain("is ticked for you");
  });

  it("does not take a `paid` flag off the wire any more", () => {
    // The server stopped sending one: a settled row is not a candidate at
    // all. A type still carrying it would be a sign the pre-tick had crept
    // back in.
    const candidate = /export interface ClearableCandidate \{[^}]*\}/.exec(queries)?.[0] ?? "";
    expect(candidate).not.toContain("paid");
    expect(candidate).toContain("cents");
  });
});
