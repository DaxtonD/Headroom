/**
 * Where today is on the ledger, and what each cheque leaves behind.
 *
 * Both come from the same session on 2026-11-20. The first is a subtraction:
 * a settled row moves nothing, so every one of them printed the same balance
 * as the row above, and a dozen copies of one figure down the top of the
 * screen read as a counter that had stopped - reported by the person who
 * built it, which is about as clear a verdict as a design gets. One line now
 * says it once, where history ends.
 *
 * The second is the number the spreadsheet this app replaces is actually
 * dragged for: select from a paycheque down to the row above the next one,
 * read the sum off the bottom of the screen. The app had never shown it. The
 * engine computes it (`chequeBlocks.ts`); these are the checks that it
 * reaches the screen, lands in the right place, and is not quietly
 * re-derived in the browser on the way.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite. The arithmetic is covered where it lives -
 * `packages/core/test/chequeBlocks.test.ts` proves the blocks sum to the
 * window's own total against every seed on the machine, and the API tests
 * prove the figures survive the wire. What a grep covers well is the wiring
 * that would silently come undone: the line driven off dates instead of the
 * settled flag, the leftover computed client-side, the two halves of a
 * projected cheque's id drifting apart.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const ledgerTsx = source("src/pages/Ledger.tsx");
const ledgerCss = source("src/pages/Ledger.css");
const rowTsx = source("src/components/OccurrenceRow.tsx");
const queries = source("src/lib/queries.ts");
const payPeriods = readFileSync(
  resolve(import.meta.dirname, "../../../packages/core/src/payPeriods.ts"),
  "utf8",
);

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

/* -------------------------------------------------------------------------- */
/* The line between what has happened and what has not                        */
/* -------------------------------------------------------------------------- */

describe("the balance-now line", () => {
  it("is drawn once, under the last row whose money has gone", () => {
    expect(ledgerTsx).toContain('<li className="ledger__now">');
    expect(ledgerTsx).toContain("{id === balanceAfterId ? (");
    // The figure at the top of the page, not a second source for it.
    expect(ledgerTsx).toContain("balanceCents={data.balance.cents}");
    expect(ledgerTsx).toContain("{formatCents(balanceCents)}");
  });

  /**
   * `settled` is the flag the engine itself acted on when it stopped counting
   * those rows, so the line lands exactly where the balance stops being
   * history and starts being a forecast. A date comparison would be a second
   * rule for the same thing, and would disagree the first time a bill went
   * unpaid past its date - which the ledger deliberately keeps showing.
   */
  it("finds that row by the settled flag, not by its date", () => {
    const block = ledgerTsx.slice(
      ledgerTsx.indexOf("const balanceAfterId = useMemo("),
      ledgerTsx.indexOf("const panelId ="),
    );
    expect(block, "balanceAfterId should be findable").not.toBe("");
    expect(block).toContain("if (row.settled) last = row.id;");
    expect(block).not.toContain("today");
    expect(block).not.toContain("row.date");
  });

  /** Nothing ticked means no history to mark the end of. */
  it("is absent when nothing has settled yet", () => {
    const block = ledgerTsx.slice(
      ledgerTsx.indexOf("const balanceAfterId = useMemo("),
      ledgerTsx.indexOf("const panelId ="),
    );
    expect(block).toContain("let last: string | null = null;");
  });

  /**
   * A boundary, not another row. Rules above and below rather than a filled
   * background, or it reads as one more item in the list.
   */
  it("is drawn as a boundary", () => {
    const now = rule(ledgerCss, ".ledger__now");
    expect(now).toContain("border-top");
    expect(now).toContain("border-bottom");
    expect(now).not.toContain("background");
  });

  /**
   * The two halves of one change. Blanking the settled rows without this line
   * is the version that shipped once before and read as broken; the line
   * without the blanking leaves the repeated figures it exists to replace.
   */
  it("is what lets a settled row drop its figure", () => {
    expect(rowTsx).toContain("{row.settled ? null : (");
    expect(rowTsx).toContain("row__running--elsewhere");
    // A charge on a card is not history and keeps its unchanged figure.
    expect(rowTsx).toContain("const movedNothing = row.deltaCents === 0n");
  });
});

/* -------------------------------------------------------------------------- */
/* What one cheque leaves behind                                              */
/* -------------------------------------------------------------------------- */

describe("the per-cheque left-over", () => {
  it("prints the engine's figure rather than adding up the rows again", () => {
    expect(ledgerTsx).toContain('<li className="ledger__block-left">');
    expect(ledgerTsx).toContain("{formatCents(leftOver.leftCents)}");
    // The browser must not sum deltas of its own: the engine already did it,
    // and two implementations of one total is how they start disagreeing.
    const body = ledgerTsx.slice(ledgerTsx.indexOf("const leftOverAfter = useMemo("));
    expect(body.slice(0, body.indexOf("return footers;"))).not.toContain("deltaCents");
  });

  /**
   * The opening stretch - now until the next cheque - leaves behind exactly
   * the running balance already printed beside its last row. A second copy
   * of a number is not an answer, and this screen has just finished removing
   * twelve of them.
   */
  it("is only drawn for a block a cheque opened", () => {
    expect(ledgerTsx).toContain('if (block.kind !== "cheque") continue;');
  });

  /**
   * Position, not contiguity. The engine sorts its entries the same way this
   * screen does, so a block IS a run of adjacent rows - but that rule has
   * been written twice in this codebase before and the copies disagreed the
   * moment one was corrected. Taking the furthest row of a block cannot put
   * the figure inside the next cheque.
   */
  it("lands under the last row the cheque has to cover", () => {
    const block = ledgerTsx.slice(
      ledgerTsx.indexOf("const leftOverAfter = useMemo("),
      ledgerTsx.indexOf("return footers;"),
    );
    expect(block).toContain("if (at !== undefined && at > last) last = at;");
  });

  /**
   * A projected cheque has no row and so no id of its own; the engine names
   * it for the schedule and the day. Two spellings of that, and a block past
   * the horizon would never find its last entry - which fails silently, by
   * printing nothing.
   */
  it("spells a projected cheque's id the way the engine does", () => {
    expect(ledgerTsx).toContain("`${entry.cheque.scheduleId}|${entry.cheque.date}`");
    expect(payPeriods).toContain("`${schedule.id}|${payday}`");
  });

  it("carries the blocks across the wire as the engine grouped them", () => {
    expect(queries).toContain("readonly blocks: readonly ChequeBlock[];");
    expect(queries).toContain("leftCents: toCents(block.leftCents),");
    // Ids included, so the screen groups by the engine's decision rather than
    // working out its own from the dates.
    expect(queries).toContain("entryIds: block.entryIds,");
  });

  /** Quieter than the window's own band, which is still the louder figure. */
  it("is indented and subordinate to the window total", () => {
    const left = rule(ledgerCss, ".ledger__block-left");
    expect(left).toContain("border-left");
    expect(left).toContain("color: var(--hr-text-muted)");
    expect(left).toContain("min-height: var(--hr-touch-min)");
  });
});
