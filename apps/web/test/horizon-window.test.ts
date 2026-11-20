/**
 * A pay period the horizon cut short, on the screen that shows it.
 *
 * Reported 2026-11-19: a window reading 10-23 December with a subscription
 * renewing on the 18th nowhere on it. The windows are whole fortnights and
 * the horizon is a count of paycheques, so with two earners paid on
 * alternating weeks the horizon lands mid-fortnight - and the window claimed
 * thirteen days whose rows were never fetched.
 *
 * The engine now reports that window only as far as the ledger reaches. The
 * screen's job is to say so: a period reading 10-16 where every other one is
 * fourteen days looks like missing data unless it explains itself.
 *
 * The arithmetic is tested in the engine with values, and the invariant - no
 * window ends after the horizon - is tested against real Postgres. What a
 * grep covers is the note ceasing to render, or the clip being re-derived in
 * the component.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const ledger = source("src/pages/Ledger.tsx");
const queries = source("src/lib/queries.ts");

describe("the flag reaches the screen", () => {
  it("is on the wire shape and the mapping, not invented locally", () => {
    // Both the wire shape it arrives in and the type the screen reads.
    expect(queries).toMatch(/readonly endsAtHorizon: boolean;/);
    expect(queries).toMatch(/endsAtHorizon: period\.endsAtHorizon,/);
  });
});

describe("the ledger explains a short period", () => {
  it("renders a note when the horizon cut the window", () => {
    expect(ledger).toMatch(/period\.endsAtHorizon \?/);
  });

  /**
   * The note has to name the lever, or it is just an apology. The horizon is
   * an editable household setting, and raising it is the whole remedy - with
   * alternating paydays an odd count even lands on a fortnight boundary, so
   * nothing is cut short at all.
   */
  it("says what to do about it", () => {
    const note = /period\.endsAtHorizon \?[\s\S]{0,400}?\) : null\}/.exec(ledger)?.[0] ?? "";
    expect(note).not.toBe("");
    expect(note).toMatch(/Manage/);
    expect(note).toMatch(/paycheques ahead/);
  });

  it("keeps the note separate from the one about the opening period", () => {
    // Two different facts: one window starts today, another stops at the
    // horizon. A single note covering both would be wrong on one of them.
    expect(ledger).toMatch(/period\.isCurrentPartial \?/);
    expect(ledger).toMatch(/opens with what is already in chequing/);
  });
});

describe("the screen does not decide where the horizon falls", () => {
  /**
   * The mirror of every other rule here living in one place. Comparing a
   * period's end against the horizon in the component would be the engine's
   * decision made a second time, and the two would agree right up until the
   * day they did not.
   */
  it("compares nothing against the horizon itself", () => {
    expect(ledger).not.toMatch(/period\.end\s*[<>]=?\s*\w*horizon/i);
    expect(ledger).not.toMatch(/horizonEnd\s*[<>]=?/);
  });
});
