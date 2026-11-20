/**
 * The two ends of a move, as the pickers ask about them.
 *
 * Real unit tests rather than source greps, because this is the file that
 * exists to stop a repeat of the bug it was written for: "Into savings" sent
 * no destination, so money left chequing and arrived nowhere.
 */
import { describe, expect, it } from "vitest";
import {
  CHEQUING,
  accountFor,
  accountIdOf,
  destinationOptions,
  needsDestination,
  pickedFrom,
  sectionForDestination,
  sourceOptions,
  type RoutableAccount,
} from "../src/lib/routing.js";

const chequing: RoutableAccount = { id: "acc-cheq", name: "Chequing", kind: "chequing" };
const savings: RoutableAccount = { id: "acc-save", name: "Savings", kind: "savings" };
const visa: RoutableAccount = { id: "acc-visa", name: "Visa", kind: "credit_card" };
const mastercard: RoutableAccount = { id: "acc-mc", name: "Mastercard", kind: "credit_card" };
const all = [chequing, savings, visa, mastercard];

describe("chequing, which the API spells as a null", () => {
  it("is the empty option", () => {
    expect(CHEQUING).toBe("");
  });

  it("converts to null on the way out", () => {
    expect(accountIdOf(CHEQUING)).toBeNull();
    expect(accountIdOf("acc-visa")).toBe("acc-visa");
  });

  it("converts back from null, and from an absent field", () => {
    expect(pickedFrom(null)).toBe("");
    expect(pickedFrom(undefined)).toBe("");
    expect(pickedFrom("acc-visa")).toBe("acc-visa");
  });

  it("round-trips, which is the only property that matters", () => {
    for (const stored of [null, "acc-visa", "acc-save"]) {
      expect(accountIdOf(pickedFrom(stored))).toBe(stored);
    }
  });
});

describe("where money can come out of", () => {
  it("offers savings and the cards, never chequing", () => {
    // Chequing is the empty option. Listing it as well would be a list with a
    // second, wrong way to say the same thing.
    expect(sourceOptions(all).map((account) => account.id)).toEqual([
      "acc-save",
      "acc-visa",
      "acc-mc",
    ]);
  });

  it("leaves out whatever was picked as the destination", () => {
    // Money leaving an account and arriving in the same one has not moved.
    expect(sourceOptions(all, "acc-visa").map((account) => account.id)).toEqual([
      "acc-save",
      "acc-mc",
    ]);
  });

  it("is empty for a household with only a chequing account", () => {
    expect(sourceOptions([chequing])).toEqual([]);
  });
});

describe("where money can be a payment into", () => {
  it("offers savings and the cards", () => {
    // One list for both, because they are one thing to the engine: money
    // leaving one account and arriving in another.
    expect(destinationOptions(all).map((account) => account.id)).toEqual([
      "acc-save",
      "acc-visa",
      "acc-mc",
    ]);
  });

  it("never offers chequing, even by id", () => {
    /*
     * The serious one. A null source already means chequing, so chequing as a
     * destination is money moving from an account into itself - which nets to
     * zero, and which `requireValidRouting` cannot catch, because it compares
     * a null against an id and they are not equal. Not offering it is what
     * keeps that unreachable.
     */
    expect(destinationOptions(all)).not.toContain(chequing);
    expect(destinationOptions(all, CHEQUING)).not.toContain(chequing);
  });

  it("leaves out whatever was picked as the source", () => {
    expect(destinationOptions(all, "acc-save").map((account) => account.id)).toEqual([
      "acc-visa",
      "acc-mc",
    ]);
  });
});

describe("refusing to save a transfer with nowhere to go", () => {
  it("asks for a destination when one is wanted and none is picked", () => {
    // The bug, as a test: "Into savings" with nothing chosen used to save.
    expect(needsDestination(true, CHEQUING, [savings])).toBe(true);
  });

  it("is satisfied once one is picked", () => {
    expect(needsDestination(true, "acc-save", [savings])).toBe(false);
  });

  it("does not ask when this is not a transfer at all", () => {
    expect(needsDestination(false, CHEQUING, [savings])).toBe(false);
  });

  it("does not ask when the household has nowhere to send it", () => {
    // Nothing to pick means nothing to insist on; the choice is not offered,
    // so refusing to save would be a dead end rather than a correction.
    expect(needsDestination(true, CHEQUING, [])).toBe(false);
  });
});

describe("the budget section a destination allows", () => {
  it("drops it for a payment toward a card", () => {
    /*
     * The charges on the card each carry their own section and are already
     * counted. Count the payment as well and every card expense is budgeted
     * twice - once as the spending and once as the settling.
     */
    expect(sectionForDestination("fixed", visa)).toBeNull();
    expect(sectionForDestination("variable", mastercard)).toBeNull();
  });

  it("keeps it for a transfer into savings", () => {
    // Deliberate, and the household's call: what they put aside each month is
    // a real commitment. `routes/budget.ts` draws the line in the same place.
    expect(sectionForDestination("fixed", savings)).toBe("fixed");
  });

  it("keeps it when there is no destination at all", () => {
    expect(sectionForDestination("variable", null)).toBe("variable");
  });
});

describe("finding the account behind a picked value", () => {
  it("answers null for chequing, which has no row in the list", () => {
    expect(accountFor(all, CHEQUING)).toBeNull();
  });

  it("answers null for an id that is not there any more", () => {
    // An account deleted on the other phone while this sheet was open. Null
    // rather than a throw: the form then treats it as chequing, which is the
    // same answer the API gives a null source.
    expect(accountFor(all, "acc-gone")).toBeNull();
  });

  it("finds the one that was picked", () => {
    expect(accountFor(all, "acc-visa")).toBe(visa);
  });
});
