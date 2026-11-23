/**
 * The log has to read like something a person would say.
 *
 * These are the sentences two people will see on their phones - once in the
 * activity log, and once as a push notification, from this same function. A
 * wrong verb here is not a cosmetic bug: "marked the mortgage received"
 * describes money arriving when it left.
 */
import { describe, expect, it } from "vitest";
import { activitySentence, describeActivity, type ActivityEvent } from "../src/activity.js";

function event(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    action: "update",
    entity: "occurrence",
    label: "Power",
    labelKind: "bill",
    fields: [],
    ...over,
  };
}

describe("the things the household asked to be told about", () => {
  it("says a balance was updated, and which one", () => {
    expect(
      activitySentence(
        "Alex",
        event({
          action: "create",
          entity: "balance_snapshot",
          label: "Chequing",
          labelKind: "balance",
          fields: ["cents", "asOf"],
        }),
      ),
    ).toBe("Alex updated the Chequing balance");

    expect(
      activitySentence(
        "Jordan",
        event({
          action: "create",
          entity: "balance_snapshot",
          label: "Savings",
          labelKind: "balance",
          fields: ["cents", "asOf"],
        }),
      ),
    ).toBe("Jordan updated the Savings balance");
  });

  it("says a bill was verified", () => {
    expect(
      activitySentence("Alex", event({ action: "verify", label: "Mortgage", fields: ["verified"] })),
    ).toBe("Alex verified Mortgage");
  });

  it("says a bill was marked paid, and a payday received", () => {
    expect(describeActivity(event({ action: "clear", fields: ["paid"] }))).toBe("marked Power paid");

    // The ledger's own two buttons: "Mark as paid" for money leaving, "Mark
    // as received" for money arriving. Both are `clear` in the database.
    expect(
      describeActivity(event({ action: "clear", label: "Payday", labelKind: "payday", fields: ["paid"] })),
    ).toBe("marked Payday received");
  });

  it("says a work expense was bought, then submitted, then paid back", () => {
    const expense = { entity: "reimbursement", label: "Safety boots", labelKind: "work expense" };

    expect(
      describeActivity(event({ ...expense, action: "create", fields: ["purchase", "cents"] })),
    ).toBe("bought Safety boots");

    expect(
      describeActivity(
        event({ ...expense, action: "update", fields: ["submitted"], after: { submitted: true } }),
      ),
    ).toBe("submitted Safety boots for reimbursement");

    expect(
      describeActivity(event({ ...expense, action: "update", fields: ["paid"], after: { paid: true } })),
    ).toBe("marked Safety boots paid back");
  });
});

describe("telling apart the two things that are both 'clear'", () => {
  /*
   * `paid` is the ledger tick - somebody dealt with it. `cleared` is the
   * balance-update checklist - the money is already inside the figure just
   * typed. Bug 16 was these two being one flag doing both jobs, and the log
   * must not put them back together.
   */
  it("does not word the balance checklist as paying something", () => {
    expect(describeActivity(event({ action: "clear", fields: ["cleared"] }))).toBe(
      "counted Power in the new balance",
    );
    expect(describeActivity(event({ action: "unclear", fields: ["cleared"] }))).toBe(
      "took Power back out of the balance",
    );
  });

  it("words undoing the tick as undoing the tick", () => {
    expect(describeActivity(event({ action: "unclear", fields: ["paid"] }))).toBe(
      "undid paid on Power",
    );
    expect(
      describeActivity(event({ action: "unclear", labelKind: "payday", label: "Payday", fields: ["paid"] })),
    ).toBe("undid received on Payday");
  });
});

describe("the rest of the actions", () => {
  it.each([
    ["unverify", ["verified"], "undid verifying Power"],
    ["move", ["anchorOccurrenceId"], "moved Power to another payday"],
    ["soft_delete", ["deletedAt"], "removed Power"],
    ["restore", ["deletedAt"], "brought Power back"],
  ] as const)("words %s", (action, fields, expected) => {
    expect(describeActivity(event({ action, fields: [...fields] }))).toBe(expected);
  });

  it("says what kind of update it was when the fields make that plain", () => {
    expect(describeActivity(event({ fields: ["cents"] }))).toBe("changed the amount of Power");
    expect(describeActivity(event({ fields: ["date"] }))).toBe("moved Power to another day");
    expect(describeActivity(event({ fields: ["name"] }))).toBe("renamed Power");
    expect(describeActivity(event({ fields: ["ownerUserId"] }))).toBe("changed whose Power it is");
    // Two fields at once is just an update; guessing which mattered would be
    // worse than saying less.
    expect(describeActivity(event({ fields: ["cents", "date"] }))).toBe("updated Power");
  });

  it("words turning a bill off and back on", () => {
    expect(
      describeActivity(event({ entity: "template", fields: ["active"], after: { active: false } })),
    ).toBe("turned Power off");
    expect(
      describeActivity(event({ entity: "template", fields: ["active"], after: { active: true } })),
    ).toBe("turned Power back on");
  });
});

describe("rows that do not know their own name", () => {
  /*
   * Every row written before labels existed is one of these, and so is
   * anything genuinely nameless. The sentence still has to parse.
   */
  it("falls back to the kind of thing it was", () => {
    expect(describeActivity(event({ action: "verify", label: null }))).toBe("verified a bill");
  });

  it("reads a name out of the snapshot when there is no label", () => {
    /*
     * Every row written before labels existed takes this path, and a
     * creation already stored the whole row it created. The name was always
     * there; it only had to be read from where it already was - which is why
     * no back-fill was needed, and just as well, since `activity` is
     * insert-only and the database refuses to be rewritten.
     */
    expect(
      describeActivity(
        event({ action: "create", label: null, labelKind: null, fields: ["name"], after: { name: "Netflix" } }),
      ),
    ).toBe("added Netflix");

    // A work expense calls its name `purchase`.
    expect(
      describeActivity(
        event({
          action: "create",
          entity: "reimbursement",
          label: null,
          labelKind: null,
          fields: ["purchase"],
          after: { purchase: "Safety boots" },
        }),
      ),
    ).toBe("bought Safety boots");
  });

  it("uses the household's word for a table, never the schema's", () => {
    // "Alex turned a template off" is a sentence about a database.
    expect(
      describeActivity(
        event({ entity: "template", label: null, labelKind: null, fields: ["active"], after: { active: false } }),
      ),
    ).toBe("turned a recurring item off");
  });

  it("falls back to the table when there is no kind either", () => {
    expect(
      describeActivity(event({ action: "verify", label: null, labelKind: null })),
    ).toBe("verified an item");

    expect(
      describeActivity(
        event({ action: "create", entity: "budget_line", label: null, labelKind: null, fields: ["name"] }),
      ),
    ).toBe("added a budget category");
  });

  it("never leaves a dangling article or an empty subject", () => {
    const actions = [
      "create", "update", "verify", "unverify", "clear",
      "unclear", "move", "soft_delete", "restore", "snapshot",
    ] as const;

    for (const action of actions) {
      for (const label of [null, "", "   ", "Power"]) {
        for (const labelKind of [null, "", "bill", "payday", "balance", "work expense"]) {
          const text = describeActivity(event({ action, label, labelKind, fields: ["paid"] }));
          expect(text.length, `${action} produced nothing`).toBeGreaterThan(3);
          expect(text, `${action} left a dangling word`).not.toMatch(/\s{2,}|\s$/);
          expect(text, `${action} left an empty subject`).not.toMatch(/\b(a|an|the)\s*$/);
        }
      }
    }
  });
});

/**
 * "Purchases come from the Visa for now."
 *
 * The one household change worth telling the other person about, because it
 * is the only one that is *addressed* to them - it replaces somebody saying
 * it over breakfast, which is the whole reason it was asked for on
 * 2026-11-22. The cushion and the horizon are settings; a notification that
 * one of them moved would be noise.
 */
describe("where purchases come from, for now", () => {
  const posture = (over: Partial<ActivityEvent>): ActivityEvent =>
    event({
      entity: "household",
      labelKind: null,
      fields: ["spendFromAccountId", "spendFromUntil", "spendFromSetById"],
      ...over,
    });

  it("names the account, because 'a card' is worse than naming it", () => {
    // The row holds an id; the route puts the account's name in `label`.
    expect(
      activitySentence("Alex", posture({ label: "Visa", after: { spendFromAccountId: "a-1" } })),
    ).toBe("Alex said to put purchases on Visa for now");
  });

  it("says it the other way round when it is lifted", () => {
    /*
     * An explicit null is the posture being lifted. Read straight out of
     * `after` rather than through the boolean helper, which would return
     * undefined for a string field and send both cases down one branch.
     */
    expect(
      activitySentence("Alex", posture({ label: null, after: { spendFromAccountId: null } })),
    ).toBe("Alex said purchases come out of chequing again");
  });

  it("still reads when the row predates the name being recorded", () => {
    // Every branch in this file has to survive a missing label; a log that
    // shows a sentence with a hole in it is a log nobody trusts.
    expect(describeActivity(posture({ label: null, after: { spendFromAccountId: "a-1" } }))).toBe(
      "said to put purchases on a card for now",
    );
  });

  it("leaves every other household change alone", () => {
    // The cushion is a setting. It gets the generic wording and, in
    // `pushNotifier`, no notification at all.
    expect(
      describeActivity(
        event({ entity: "household", label: "Home", labelKind: null, fields: ["cushionCents"] }),
      ),
    ).toBe("updated Home");
  });
});

describe("no amounts, ever", () => {
  it("never puts a figure in the sentence", () => {
    /*
     * These sentences go through a push service and onto a lock screen. The
     * live-update ping between the two phones already refuses to carry an
     * amount, and the household chose the same for notifications.
     */
    const withMoney = event({
      action: "update",
      fields: ["cents"],
      after: { cents: "12345", name: "Power" },
    });
    expect(describeActivity(withMoney)).not.toMatch(/\d/);
    expect(activitySentence("Alex", withMoney)).not.toMatch(/\d/);
  });
});
