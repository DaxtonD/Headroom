/**
 * Taking a row off the ledger when nothing will put it back.
 *
 * Reported from use on 2026-11-21: "I think I accidentally duplicated
 * payments to savings. I now have a ledger item for the payment but I have
 * no way to remove it. I removed the expense and it still shows on the
 * ledger."
 *
 * The row survived archiving its bill because it had been confirmed, and it
 * offered no remove because the button was drawn only for a one-off. Both
 * halves are fixed where they belong - reconciliation and the delete route,
 * both covered against real Postgres in `apps/api/test/archivedBillRows.test.ts`.
 *
 * What is left to check here is the wiring, and it is worth checking because
 * of how it fails: the screen deciding for itself which rows are removable
 * is how you get a button that the API refuses on every press. There is no
 * DOM in this suite, so these are source checks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

function apiSource(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "../../api", path), "utf8");
}

const rowTsx = source("src/components/OccurrenceRow.tsx");
const queries = source("src/lib/queries.ts");
const views = apiSource("src/routes/views.ts");
const occurrences = apiSource("src/routes/occurrences.ts");

describe("the remove button on a row", () => {
  /**
   * One fact, decided once, on the server. `isOneOff` is no longer the
   * question: a row from an archived bill is not a one-off and is removable,
   * and a row from a live bill is neither.
   */
  it("is drawn from the server's answer, not from the row's shape", () => {
    expect(rowTsx).toContain("{row.canRemove && onRemove ? (");
    expect(rowTsx).not.toContain("{row.isOneOff && onRemove");
    expect(views).toContain(
      "canRemove: row.event.isOneOff === true || decoration?.orphaned === true,",
    );
  });

  /** The same fact the DELETE route tests, so the button cannot offer what the route refuses. */
  it("matches what the delete route allows", () => {
    expect(occurrences).toContain("const comesFromALiveBill =");
    expect(occurrences).toContain("if (!existing.isOneOff && comesFromALiveBill) {");
  });

  /**
   * An installed app can be reading a response cached by an older build,
   * which has no `canRemove` on it at all. Falling back to `isOneOff` is
   * what that build would have shown, rather than a column of rows that
   * suddenly cannot be removed.
   */
  it("falls back to the old rule for a response cached by an older build", () => {
    expect(queries).toContain("canRemove: row.canRemove ?? row.isOneOff,");
    expect(queries).toContain("readonly canRemove?: boolean;");
  });

  /** Removing says "this was never going to happen", which a tick does not. */
  it("still explains that the record is kept", () => {
    expect(rowTsx).toContain("It stops counting. The record of it stays in the history.");
  });
});
