/**
 * The one sentence under each pay period.
 *
 * ## Why it exists
 *
 * Asked for on 2026-11-22. The summary under each period had grown into five
 * figures, and the question put to it was whether any of them were needed:
 * the account balances are in a strip at the top of the same screen, the
 * balance right now has a line of its own, the rows say what is coming and
 * when, and every cheque already carries its own left-over. The answer was
 * that one question is genuinely unanswered anywhere else - **does this
 * period work, and where is it tightest** - and that the summary should
 * answer that and stop.
 *
 * ## Why in the engine, and tested here
 *
 * It could have been assembled on the screen out of the figures beside it,
 * which is exactly how it would have come to disagree with them. Two further
 * reasons settled it:
 *
 *  - the threshold is the household's **cushion**, which `computePayPeriods`
 *    already has and the pay-period payload does not carry at all;
 *  - there is no DOM in the web suite, so a sentence built in a component can
 *    only ever be checked by grepping for its text. Here the behaviour is the
 *    thing under test.
 *
 * ## The rule it must keep
 *
 * **It never invents a judgment.** "Tight" means below the cushion, and the
 * cushion is a figure the household sets; nothing in here decides how much is
 * comfortable. That is also why the good case says only what the low point is
 * and offers no reassurance - with no cushion set, a period that bottoms out
 * at a dollar is "covered", and calling that comfortable would be the app
 * vouching for something it cannot know.
 */
import { describe, expect, it } from "vitest";
import { computePayPeriods } from "../src/payPeriods.js";
import { computeTimeline } from "../src/timeline.js";
import type { PayPeriod, PaySchedule, TimelineInput } from "../src/types.js";

const PAYDAY: PaySchedule = {
  id: "payday",
  ownerId: "one",
  anchorDate: "2026-11-12",
  defaultCents: 200_000n,
};

function autoBill(id: string, date: string, cents: bigint, name = id): TimelineInput {
  return { id, name, cents, kind: "bill", placement: "auto", date };
}

function flexibleBill(id: string, date: string, cents: bigint): TimelineInput {
  return { id, name: id, cents, kind: "bill", placement: "flexible", date };
}

function periods(options: {
  readonly events: readonly TimelineInput[];
  readonly startBalanceCents: bigint;
  readonly cushionCents?: bigint;
}): readonly PayPeriod[] {
  return computePayPeriods({
    timeline: computeTimeline({
      events: options.events,
      startBalanceCents: options.startBalanceCents,
      cushionCents: options.cushionCents ?? 0n,
    }),
    paySchedules: [PAYDAY],
    today: "2026-11-20",
    periodCount: 2,
    anchorScheduleId: PAYDAY.id,
    ...(options.cushionCents === undefined ? {} : { cushionCents: options.cushionCents }),
  });
}

/** The window today falls in, which is where every case below is arranged. */
function current(list: readonly PayPeriod[]): PayPeriod {
  const found = list.find((period) => period.isCurrentPartial);
  if (!found) throw new Error("no current period");
  return found;
}

describe("a period with an automatic withdrawal that is not covered", () => {
  const period = current(
    periods({
      startBalanceCents: 10_000n,
      events: [autoBill("hydro", "2026-11-24", -45_000n, "Hydro")],
    }),
  );

  it("is the loudest thing it can say", () => {
    expect(period.verdict.tone).toBe("short");
  });

  it("names the bill and says how much more it needs", () => {
    /*
     * The one case about a specific row, so it names it. "Something automatic
     * in this window is not covered" was the old line, and it left the two
     * questions anybody actually has - which one, and by how much - to be
     * answered by scrolling.
     */
    expect(period.verdict.sentence).toBe("Short on Tue, Nov 24 - Hydro needs $350.00 more.");
  });

  it("agrees with the flag beside it", () => {
    expect(period.allAutoCovered).toBe(false);
  });

  it("names the first one short, not the worst", () => {
    /*
     * Once one withdrawal has gone short every balance after it is lower for
     * the same reason, so the later ones are consequences. Naming the deepest
     * would be reporting one problem at its symptom.
     */
    const two = current(
      periods({
        startBalanceCents: 10_000n,
        events: [
          autoBill("hydro", "2026-11-24", -45_000n, "Hydro"),
          autoBill("phone", "2026-11-25", -9_000n, "Phone"),
        ],
      }),
    );

    expect(two.verdict.sentence).toContain("Hydro");
    expect(two.verdict.sentence).not.toContain("Phone");
  });
});

/**
 * "Tight" is a dip the household chose, not one the bank imposed.
 *
 * Worth being precise, because the two look the same on a balance and are
 * not the same problem. Coverage in this engine **includes the cushion** -
 * `timeline.ts` raises a shortfall whenever an automatic withdrawal would
 * leave the balance under it - so an automatic bill below the cushion is
 * already "short" and says so. What is left for "tight" is a low point
 * reached by something flexible: a bill whose day the household picked, or a
 * transfer. That is the dip worth a softer word, because it is the dip that
 * can be moved.
 */
describe("a period that dips below the cushion by choice", () => {
  it("is tight, and says where it dips to", () => {
    const period = current(
      periods({
        startBalanceCents: 100_000n,
        events: [flexibleBill("visa", "2026-11-24", -91_000n)],
        cushionCents: 50_000n,
      }),
    );

    expect(period.verdict.tone).toBe("tight");
    expect(period.verdict.sentence).toBe("Tight - dips to $90.00 on Tue, Nov 24.");
    // Nothing automatic is short, so this is a preference, not a failure.
    expect(period.allAutoCovered).toBe(true);
  });

  it("uses the household's cushion and no number of its own", () => {
    /*
     * The same timeline, twice, differing only in the cushion. If anything in
     * here had an opinion about what "comfortable" means, these would not
     * disagree - and the app would be making a judgment nobody set.
     */
    const events = [flexibleBill("visa", "2026-11-24", -91_000n)];

    expect(
      current(periods({ startBalanceCents: 100_000n, events, cushionCents: 50_000n })).verdict.tone,
    ).toBe("tight");
    expect(
      current(periods({ startBalanceCents: 100_000n, events, cushionCents: 0n })).verdict.tone,
    ).toBe("fine");
  });

  it("calls an automatic bill under the cushion short rather than tight", () => {
    // The distinction above, held: the bank takes this one on its own date,
    // so there is nothing to move and nothing soft to say about it.
    const period = current(
      periods({
        startBalanceCents: 100_000n,
        events: [autoBill("rent", "2026-11-24", -91_000n, "Rent")],
        cushionCents: 50_000n,
      }),
    );

    expect(period.verdict.tone).toBe("short");
    expect(period.allAutoCovered).toBe(false);
    // The gap includes the cushion, the same way a shortfall does.
    expect(period.verdict.sentence).toBe("Short on Tue, Nov 24 - Rent needs $410.00 more.");
  });

  it("goes below zero as a tight period when nothing automatic caused it", () => {
    const period = current(
      periods({
        startBalanceCents: 100_000n,
        events: [flexibleBill("visa", "2026-11-24", -101_000n)],
      }),
    );

    expect(period.allAutoCovered).toBe(true);
    expect(period.verdict.tone).toBe("tight");
    expect(period.verdict.sentence).toContain("−$10.00");
  });
});

describe("a period with nothing wrong with it", () => {
  it("states the low point and offers no reassurance", () => {
    /*
     * Deliberately not "comfortable". With no cushion set a period that
     * bottoms out at a dollar is covered, and a warm word there would be the
     * app vouching for something it has no opinion about. The fact is enough,
     * and it is the fact somebody acts on.
     */
    const period = current(
      periods({
        startBalanceCents: 300_000n,
        events: [autoBill("rent", "2026-11-24", -120_000n)],
      }),
    );

    expect(period.verdict.tone).toBe("fine");
    expect(period.verdict.sentence).toBe("Tightest at $1,800.00 on Tue, Nov 24.");
    expect(period.verdict.sentence).not.toMatch(/comfortable|healthy|fine|good/iu);
  });
});

describe("a period with nothing in it", () => {
  it("says so, rather than leaving a blank where a sentence goes", () => {
    // An empty summary reads as a screen that failed to load.
    const list = periods({ startBalanceCents: 300_000n, events: [] });
    const empty = list.find((period) => !period.isCurrentPartial && period.rowIds.length === 0);

    expect(empty?.verdict.tone).toBe("quiet");
  });

  it("does not claim a low point for a period where this account never moved", () => {
    /*
     * A fortnight of card charges. The balance never moved, so there is no
     * low point, and "tightest at" a figure no row produced would be a
     * sentence about nothing.
     */
    const period = current(
      periods({
        startBalanceCents: 300_000n,
        events: [
          {
            ...autoBill("groceries", "2026-11-24", -9_500n),
            fromAccountId: "card",
          },
          { ...autoBill("opening", "2026-11-24", -1n), fromAccountId: null },
        ].slice(0, 1),
      }),
    );

    expect(period.lowest).toBeNull();
    expect(period.verdict.tone).toBe("quiet");
    expect(period.verdict.sentence).toBe("Nothing comes out of chequing in this period.");
  });
});

describe("what the sentence is allowed to contain", () => {
  const all = periods({
    startBalanceCents: 10_000n,
    events: [autoBill("hydro", "2026-11-24", -45_000n, "Hydro")],
  });

  it("is one sentence, ending in a full stop", () => {
    /*
     * One sentence, because it sits above the figures in 15px type and a
     * paragraph there would be a second summary. Checked by looking for a
     * sentence BREAK rather than for a dot, since every amount has one.
     */
    for (const period of all) {
      expect(period.verdict.sentence, period.label).toMatch(/\.$/u);
      expect(period.verdict.sentence, period.label).not.toMatch(/\.\s/u);
    }
  });

  it("writes money the way the rest of the app does", () => {
    // U+2212 for a minus, grouped thousands, two decimal places - from
    // `formatCents`, not assembled by hand here.
    const tight = current(
      periods({
        startBalanceCents: 100_000n,
        events: [flexibleBill("visa", "2026-11-24", -1_101_000n)],
      }),
    );

    expect(tight.verdict.sentence).toContain("−$10,010.00");
    expect(tight.verdict.sentence).not.toContain("-$");
  });
});
