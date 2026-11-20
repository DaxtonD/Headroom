/**
 * Paying a lump sum off the mortgage, from the ledger.
 *
 * Reported on 2026-11-20: "How do I make a lump sum payment to the mortgage?
 * It's not accessible from the ledger screen (one-off). The only way to do it
 * is from the savings screen (Add a lump sum) but it doesn't specify where the
 * money is coming out of."
 *
 * The arithmetic and the two screens agreeing are proved in
 * `apps/api/test/mortgageLumpSum.test.ts` against a real Postgres. What is
 * checked here is the shape of the two forms, because the whole report was
 * about which form asks which question.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const oneOff = source("src/components/OneOffForm.tsx");
const savingsPage = source("src/pages/Savings.tsx");
const savingsCss = source("src/pages/Savings.css");
const ledger = source("src/pages/Ledger.tsx");
const queries = source("src/lib/queries.ts");

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at) + 1);
}

describe("the one-off sheet", () => {
  it("offers paying the mortgage", () => {
    expect(oneOff).toContain('{ kind: "mortgage", label: "Lump sum off the mortgage" }');
  });

  /**
   * Same rule as the cards and the savings accounts: a choice with no valid
   * answer is worse than no choice. A household with no mortgage never sees
   * it.
   */
  it("hides it when there is no mortgage", () => {
    expect(oneOff).toContain('if (option.kind === "mortgage") return mortgageId !== null;');
  });

  /**
   * The answer to the report. Every one-off already asks which account the
   * money leaves, so routing a lump sum through this form is what gives it a
   * source at all - the Savings form had none to give.
   */
  it("sends the source account, like every other one-off", () => {
    expect(oneOff).toContain("paidFromAccountId: accountIdOf(paidFromAccountId)");
  });

  /**
   * Not a transfer. The mortgage is not an account, so there is no balance
   * for the money to arrive in - it leaves as an ordinary bill that names
   * the mortgage it paid.
   */
  it("sends it as a bill naming the mortgage, not as a transfer", () => {
    expect(oneOff).toContain(
      'kind: kind === "card" ? "transfer" : kind === "mortgage" ? "bill" : kind,',
    );
    expect(oneOff).toContain(
      '...(kind === "mortgage" && mortgageId !== null ? { mortgageId } : {}),',
    );
  });

  it("is given the mortgage by the ledger", () => {
    expect(ledger).toContain("mortgageId={data.mortgageId}");
    expect(queries).toContain("readonly mortgageId: string | null;");
  });
});

describe("the Savings screen", () => {
  /** The visible half of the fix: a lump sum now has an account behind it. */
  it("says which account each paid lump sum came out of", () => {
    expect(savingsPage).toContain("lump.fromAccountName !== null");
    expect(savingsPage).toContain("from {lump.fromAccountName}");
  });

  /**
   * A lump sum that is a ledger row has no copy here, so there is nothing
   * here to edit. Offering an Edit would mean writing a second record, which
   * is exactly the drift this design removes.
   */
  it("sends you to the ledger rather than offering an edit it cannot make", () => {
    expect(savingsPage).toContain("lump.occurrenceId === null ?");
    expect(savingsPage).toContain("On the ledger");
  });

  /** An anchor is an inline box, so the 44px target has to be stated. */
  it("keeps that link a full-size target", () => {
    const link = rule(savingsCss, "a.savings__edit");
    expect(link).toContain("display: inline-flex");
    expect(rule(savingsCss, ".savings__edit")).toContain("min-height: var(--hr-touch-min)");
  });

  /**
   * The two are different facts and the screen now says so in those words:
   * one you have paid, one you intend to. Before this, "Add a lump sum" was
   * the only door and it quietly did neither properly.
   */
  it("separates planning one from recording one already paid", () => {
    expect(savingsPage).toContain("Plan a lump sum");
    expect(savingsPage).toContain("Record one paid");
    expect(savingsPage).toContain("already paid</strong> is added on the ledger");
  });
});
