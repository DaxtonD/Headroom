/**
 * Choosing which account money moves between, on the three screens that ask.
 *
 * ## What went wrong, which is why these exist
 *
 * The database, the engine and the API have taken both ends of a move since
 * the day cards arrived: `paidFromAccountId` and `transferToAccountId`, with
 * `accountDelta` in `packages/core` as the single place that decides a sign.
 * The occurrence PATCH route has accepted both all along, and even names this
 * feature in a comment - "moving one month's bill onto a card, or off one, is
 * a decision about that month".
 *
 * No screen offered either one, except the one-off sheet, and only for a card.
 * Two consequences, both reported by the household:
 *
 *  1. **The ledger could not say it.** The water bill is an expense whose
 *     planned account shows in Manage, and opening that row on the ledger gave
 *     no way to say that this month it went on the Visa.
 *
 *  2. **"Into savings" lost money.** The sheet offered the choice, sent
 *     `kind: "transfer"` and sent no destination - so the row was a transfer
 *     with nowhere to go. Chequing fell by the amount and savings never moved.
 *     It read as working because the card flow beside it does work; that one
 *     was built later, with a destination, when there was somewhere to send it.
 *
 * A third followed from reading the code for the first two: nothing on any
 * screen could set a destination on a **scheduled** expense either, so a
 * planned monthly savings payment had the same hole as the one-off.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite, and the figures are covered where they live:
 * `routing.test.ts` runs the rules themselves against values, the engine tests
 * prove one tick moves two balances, and the API tests prove it end to end
 * against real Postgres. What a grep covers well is a picker quietly ceasing
 * to be rendered, a destination going back to being sent for only one kind, or
 * the rules being re-derived inline in a fourth place.
 *
 * That last one is the point of the final block. The bug was not that the
 * logic was wrong; it was that it was written three times and one copy was
 * incomplete.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

const row = read("components", "OccurrenceRow.tsx");
const oneOff = read("components", "OneOffForm.tsx");
const billForm = read("components", "BillForm.tsx");
const ledger = read("pages", "Ledger.tsx");
const routing = read("lib", "routing.ts");
const queries = read("lib", "queries.ts");

/** Prose mentioning an expression must not pass for the expression itself. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

const rowCode = withoutComments(row);
const oneOffCode = withoutComments(oneOff);
const billFormCode = withoutComments(billForm);

describe("the ledger row, which is what was asked for", () => {
  it("asks which account this one came out of", () => {
    expect(row).toMatch(/Which account did it come out of\?/);
    expect(rowCode).toMatch(/paidFromAccountId: accountIdOf\(event\.target\.value\)/);
  });

  it("asks whether it is a payment into another account", () => {
    // The repair path for the savings one-offs already saved with nowhere to
    // go: naming the destination here fixes the row in place.
    expect(row).toMatch(/Is it a payment into another account\?/);
    expect(rowCode).toMatch(/transferToAccountId: accountIdOf\(event\.target\.value\)/);
  });

  it("asks only about money going out", () => {
    /*
     * On something arriving, `paidFromAccountId` is where the money LANDS:
     * the engine reads the field as one end of a move and a deposit's runs
     * the other way, so the question would describe the opposite of what it
     * does.
     */
    expect(rowCode).toMatch(/const outgoing = row\.kind === "bill" \|\| row\.kind === "transfer"/);
    expect(rowCode).toMatch(/const sources = outgoing/);
    expect(rowCode).toMatch(/const destinations = outgoing/);
  });

  it("keeps the two ends out of each other's lists", () => {
    // Money that leaves an account and arrives in the same one has not moved.
    // The API refuses the pairing; not offering it means nobody meets that.
    expect(rowCode).toMatch(/sourceOptions\(accounts, pickedFrom\(row\.transferToAccountId\)\)/);
    expect(rowCode).toMatch(
      /destinationOptions\(accounts, pickedFrom\(row\.paidFromAccountId\)\)/,
    );
  });

  it("reads the current value off the row and keeps no copy of its own", () => {
    /*
     * No local state for either picker. A select has no half-typed state for a
     * Save button to guard, and a copy of the value would be a copy to go
     * stale the moment the other phone saved first - which is the whole
     * problem the version/merge machinery exists to avoid re-creating.
     */
    expect(rowCode).toMatch(/value=\{pickedFrom\(row\.paidFromAccountId\)\}/);
    expect(rowCode).toMatch(/value=\{pickedFrom\(row\.transferToAccountId\)\}/);
    expect(rowCode).not.toMatch(/useState\([^)]*paidFromAccountId/);
    expect(rowCode).not.toMatch(/useState\([^)]*transferToAccountId/);
  });

  it("goes through the same save path as every other field", () => {
    // So it carries the row's version, an idempotency key, and the 409
    // handling the panel already shows.
    expect(rowCode).toMatch(/void save\(\{ paidFromAccountId:/);
    expect(rowCode).toMatch(/void save\(\{ transferToAccountId:/);
  });

  it("says chequing in words, and says a cost is not a transfer", () => {
    // The same empty string either side, and not the same statement: a source
    // of "" is chequing, a destination of "" is nowhere.
    expect(row).toMatch(/<option value=\{CHEQUING\}>Chequing<\/option>/);
    expect(row).toMatch(/<option value=\{NOWHERE\}>No &mdash; it is a cost<\/option>/);
  });

  it("is given the accounts by the screen that already has them", () => {
    expect(ledger).toMatch(/accounts=\{data\.accounts\}/);
    expect(ledger).toMatch(/accounts=\{accounts\}/);
    expect(row).toMatch(/readonly accounts\?: readonly Account\[\]/);
  });

  it("asks nothing of a household with one account", () => {
    // An empty list renders no picker, which is right: the answer would
    // always be the same.
    expect(rowCode).toMatch(/\{sources\.length > 0 \? \(/);
    expect(rowCode).toMatch(/\{destinations\.length > 0 \? \(/);
  });

  it("can be sent as a change at all, which the type did not allow", () => {
    expect(queries).toMatch(/readonly paidFromAccountId\?: string \| null;/);
    expect(queries).toMatch(/readonly transferToAccountId\?: string \| null;/);
  });
});

describe("the one-off sheet, where the money was going missing", () => {
  it("sends a destination for a transfer, not only for a card", () => {
    // The bug, in one line. It used to read `kind === "card" ? { ... } : {}`.
    expect(oneOffCode).toMatch(
      /kind === "card" \? cardId : kind === "transfer" \? savingsId : CHEQUING/,
    );
    expect(oneOffCode).toMatch(
      /destinationId === CHEQUING \? \{\} : \{ transferToAccountId: destinationId \}/,
    );
  });

  it("refuses to save a transfer with nowhere to go", () => {
    // Rather than saving a row that quietly takes money out of chequing and
    // puts it nowhere.
    expect(oneOff).toMatch(/Pick which savings account this goes into/);
    expect(oneOffCode).toMatch(/needsDestination\(kind === "transfer", savingsId, savingsAccounts\)/);
  });

  it("still refuses a card payment with no card, as it already did", () => {
    expect(oneOff).toMatch(/Pick which card this pays/);
    expect(oneOffCode).toMatch(/needsDestination\(kind === "card", cardId, cards\)/);
  });

  it("does not offer a destination the household does not have", () => {
    // A choice with no valid answer is worse than no choice. The cards had
    // this guard from the start; savings never did.
    expect(oneOffCode).toMatch(/if \(option\.kind === "card"\) return cards\.length > 0/);
    expect(oneOffCode).toMatch(/if \(option\.kind === "transfer"\) return savingsAccounts\.length > 0/);
  });

  it("asks which savings account only when there is a choice to make", () => {
    expect(oneOffCode).toMatch(/kind === "transfer" && savingsAccounts\.length > 1/);
    expect(oneOff).toMatch(/Which savings account\?/);
  });
});

describe("the expense form, so a scheduled transfer lands", () => {
  it("asks where it pays into", () => {
    expect(billForm).toMatch(/Is it a payment into another account\?/);
    expect(billFormCode).toMatch(/destinationOptions\(accounts, paidFromAccountId\)/);
  });

  it("sends it on a new expense and on an edited one", () => {
    const sends = billFormCode.match(/transferToAccountId: accountIdOf\(transferToAccountId\)/g);
    expect(sends).toHaveLength(2);
  });

  it("makes a new one a transfer rather than a bill", () => {
    // What the schema means by "set this and the template stops being a bill".
    expect(billFormCode).toMatch(
      /kind: transferToAccountId === NOWHERE \? defaultKind : "transfer"/,
    );
  });

  it("keeps a card payment out of the budget", () => {
    /*
     * The charges on the card each carry their own section and are already
     * counted. Count the payment as well and every card expense is budgeted
     * twice - once as the spending and once as the settling. This is the rule
     * CLAUDE.md states as a non-negotiable, and `routes/budget.ts` draws the
     * same line independently, by account kind.
     */
    expect(billFormCode).toMatch(/sectionForDestination\(section, destination\)/);
    // And does not ask a question whose answer it is about to discard.
    expect(billFormCode).toMatch(/\{incoming \? null : paysACard \? \(/);
    expect(billForm).toMatch(/Paying a card is not a cost in the budget/);
  });

  it("keeps the section for a transfer into savings", () => {
    // The household treats what it puts aside each month as a real
    // commitment. Proved against values in routing.test.ts; this is the
    // check that the form routes the question through that rule at all.
    expect(routing).toMatch(/destination\?\.kind === "credit_card" \? null : section/);
  });

  it("says what marking it paid will do, where the choice is made", () => {
    expect(billForm).toMatch(/takes the money out of chequing and off the card/);
    expect(billForm).toMatch(/takes the money out of chequing and adds it to/);
  });

  it("does not offer to pay an account out of itself", () => {
    expect(billFormCode).toMatch(/sourceOptions\(accounts, transferToAccountId\)/);
  });
});

describe("one place that decides an account", () => {
  it("has the rules in a module of their own", () => {
    // The mirror of `accountDelta` being the only place that decides a sign.
    // The bug was not wrong logic; it was logic written three times with one
    // copy incomplete.
    expect(routing).toMatch(/export function sourceOptions/);
    expect(routing).toMatch(/export function destinationOptions/);
    expect(routing).toMatch(/export function needsDestination/);
    expect(routing).toMatch(/export function sectionForDestination/);
  });

  it("never offers chequing as a destination", () => {
    /*
     * The serious one, and the reason `destinationOptions` exists rather than
     * each screen filtering for itself. A null source already means chequing,
     * so chequing as a destination is money moving from an account into
     * itself: it nets to zero, and `requireValidRouting` cannot catch it,
     * because it compares a null against an id and they are not equal. Not
     * offering it is what keeps that unreachable from the UI.
     */
    expect(routing).toMatch(/account\.kind !== "chequing" && account\.id !== source/);
  });

  it("is not re-derived in any of the three screens", () => {
    /*
     * The cropStyle lesson, applied before it was needed: the fix is only a
     * fix while the screens go on asking rather than answering.
     *
     * Narrow to the account fields on purpose. `x === "" ? null : x` is the
     * ordinary way this codebase sends an unset `<select>`, and the owner, the
     * payday and the date all use it correctly - banning the idiom itself
     * would be banning something that was never the problem.
     */
    for (const source of [rowCode, oneOffCode, billFormCode]) {
      expect(source).not.toMatch(/accounts\.filter\(/);
      expect(source).not.toMatch(/(?:paidFrom|transferTo)AccountId[^\n]*=== "" \? null/);
    }
  });

  it("names the empty string on both ends rather than writing it out", () => {
    // Only where it means an account. "Not set" for an owner is a different
    // question with a legitimately blank answer.
    for (const source of [rowCode, oneOffCode, billFormCode]) {
      expect(source).not.toMatch(/<option value="">\s*Chequing/);
      expect(source).not.toMatch(/<option value="">\s*No &mdash;/);
    }
  });
});
