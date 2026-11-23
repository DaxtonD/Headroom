/**
 * "Purchases come from the Visa for now", and when it stops being true.
 *
 * Asked for on 2026-11-22, to replace a conversation the household was having
 * by hand: when chequing runs low, one of them tells the other in the morning
 * that necessary purchases go on the Visa until payday.
 *
 * ## Why one rule is in the engine
 *
 * Only the question "is it still in force" lives here, and it is here because
 * it would otherwise be written twice. The API needs it to decide what to
 * send; the screen needs it to decide what to show. If those two ever
 * disagreed, a banner would be telling the household to use a card that the
 * one-off form had already stopped defaulting to - which is worse than not
 * having the feature, because the figures would then be wrong in the
 * direction nobody checks.
 *
 * ## Derived, not stored
 *
 * There is no "active" column. An hour either side of midnight is exactly
 * when a stored flag would be wrong, and nothing runs at midnight to fix it.
 */
import { describe, expect, it } from "vitest";
import { spendFromIsActive } from "../src/spendFrom.js";

const VISA = "account-visa";

describe("while it is in force", () => {
  it("applies on the days before it ends", () => {
    expect(spendFromIsActive({ accountId: VISA, until: "2026-12-04" }, "2026-11-22")).toBe(true);
  });

  it("still applies on the last day itself", () => {
    /*
     * Inclusive, because that is how somebody says it: a posture set "until
     * Friday" is in force on Friday. Dropping it the morning of the day they
     * named is an off-by-one-day that would only ever be noticed as money
     * recorded against the wrong account.
     */
    expect(spendFromIsActive({ accountId: VISA, until: "2026-11-22" }, "2026-11-22")).toBe(true);
  });

  it("lapses the day after, with nothing having to run", () => {
    expect(spendFromIsActive({ accountId: VISA, until: "2026-11-21" }, "2026-11-22")).toBe(false);
  });

  it("lapses across a month end, and a year end", () => {
    // Plain dates compared as dates, not as numbers that happen to sort.
    expect(spendFromIsActive({ accountId: VISA, until: "2026-11-30" }, "2026-12-01")).toBe(false);
    expect(spendFromIsActive({ accountId: VISA, until: "2026-12-31" }, "2027-01-01")).toBe(false);
    expect(spendFromIsActive({ accountId: VISA, until: "2027-01-01" }, "2026-12-31")).toBe(true);
  });
});

describe("the ordinary state", () => {
  it("is what no account means", () => {
    // Absent and "chequing" are the same thing, which is why there is no
    // third state to represent.
    expect(spendFromIsActive({ accountId: null, until: "2027-01-01" }, "2026-11-22")).toBe(false);
  });

  it("is also what a posture with no end means", () => {
    /*
     * Strict on purpose. The route always sets an end when it sets an
     * account, so an account without one is damage rather than a choice -
     * and the safe reading of damage is the ordinary state. Treating it as
     * open-ended would put the household on card spending for ever because
     * of a half-written row.
     */
    expect(spendFromIsActive({ accountId: VISA, until: null }, "2026-11-22")).toBe(false);
  });

  it("is what both being absent means", () => {
    expect(spendFromIsActive({ accountId: null, until: null }, "2026-11-22")).toBe(false);
  });
});
