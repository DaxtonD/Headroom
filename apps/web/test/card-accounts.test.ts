/**
 * What the screens do once money can come out of more than one account.
 *
 * ## The change being protected
 *
 * A charge on a credit card is not a chequing withdrawal. It shows on the
 * ledger, it keeps its date and its amount, and it moves the card rather than
 * chequing - because none of chequing's money moves until the card itself is
 * paid.
 *
 * That is more honest than what it replaced, and it made exactly one thing
 * riskier: the chequing forecast correctly stops falling for charges, so a
 * card balance can grow while safe-to-spend looks healthy. The household was
 * asked which way to resolve that and chose to keep safe-to-spend a pure
 * chequing figure - it is the one number whose working fits in a sentence -
 * and to have the app say so loudly instead.
 *
 * So the warning is load-bearing. It is the only thing standing between a
 * growing debt and a home screen that looks fine, and these checks exist
 * because a warning that quietly stops being rendered fails silently.
 *
 * ## Why it is a source check
 *
 * There is no DOM in this suite. The arithmetic is covered where it lives:
 * the engine tests prove a charge moves the card and not chequing, and the
 * API tests prove it end to end against real Postgres. What a grep covers
 * well is the regression that would undo the display side of it - the running
 * balance going back to reading `settled`, the account chip disappearing, or
 * the warning losing its alert role and becoming a line nobody notices.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

const row = read("components", "OccurrenceRow.tsx");
const ledger = read("pages", "Ledger.tsx");
const ledgerCss = read("pages", "Ledger.css");
const sheet = read("components", "UpdateBalanceSheet.tsx");
const oneOff = read("components", "OneOffForm.tsx");
const billForm = read("components", "BillForm.tsx");
const manage = read("pages", "Manage.tsx");
const queries = read("lib", "queries.ts");

describe("a row that moved nothing", () => {
  it("decides from the delta, not from whether it settled", () => {
    /*
     * A charge on a card prints a figure that has not moved, and it is the
     * delta that decides so. Reading `row.cents` instead would leave a $95
     * charge showing a running balance it never reached and the column would
     * stop adding up.
     *
     * The class is named for the reason it survives. Settled rows used to
     * share it and now print no figure at all, so what is left here is only
     * the row whose money went somewhere else - which is the one case where
     * a repeated balance is the point rather than the problem.
     */
    expect(row).toMatch(/const movedNothing = row\.deltaCents === 0n/);
    expect(row).toMatch(
      /row__running--elsewhere.*movedNothing|movedNothing.*row__running--elsewhere/s,
    );
  });

  it("does not go back to reading the amount instead", () => {
    // A $95 charge is a real $95 and moved no chequing money. The amount is
    // the wrong thing to infer movement from.
    expect(row).not.toMatch(/row\.cents === 0n/);
  });
});

describe("naming the account a charge went on", () => {
  it("shows which card, on the row", () => {
    // Without this a charge is an amount with no running balance beside it,
    // and the only honest reading of that is "something is broken".
    expect(row).toMatch(/chargedTo \? <Chip/);
    expect(row).toMatch(/paidToward \? <Chip/);
  });

  it("takes the name from the screen rather than looking accounts up", () => {
    expect(row).toMatch(/readonly chargedTo\?: string \| null;/);
    expect(ledger).toMatch(/chargedTo=\{accountName\(entry\.row\.paidFromAccountId\)\}/);
    expect(ledger).toMatch(/paidToward=\{accountName\(entry\.row\.transferToAccountId\)\}/);
  });

  it("says nothing for chequing, which is almost every row", () => {
    // A chip on all but a handful of rows is noise, and its absence already
    // means chequing.
    expect(ledger).toMatch(/if \(!found \|\| found\.kind === "chequing"\) return null;/);
  });

  it("explains, when the row is opened, where the money does come from", () => {
    expect(row).toMatch(/Charged to \{chargedTo\}, so it does not come out of chequing/);
  });
});

describe("the warning about a card nobody is paying", () => {
  it("is an alert, in the hero, above the scroll", () => {
    expect(ledger).toMatch(/ledger__cards-warning" role="alert"/);

    // Before the pay-period list, not after it. A warning below the scroll is
    // a warning nobody reaches.
    const warningAt = ledger.indexOf("ledger__cards-warning");
    const periodsAt = ledger.indexOf("ledger__periods");
    expect(warningAt).toBeGreaterThan(0);
    expect(warningAt).toBeLessThan(periodsAt);
  });

  it("fires off the server's judgement rather than guessing locally", () => {
    // The rule for when a card needs paying is derived once, where the
    // projection is, so the API tests can hold it to account.
    expect(ledger).toMatch(/const unpaidCards = cards\.filter\(\(account\) => account\.needsPayment\)/);
    expect(queries).toMatch(/readonly needsPayment: boolean;/);
  });

  it("says why safe to spend does not already know", () => {
    // The household kept safe-to-spend a chequing figure on purpose. The
    // warning has to say that, or the two read as contradicting each other.
    expect(ledger).toMatch(/safe to spend does not know about this yet/);
  });

  it("points at the thing that fixes it", () => {
    expect(ledger).toMatch(/Add a payment as a one-off/);
    // And that thing exists.
    expect(oneOff).toMatch(/label: "Paying a credit card"/);
  });

  it("uses the alert pair the contrast test already covers", () => {
    // Not a new colour: --hr-warning-fg on --hr-warning-bg is checked at
    // 4.5:1 across all five themes.
    expect(ledgerCss).toMatch(/\.ledger__cards-warning \{[^}]*--hr-warning-bg/s);
    expect(ledgerCss).toMatch(/\.ledger__cards-warning \{[^}]*--hr-warning-fg/s);
  });
});

describe("the account strip", () => {
  it("shows what each account holds now and where it is heading", () => {
    expect(ledger).toMatch(/ledger__card-owed/);
    expect(ledger).toMatch(/account\.horizonCents === account\.cents/);
  });

  /**
   * A card's balance is what it OWES. Without the word, a number beside Visa
   * reads as money you have - which is the opposite of the truth and the one
   * misreading this strip exists to prevent. Savings gets the parallel word
   * so the two read down the column as one list.
   */
  it("says which way round each figure is", () => {
    expect(ledger).toContain('const word = account.kind === "credit_card" ? "owed" : "saved";');
  });

  it("is a strip rather than a sixth tab", () => {
    // Five tabs is why the home screen opens instantly.
    expect(ledger).toMatch(/ledger__cards" aria-labelledby/);
  });

  it("is not rendered at all by a household with nothing to put in it", () => {
    expect(ledger).toMatch(/\{strip\.length > 0 \?/);
  });

  /**
   * Comfortable lists the cards; compact lists savings as well, asked for
   * from use on 2026-11-21 - the point of that view is everything at a
   * glance, and "everything" with one account quietly missing is the version
   * that gets trusted and is wrong.
   *
   * Chequing is in neither. It is the figure at the top of this screen in
   * 34px type, and saying it twice within an inch is not a summary.
   */
  it("lists savings as well, but only in the compact view", () => {
    expect(ledger).toContain(
      "const strip = compact ? [...savingsAccounts, ...cards] : cards;",
    );
    expect(ledger).toContain(
      'data.accounts.filter((account) => account.kind === "savings")',
    );
    expect(ledger).toContain('{compact ? "Accounts" : "On cards"}');
  });

  /**
   * Done in the component rather than by hiding a row in CSS, which is the
   * opposite of how the compact ROWS work and is deliberate. Hiding the
   * savings row in the comfortable view would leave it in the accessibility
   * tree, so a screen reader would be read an account the screen does not
   * show.
   */
  it("decides this in the component, not in a stylesheet", () => {
    expect(ledger).toContain('const compact = useAppearanceValue().density === "compact";');
    expect(ledgerCss).not.toMatch(/\[data-density="compact"\][^{]*\.ledger__card \{[^}]*display:\s*none/);
  });
});

describe("a window's subtotal", () => {
  it("says what went on the cards, so the rows and the totals reconcile", () => {
    // A fortnight reporting nothing going out, with charges on screen, reads
    // as broken rather than as accurate.
    expect(ledger).toMatch(/period\.elsewhereCents > 0n/);
    expect(ledger).toMatch(/On cards</);
    expect(queries).toMatch(/readonly elsewhereCents: Cents;/);
  });

  it("says that figure is not inside the others", () => {
    expect(ledger).toMatch(/is not in that: it comes out when you pay the card/);
  });
});

describe("typing a balance", () => {
  it("asks which account, once there is more than one", () => {
    expect(sheet).toMatch(/\{accounts\.length > 1 \?/);
    expect(sheet).toMatch(/Which account\?/);
  });

  it("leaves a one-account household with the two taps it always had", () => {
    // The picker is conditional, not always drawn and sometimes short.
    expect(sheet).toMatch(/accounts\.length > 1/);
  });

  it("asks for what a card owes, without a minus sign", () => {
    expect(sheet).toMatch(/Owed on \$\{selected\?\.name/);
    expect(sheet).toMatch(/Enter what the card owes, without a minus sign/);
  });

  it("clears the amount when the account changes", () => {
    // Otherwise one account's balance is typed into another's, which is the
    // worst possible outcome from a picker.
    expect(sheet).toMatch(/setAccountId\(account\.id\);[\s\S]{0,400}setAmountText\(""\)/);
    expect(sheet).toMatch(/setTicked\(new Set\(\)\)/);
  });

  it("says so when the figure typed is not the one Headroom expected", () => {
    /*
     * Mentioned, never enforced. The figure read off the bank or the statement
     * is the fact and the expectation is the derivation; refusing to record
     * the fact because the derivation disagrees would invert which of the two
     * is authoritative.
     *
     * On a card this gap is the useful number in its own right: the household
     * enters the subscriptions but not every coffee, so what is typed will
     * usually exceed what was expected, and the difference is unmodelled card
     * spending with a figure on it.
     */
    expect(sheet).toMatch(/Headroom expected <span className="hr-amount">\{formatCents\(gap\.expected\)/);
    expect(sheet).toMatch(/A charge nobody entered\?/);

    // A mention, in the quiet pair: the loud colours mean "something needs
    // doing", and this needs nothing doing.
    const css = readFileSync(
      resolve(import.meta.dirname, "..", "src", "components", "UpdateBalanceSheet.css"),
      "utf8",
    );
    expect(css).toMatch(/\.sheet__gap \{[^}]*--hr-green-tint-soft/s);
    expect(css).not.toMatch(/\.sheet__gap \{[^}]*--hr-warning/s);
  });

  it("measures the gap from the per-account delta, not the face value", () => {
    /*
     * The trap. A payment toward a card is stored as money leaving chequing,
     * so its amount is negative - and on the card it REDUCES what is owed.
     * Reasoning from the amount plus a sign rule for cards reports the debt
     * moving the wrong way.
     */
    expect(sheet).toMatch(/total \+ candidate\.deltaCents/);
    expect(sheet).not.toMatch(/total \+ candidate\.cents/);
    expect(queries).toMatch(/readonly deltaCents: Cents;/);
  });

  it("asks the checklist per account", () => {
    // A charge on a card has no business on the chequing checklist: ticking
    // it there would retire it against a figure that never contained it.
    expect(sheet).toMatch(/useClearableCandidates\(selectedId !== null, selectedId \?\? undefined\)/);
    expect(queries).toMatch(/accountId \? `\/api\/balance\/clearable\?accountId=\$\{accountId\}`/);
  });

  it("keys the checklist by account, so one account's list is not served for another", () => {
    expect(queries).toMatch(/queryKey: \["balance", "clearable", accountId \?\? "chequing"\]/);
  });
});

describe("making a payment toward a card", () => {
  it("is offered as the household's own words, not as a transfer", () => {
    expect(oneOff).toMatch(/\{ kind: "card", label: "Paying a credit card" \}/);
    // And mapped to what the API actually takes.
    expect(oneOff).toMatch(/kind: kind === "card" \? "transfer" : kind/);
    /*
     * The destination used to be sent only for a card, in those words. It is
     * now one value for both kinds that move money, because the branch that
     * named only the card is what left "Into savings" sending nothing.
     */
    expect(oneOff).toMatch(/kind === "card" \? cardId : kind === "transfer" \? savingsId/);
    expect(oneOff).toMatch(/transferToAccountId: destinationId/);
  });

  it("is not offered to a household with no cards", () => {
    // Now one rule covering both destinations rather than a clause about
    // cards, since "Into savings" needs the same guard and never had it.
    expect(oneOff).toMatch(/if \(option\.kind === "card"\) return cards\.length > 0/);
  });

  it("refuses to be saved without saying which card", () => {
    expect(oneOff).toMatch(/Pick which card this pays/);
  });

  it("can come out of savings instead of chequing", () => {
    expect(oneOff).toMatch(/Which account does it come out of\?/);
    // `CHEQUING` is the same empty string, named: the API spells chequing as a
    // null source and a `<select>` cannot hold one. routing.test.ts proves the
    // round trip.
    expect(oneOff).toMatch(/<option value=\{CHEQUING\}>Chequing<\/option>/);
  });

  it("does not offer to pay a card out of itself", () => {
    // The API refuses it; offering it would be an error waiting to be made.
    //
    // Done by excluding the destination from the source list, which is one
    // rule for every kind instead of a clause about cards - and is tested
    // against values in routing.test.ts.
    expect(oneOff).toMatch(/sourceOptions\(accounts, destinationId\)/);
  });
});

describe("setting a bill up on a card", () => {
  it("asks which account a recurring bill comes out of", () => {
    expect(billForm).toMatch(/Which account does it come out of\?/);
    expect(billForm).toMatch(/paidFromAccountId: accountIdOf\(paidFromAccountId\)/);
  });

  it("says what changes, where the choice is made", () => {
    expect(billForm).toMatch(/without moving the chequing balance/);
  });

  it("keeps the budget section, because a charge is still a real cost", () => {
    // The charges are the cost and belong in the budget; it is the payment
    // toward the card that must not be counted as well.
    expect(billForm).toMatch(/On the budget, is it fixed or variable\?/);
  });
});

describe("adding a card", () => {
  it("can be done from Manage", () => {
    expect(manage).toMatch(/Add a credit card/);
    expect(manage).toMatch(/setAdding\("credit_card"\)/);
  });

  it("is labelled on the row, because the kinds behave differently", () => {
    expect(manage).toMatch(/"Credit card"/);
  });

  it("does not guess a name, since there is usually more than one card", () => {
    expect(manage).toMatch(/setAdding\("credit_card"\);[\s\S]{0,300}setNewName\(""\)/);
  });
});
