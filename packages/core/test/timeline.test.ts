/**
 * Timeline and pay-period behaviour the golden fixture does not reach:
 * an empty account, a non-zero cushion, ordering tie-breaks, clearing, and the
 * inputs the engine should refuse outright.
 *
 * Every amount here is invented.
 */
import { describe, expect, it } from "vitest";
import { compareDates } from "../src/dates.js";
import { computeHorizonEnd, computePayPeriods, payPeriodWindows } from "../src/payPeriods.js";
import { accountDelta, computeTimeline, effectiveBalance, orderTimeline,
  summariseTimeline,
} from "../src/timeline.js";
import type { PaySchedule, TimelineInput } from "../src/types.js";

const JORDAN: PaySchedule = {
  id: "jordan",
  ownerId: "jordan",
  anchorDate: "2026-11-12",
  defaultCents: 200_000n,
};
const ALEX: PaySchedule = {
  id: "alex",
  ownerId: "alex",
  anchorDate: "2026-11-19",
  defaultCents: 180_000n,
};

function paycheque(id: string, date: string, cents: bigint, payScheduleId?: string): TimelineInput {
  return {
    id,
    name: "Pay",
    cents,
    kind: "paycheque",
    placement: "auto",
    date,
    ...(payScheduleId ? { payScheduleId } : {}),
  };
}

function autoBill(id: string, date: string, cents: bigint): TimelineInput {
  return { id, name: id, cents, kind: "bill", placement: "auto", date };
}

function flexibleBill(id: string, anchorId: string | null, cents: bigint, sortIndex = 0): TimelineInput {
  return { id, name: id, cents, kind: "bill", placement: "flexible", anchorId, sortIndex };
}

describe("an empty timeline", () => {
  it("leaves the balance exactly where it is", () => {
    const result = computeTimeline({ events: [], startBalanceCents: 41_000n });

    expect(result.rows).toEqual([]);
    expect(result.leftThisCycleCents).toBe(41_000n);
    expect(result.lowest.cents).toBe(41_000n);
    expect(result.lowest.afterEventId).toBeNull();
    expect(result.safeToSpendNowCents).toBe(41_000n);
    expect(result.coverage.autoWithdrawalCount).toBe(0);
    expect(result.coverage.allCovered).toBe(true);
  });
});

describe("the lowest point", () => {
  it("is the current balance when nothing ever dips below it", () => {
    const result = computeTimeline({
      events: [paycheque("p1", "2026-11-12", 200_000n), autoBill("b1", "2026-11-13", -10_000n)],
      startBalanceCents: 50_000n,
    });

    expect(result.lowest.cents).toBe(50_000n);
    expect(result.lowest.afterEventId).toBeNull();
    expect(result.lowest.date).toBeNull();
  });

  it("is never above any running balance", () => {
    const result = computeTimeline({
      events: [
        flexibleBill("power", null, -15_000n),
        paycheque("p1", "2026-11-12", 200_000n),
        autoBill("big", "2026-11-13", -180_000n),
      ],
      startBalanceCents: 41_000n,
    });

    for (const row of result.rows) {
      expect(result.lowest.cents <= row.runningCents).toBe(true);
    }
    expect(result.lowest.cents).toBe(26_000n);
    expect(result.lowest.afterEventId).toBe("power");
  });

  it("can go negative, and says where", () => {
    const result = computeTimeline({
      events: [autoBill("b1", "2026-11-13", -50_000n)],
      startBalanceCents: 10_000n,
    });

    expect(result.lowest.cents).toBe(-40_000n);
    expect(result.lowest.afterEventId).toBe("b1");
    expect(result.lowest.date).toBe("2026-11-13");
  });
});

describe("the cushion", () => {
  const events = [paycheque("p1", "2026-11-12", 100_000n), autoBill("rent", "2026-11-13", -95_000n)];

  it("is subtracted from what is safe to spend", () => {
    const withoutCushion = computeTimeline({ events, startBalanceCents: 20_000n });
    const withCushion = computeTimeline({ events, startBalanceCents: 20_000n, cushionCents: 5_000n });

    expect(withoutCushion.safeToSpendNowCents).toBe(20_000n);
    expect(withCushion.safeToSpendNowCents).toBe(15_000n);
  });

  it("makes a withdrawal uncovered even when the balance stays positive", () => {
    // After rent the balance is $250, which is above zero but below a $300 cushion.
    const result = computeTimeline({
      events,
      startBalanceCents: 20_000n,
      cushionCents: 30_000n,
    });

    expect(result.coverage.allCovered).toBe(false);
    expect(result.coverage.firstShortfall?.eventId).toBe("rent");
    expect(result.coverage.firstShortfall?.runningCents).toBe(25_000n);
    expect(result.coverage.firstShortfall?.shortCents).toBe(5_000n);
  });

  it("reports the FIRST failure, which is the one to act on", () => {
    const result = computeTimeline({
      events: [
        autoBill("first", "2026-11-13", -30_000n),
        autoBill("second", "2026-11-14", -30_000n),
      ],
      startBalanceCents: 10_000n,
    });

    expect(result.coverage.firstShortfall?.eventId).toBe("first");
  });
});

describe("what needs covering", () => {
  it("counts only dated money going out", () => {
    const result = computeTimeline({
      events: [
        paycheque("p1", "2026-11-12", 200_000n),
        autoBill("bill", "2026-11-13", -10_000n),
        { id: "ctc", name: "Credit", cents: 10_000n, kind: "deposit", placement: "auto", date: "2026-11-20" },
        flexibleBill("power", null, -15_000n),
      ],
      startBalanceCents: 41_000n,
    });

    expect(result.coverage.autoWithdrawalCount).toBe(1);

    const byId = new Map(result.rows.map((row) => [row.event.id, row]));
    expect(byId.get("bill")?.requiresCoverage).toBe(true);
    // An automatic deposit brings money in; there is nothing to cover.
    expect(byId.get("ctc")?.requiresCoverage).toBe(false);
    expect(byId.get("p1")?.requiresCoverage).toBe(false);
    // A flexible bill can be moved, so it is not a hard commitment.
    expect(byId.get("power")?.requiresCoverage).toBe(false);
  });
});

describe("estimates", () => {
  it("counts bills nobody has confirmed yet", () => {
    const result = computeTimeline({
      events: [
        { ...autoBill("verified", "2026-11-13", -10_000n), verified: true },
        autoBill("estimate1", "2026-11-14", -10_000n),
        flexibleBill("estimate2", null, -10_000n),
        // A paycheque is not a bill waiting for a number.
        paycheque("p1", "2026-11-12", 200_000n),
      ],
      startBalanceCents: 100_000n,
    });

    expect(result.estimatesCount).toBe(2);
  });
});

describe("ordering", () => {
  it("puts a paycheque before other dated items on the same day", () => {
    const ordered = orderTimeline([
      autoBill("bill", "2026-11-12", -10_000n),
      paycheque("pay", "2026-11-12", 200_000n),
    ]);

    expect(ordered.map((event) => event.id)).toEqual(["pay", "bill"]);
  });

  it("puts flexible items between the paycheque and other dated items", () => {
    const ordered = orderTimeline([
      autoBill("bill", "2026-11-12", -10_000n),
      flexibleBill("flex", "pay", -5_000n),
      paycheque("pay", "2026-11-12", 200_000n),
    ]);

    expect(ordered.map((event) => event.id)).toEqual(["pay", "flex", "bill"]);
  });

  it("respects the user's chosen order within one anchor", () => {
    const ordered = orderTimeline([
      paycheque("pay", "2026-11-12", 200_000n),
      flexibleBill("third", "pay", -1_000n, 3),
      flexibleBill("first", "pay", -1_000n, 1),
      flexibleBill("second", "pay", -1_000n, 2),
    ]);

    expect(ordered.map((event) => event.id)).toEqual(["pay", "first", "second", "third"]);
  });

  it("is stable when two items are genuinely equal", () => {
    const ordered = orderTimeline([
      flexibleBill("a", null, -1_000n, 0),
      flexibleBill("b", null, -1_000n, 0),
      flexibleBill("c", null, -1_000n, 0),
    ]);

    expect(ordered.map((event) => event.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the array it was given", () => {
    const events = [
      autoBill("bill", "2026-11-12", -10_000n),
      paycheque("pay", "2026-11-12", 200_000n),
    ];
    const before = events.map((event) => event.id);

    orderTimeline(events);

    expect(events.map((event) => event.id)).toEqual(before);
  });
});

describe("inputs the engine refuses", () => {
  it("refuses a dated item with no date", () => {
    expect(() =>
      computeTimeline({
        events: [{ id: "x", name: "Mortgage", cents: -1n, kind: "bill", placement: "auto" }],
        startBalanceCents: 0n,
      }),
    ).toThrow(/has no date/);
  });

  it("places a flexible item on the day it is planned for", () => {
    /*
     * A planned date says when the household means to pay it, so the running
     * balance has to show it leaving then - but it is still their choice, so
     * it must never be reported as something the bank will take whether or not
     * the money is there.
     */
    const result = computeTimeline({
      events: [
        {
          id: "pay",
          name: "Pay",
          cents: 200_000n,
          kind: "paycheque",
          placement: "auto",
          date: "2026-11-12",
        },
        {
          id: "rent",
          name: "Rent",
          cents: -80_000n,
          kind: "bill",
          placement: "auto",
          date: "2026-11-25",
        },
        {
          id: "visa",
          name: "Visa",
          cents: -30_000n,
          kind: "bill",
          placement: "flexible",
          date: "2026-11-20",
        },
      ],
      startBalanceCents: 0n,
    });

    // In date order, between the cheque and the rent.
    expect(result.rows.map((row) => row.event.id)).toEqual(["pay", "visa", "rent"]);
    expect(result.rows.map((row) => row.runningCents)).toEqual([200_000n, 170_000n, 90_000n]);
    expect(result.rows[1]?.effectiveDate).toBe("2026-11-20");
    // Flexible, so it is not one of the things coverage is about.
    expect(result.rows[1]?.requiresCoverage).toBe(false);
    expect(result.coverage.autoWithdrawalCount).toBe(1);
  });

  it("sorts a planned flexible item under a cheque landing the same day", () => {
    const result = computeTimeline({
      events: [
        {
          id: "visa",
          name: "Visa",
          cents: -30_000n,
          kind: "bill",
          placement: "flexible",
          date: "2026-11-12",
        },
        {
          id: "water",
          name: "Water",
          cents: -14_400n,
          kind: "bill",
          placement: "auto",
          date: "2026-11-12",
        },
        {
          id: "pay",
          name: "Pay",
          cents: 200_000n,
          kind: "paycheque",
          placement: "auto",
          date: "2026-11-12",
        },
      ],
      startBalanceCents: 0n,
    });

    // The pay lands first, then what we choose to pay out of it, then what the
    // bank takes on its own account (HANDOFF section 6.2).
    expect(result.rows.map((row) => row.event.id)).toEqual(["pay", "visa", "water"]);
  });

  it("refuses a flexible item placed two ways at once", () => {
    // A date is now allowed on a flexible item - it is the day the household
    // plans to pay it. A date AND an anchor paycheque is not: there would be
    // no answer to where the row goes.
    expect(() =>
      computeTimeline({
        events: [
          {
            id: "pay",
            name: "Pay",
            cents: 100n,
            kind: "paycheque",
            placement: "auto",
            date: "2026-11-12",
          },
          {
            id: "x",
            name: "Power",
            cents: -1n,
            kind: "bill",
            placement: "flexible",
            date: "2026-11-20",
            anchorId: "pay",
          },
        ],
        startBalanceCents: 0n,
      }),
    ).toThrow(/placed one way or the other/);
  });

  it("refuses an anchor that is not a paycheque in this timeline", () => {
    expect(() =>
      computeTimeline({
        events: [flexibleBill("power", "no-such-paycheque", -1n)],
        startBalanceCents: 0n,
      }),
    ).toThrow(/not a paycheque in this timeline/);
  });
});

describe("effectiveBalance", () => {
  it("is the snapshot plus anything cleared since it was taken", () => {
    // Section 6.1: a cleared bill has already hit the account, so it is added
    // to the typed-in balance and leaves the timeline.
    expect(effectiveBalance(41_000n, [])).toBe(41_000n);
    expect(effectiveBalance(41_000n, [-15_000n])).toBe(26_000n);
    expect(effectiveBalance(41_000n, [-15_000n, 200_000n])).toBe(226_000n);
  });
});

describe("pay period windows", () => {
  it("opens with a partial window when today is not a payday", () => {
    const windows = payPeriodWindows("2026-11-07", JORDAN, 3);

    expect(windows[0]).toEqual({ start: "2026-11-07", end: "2026-11-11", isCurrentPartial: true, endsAtHorizon: false });
    expect(windows[1]).toEqual({ start: "2026-11-12", end: "2026-11-25", isCurrentPartial: false, endsAtHorizon: false });
    expect(windows[2]).toEqual({ start: "2026-11-26", end: "2026-12-09", isCurrentPartial: false, endsAtHorizon: false });
  });

  it("has no partial window when today IS a payday", () => {
    const windows = payPeriodWindows("2026-11-12", JORDAN, 2);

    expect(windows[0]).toEqual({ start: "2026-11-12", end: "2026-11-25", isCurrentPartial: false, endsAtHorizon: false });
    expect(windows[1]).toEqual({ start: "2026-11-26", end: "2026-12-09", isCurrentPartial: false, endsAtHorizon: false });
  });

  /**
   * Reported 2026-11-19: a window on screen reading 10-23 December, and a
   * subscription renewing on the 18th that was nowhere on it.
   *
   * The windows are whole fortnights; the horizon is a count of paycheques.
   * With two earners whose paydays interleave, the horizon lands in the middle
   * of a fortnight - here the 16th, inside a window running to the 23rd. The
   * caller fetches no row past the horizon, so the window was structurally
   * unable to show the last week of its own bills while still counting the pay
   * that arrives in it.
   */
  describe("the horizon lands inside a window", () => {
    it("reports the window only as far as the ledger reaches, and says so", () => {
      const windows = payPeriodWindows("2026-11-19", JORDAN, 3, "2026-12-16");

      expect(windows[2]).toEqual({
        start: "2026-12-10",
        end: "2026-12-16",
        isCurrentPartial: false,
        endsAtHorizon: true,
      });
    });

    it("leaves every earlier window alone", () => {
      const windows = payPeriodWindows("2026-11-19", JORDAN, 3, "2026-12-16");

      expect(windows[0]).toEqual({
        start: "2026-11-19",
        end: "2026-11-25",
        isCurrentPartial: true,
        endsAtHorizon: false,
      });
      expect(windows[1]).toEqual({
        start: "2026-11-26",
        end: "2026-12-09",
        isCurrentPartial: false,
        endsAtHorizon: false,
      });
    });

    /*
     * The case that hid this for so long. An odd paycheque count lands on the
     * anchor person's own payday, so the horizon and the fortnight agree
     * exactly and there is nothing to clip. Five cheques instead of four is
     * the difference between the two.
     */
    it("does not clip a horizon that lands exactly on a window boundary", () => {
      const windows = payPeriodWindows("2026-11-19", JORDAN, 3, "2026-12-23");

      expect(windows[2]).toEqual({
        start: "2026-12-10",
        end: "2026-12-23",
        isCurrentPartial: false,
        endsAtHorizon: false,
      });
    });

    it("clips nothing when no horizon is given", () => {
      const windows = payPeriodWindows("2026-11-19", JORDAN, 3);

      expect(windows[2]?.end).toBe("2026-12-23");
      expect(windows[2]?.endsAtHorizon).toBe(false);
    });

    /*
     * A window that starts beyond the horizon exists because `periodCount`
     * asked for a minimum number of them, which is a different question.
     * Clipping it would produce a window ending before it starts.
     */
    it("never produces a window that ends before it starts", () => {
      const windows = payPeriodWindows("2026-11-19", JORDAN, 3, "2026-11-20");

      for (const window of windows) {
        expect(compareDates(window.start, window.end), JSON.stringify(window)).toBeLessThanOrEqual(
          0,
        );
      }
    });
  });

  it("keeps every full window exactly fourteen days", () => {
    for (const window of payPeriodWindows("2026-11-07", JORDAN, 6)) {
      if (window.isCurrentPartial) continue;
      expect(new Date(window.end).getTime() - new Date(window.start).getTime()).toBe(13 * 86_400_000);
    }
  });
});

describe("a settled row", () => {
  /*
   * Settled means the money has already moved and the opening balance knows
   * it. The row is kept on the ledger anyway, because a bill that vanishes
   * the moment it is dealt with is a bill nobody can check - which is the
   * complaint this exists to answer.
   *
   * Every assertion below is some form of "shown, but counted in nothing".
   */
  function settledBill(id: string, date: string, cents: bigint): TimelineInput {
    return { ...autoBill(id, date, cents), settled: true };
  }

  it("is shown, and the balance carries straight past it", () => {
    const result = computeTimeline({
      events: [
        settledBill("power", "2026-11-14", -10_000n),
        autoBill("water", "2026-11-20", -4_000n),
      ],
      startBalanceCents: 40_000n,
    });

    // Still there. This is the whole point.
    expect(result.rows.map((row) => row.event.id)).toEqual(["power", "water"]);

    // The settled one leaves the balance where it found it...
    expect(result.rows[0]?.runningCents).toBe(40_000n);
    // ...and the next row carries on from there, taken out once only.
    expect(result.rows[1]?.runningCents).toBe(36_000n);
    expect(result.leftThisCycleCents).toBe(36_000n);
  });

  it("does not drag the lowest point down a second time", () => {
    const settled = computeTimeline({
      events: [settledBill("power", "2026-11-14", -10_000n)],
      startBalanceCents: 40_000n,
    });

    expect(settled.lowest.cents).toBe(40_000n);
    // Nothing moved, so nothing is to blame for the low point.
    expect(settled.lowest.afterEventId).toBeNull();
    expect(settled.safeToSpendNowCents).toBe(40_000n);

    // The same row unsettled is still coming, and still lowers everything.
    const unsettled = computeTimeline({
      events: [autoBill("power", "2026-11-14", -10_000n)],
      startBalanceCents: 40_000n,
    });

    expect(unsettled.lowest.cents).toBe(30_000n);
    expect(unsettled.lowest.afterEventId).toBe("power");
  });

  it("is not an estimate, whatever its amount says", () => {
    // Unverified: the figure was never confirmed against a real bill. But the
    // money has gone, so there is nothing left to find out.
    const result = computeTimeline({
      events: [settledBill("power", "2026-11-14", -10_000n)],
      startBalanceCents: 40_000n,
    });

    expect(result.estimatesCount).toBe(0);
  });

  it("needs no coverage, so it cannot raise a shortfall", () => {
    const result = computeTimeline({
      events: [settledBill("power", "2026-11-14", -90_000n)],
      startBalanceCents: 1_000n,
      cushionCents: 5_000n,
    });

    // An auto withdrawal far larger than the account holds - but it left days
    // ago without incident. Asking whether it is covered asks about the past.
    expect(result.rows[0]?.requiresCoverage).toBe(false);
    expect(result.coverage.autoWithdrawalCount).toBe(0);
    expect(result.coverage.allCovered).toBe(true);
    expect(result.coverage.firstShortfall).toBeNull();
  });

  it("adds nothing to a window's totals", () => {
    const timeline = computeTimeline({
      events: [
        settledBill("power", "2026-11-20", -10_000n),
        autoBill("water", "2026-11-21", -4_000n),
      ],
      startBalanceCents: 40_000n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-19",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    // Only the water bill is still going out of this window.
    expect(periods[0]?.autoCents).toBe(4_000n);
  });

  it("is never named as the low point of a window", () => {
    const timeline = computeTimeline({
      events: [settledBill("power", "2026-11-20", -10_000n)],
      startBalanceCents: 40_000n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-19",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    /*
     * Without the guard the only row in the window takes the attribution by
     * being first, and the screen says the balance is where it is because of
     * a bill that was paid before the window opened.
     */
    expect(periods[0]?.lowest).toBeNull();
  });
});

describe("pay periods", () => {
  /**
   * The half of this that was a wrong FIGURE, not a wrong label.
   *
   * Window membership and the projected paydays are both decided by
   * `window.end`. Reported at its full fortnight, the last window counted
   * Alex's cheque on the 17th of December while the caller had fetched no row
   * dated after the 16th - income through the 23rd against bills through the
   * 16th, so the left-over figure was inflated from both directions.
   *
   * The two assertions here are the same setup with and without the horizon,
   * which is the clearest way to state what changed.
   */
  it("stops counting pay that arrives after the horizon it was cut at", () => {
    const timeline = computeTimeline({ events: [], startBalanceCents: 0n });
    const options = {
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-19",
      periodCount: 3,
      anchorScheduleId: "jordan",
    } as const;

    // Unclipped, the window runs to the 23rd and takes in Jordan's cheque on
    // the 10th AND Alex's on the 17th.
    const unclipped = computePayPeriods(options);
    expect(unclipped[2]?.end).toBe("2026-12-23");
    expect(unclipped[2]?.inCents).toBe(380_000n);

    // Cut at the 16th, it takes in only Jordan's.
    const clipped = computePayPeriods({ ...options, coverThrough: "2026-12-16" });
    expect(clipped[2]?.end).toBe("2026-12-16");
    expect(clipped[2]?.inCents).toBe(200_000n);
    expect(clipped[2]?.endsAtHorizon).toBe(true);
  });

  it("projects a cheque that is due in the window but not placed yet", () => {
    const timeline = computeTimeline({
      events: [paycheque("pay_jordan", "2026-11-26", 200_000n, "jordan")],
      startBalanceCents: 0n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-26",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    const period = periods[0];
    // Jordan's cheque is placed; Alex's Dec 3 one is projected from her schedule.
    expect(period?.inCents).toBe(200_000n + ALEX.defaultCents);
    expect(period?.projectedPaychequeIds).toEqual(["alex|2026-12-03"]);
  });

  it("does not double-count a cheque that is already placed", () => {
    const timeline = computeTimeline({
      events: [
        paycheque("pay_jordan", "2026-11-26", 200_000n, "jordan"),
        paycheque("pay_alex", "2026-12-03", 185_000n, "alex"),
      ],
      startBalanceCents: 0n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-26",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    // The placed amount is used, not the schedule's default.
    expect(periods[0]?.inCents).toBe(385_000n);
    expect(periods[0]?.projectedPaychequeIds).toEqual([]);
  });

  it("counts the current balance as what the partial window opens with", () => {
    const timeline = computeTimeline({
      events: [flexibleBill("power", null, -15_000n)],
      startBalanceCents: 41_000n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [JORDAN],
      today: "2026-11-07",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    expect(periods[0]?.isCurrentPartial).toBe(true);
    expect(periods[0]?.inCents).toBe(41_000n);
    expect(periods[0]?.flexibleCents).toBe(15_000n);
    expect(periods[0]?.leftCents).toBe(26_000n);
  });

  it("refuses to run with no pay schedule to anchor on", () => {
    const timeline = computeTimeline({ events: [], startBalanceCents: 0n });
    expect(() =>
      computePayPeriods({ timeline, paySchedules: [], today: "2026-11-07" }),
    ).toThrow(/at least one pay schedule/);
  });

  it("refuses an anchor schedule that does not exist", () => {
    const timeline = computeTimeline({ events: [], startBalanceCents: 0n });
    expect(() =>
      computePayPeriods({
        timeline,
        paySchedules: [JORDAN],
        today: "2026-11-07",
        anchorScheduleId: "nobody",
      }),
    ).toThrow(/No pay schedule with id/);
  });
});

describe("the horizon", () => {
  it("counts both people's upcoming cheques", () => {
    // Upcoming: Nov 12 (D), Nov 19 (C), Nov 26 (D), Dec 3 (C).
    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [JORDAN, ALEX], paychequeCount: 4 }),
    ).toBe("2026-12-02");

    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [JORDAN, ALEX], paychequeCount: 1 }),
    ).toBe("2026-11-11");

    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [JORDAN, ALEX], paychequeCount: 2 }),
    ).toBe("2026-11-18");
  });

  it("treats a cheque arriving today as already in the balance", () => {
    // On Nov 12 the next cheque is Alex's on Nov 19, not Jordan's today.
    expect(
      computeHorizonEnd({ today: "2026-11-12", paySchedules: [JORDAN, ALEX], paychequeCount: 1 }),
    ).toBe("2026-11-18");
  });

  it("is an editable setting, so a longer view works too", () => {
    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [JORDAN, ALEX], paychequeCount: 6 }),
    ).toBe("2026-12-16");
  });

  it("refuses a nonsensical count", () => {
    expect(() =>
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [JORDAN], paychequeCount: 0 }),
    ).toThrow(RangeError);
  });
});

describe("room to save", () => {
  // $500 in the account, a flexible bill not yet placed on a payday, then two
  // cheques and an automatic withdrawal.
  //
  // Running balances:
  //   flex     (anchored to "now")   38,000
  //   jordan   2026-11-12            238,000
  //   alex     2026-11-19            418,000
  //   auto     2026-11-22            388,000
  const timeline = computeTimeline({
    events: [
      flexibleBill("flex", null, -12_000n),
      paycheque("pay_jordan", "2026-11-12", 200_000n, "jordan"),
      paycheque("pay_alex", "2026-11-19", 180_000n, "alex"),
      autoBill("auto", "2026-11-22", -30_000n),
    ],
    startBalanceCents: 50_000n,
  });

  function periods(cushionCents = 0n) {
    return computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-07",
      periodCount: 2,
      anchorScheduleId: "jordan",
      cushionCents,
    });
  }

  it("is the floor of everything still ahead, not of the period alone", () => {
    // The lowest point in the current window is 38,000, after the flexible bill.
    expect(periods()[0]?.roomToSaveCents).toBe(38_000n);
  });

  it("agrees with safe-to-spend for the window that starts now", () => {
    // Both answer the same question - what can leave without breaking
    // something later - so they must never disagree.
    expect(periods()[0]?.roomToSaveCents).toBe(timeline.safeToSpendNowCents);
  });

  it("does not hold a later window to today's balance", () => {
    // By the time anyone acts in the Nov 12-25 window, Jordan's cheque has
    // landed, so the room is 238,000 and not the 38,000 available today.
    const [, second] = periods();

    expect(second?.start).toBe("2026-11-12");
    expect(second?.roomToSaveCents).toBe(238_000n);
  });

  it("is reduced by the cushion, one for one", () => {
    const [first, second] = periods(20_000n);

    expect(first?.roomToSaveCents).toBe(18_000n);
    expect(second?.roomToSaveCents).toBe(218_000n);
  });

  it("falls back to the balance carried in when nothing is left ahead", () => {
    const quiet = computeTimeline({
      events: [flexibleBill("flex", null, -12_000n)],
      startBalanceCents: 50_000n,
    });

    const [, second] = computePayPeriods({
      timeline: quiet,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-07",
      periodCount: 2,
      anchorScheduleId: "jordan",
    });

    // Nothing is scheduled in or after Nov 12-25, so the room is whatever the
    // account holds once the flexible bill has gone.
    expect(second?.roomToSaveCents).toBe(38_000n);
  });

  it("reports a shortfall rather than a room of zero", () => {
    const tight = computeTimeline({
      events: [autoBill("big_bill", "2026-11-13", -150_000n)],
      startBalanceCents: 50_000n,
    });

    const [first] = computePayPeriods({
      timeline: tight,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-07",
      periodCount: 1,
      anchorScheduleId: "jordan",
    });

    // Already short: the number says by how much instead of clamping to zero.
    expect(first?.roomToSaveCents).toBe(-100_000n);
  });
});

describe("every row lands in a window", () => {
  /**
   * The hole this closes: the timeline deliberately keeps a dated item that is
   * past and has not cleared, because the money has not moved yet. It has no
   * date inside any window, so it used to belong to no window - dropped from
   * the rows AND from the totals, while still lowering every running balance
   * and safe-to-spend. An overdue bill disappeared from the pay plan while
   * still making every figure on it smaller.
   */
  const events: TimelineInput[] = [
    autoBill("overdue", "2026-11-02", -7_500n), // before today, never cleared
    flexibleBill("undated", null, -4_000n), // anchored to "now"
    autoBill("soon", "2026-11-10", -2_500n), // inside the partial window
    paycheque("pay_jordan", "2026-11-12", 200_000n, "jordan"),
    autoBill("later", "2026-11-20", -9_000n), // inside the second window
  ];

  const timeline = computeTimeline({ events, startBalanceCents: 100_000n });

  const periods = computePayPeriods({
    timeline,
    paySchedules: [JORDAN, ALEX],
    // Not a payday, so there is a partial window from today to Nov 11.
    today: "2026-11-09",
    periodCount: 2,
    anchorScheduleId: "jordan",
  });

  it("accounts for every row exactly once", () => {
    const grouped = periods.flatMap((period) => period.rowIds);

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...events.map((event) => event.id)].sort());
  });

  it("puts an overdue bill and an undated one in the first window", () => {
    expect(periods[0]?.isCurrentPartial).toBe(true);
    // In the timeline's own order, which the ledger displays and the running
    // balance follows: a row anchored to "now" comes before dated ones.
    expect(periods[0]?.rowIds).toEqual(["undated", "overdue", "soon"]);
    expect(periods[1]?.rowIds).toEqual(["pay_jordan", "later"]);
  });

  it("counts them in that window's totals, not only in its list", () => {
    // 7,500 automatic (the overdue bill) + 2,500 automatic (Nov 10) = 10,000;
    // 4,000 flexible. Both were missing from these figures before.
    expect(periods[0]?.autoCents).toBe(10_000n);
    expect(periods[0]?.flexibleCents).toBe(4_000n);
    // The window opens with what is in the account, and nothing arrives in it.
    expect(periods[0]?.inCents).toBe(100_000n);
    expect(periods[0]?.leftCents).toBe(100_000n - 10_000n - 4_000n);
  });

  it("still accounts for everything when today is itself a payday", () => {
    // No partial window at all in this case, so "the first window" is a full
    // one - and it still has to absorb the overdue and undated rows.
    const onPayday = computePayPeriods({
      timeline,
      paySchedules: [JORDAN, ALEX],
      today: "2026-11-12",
      periodCount: 2,
      anchorScheduleId: "jordan",
    });

    expect(onPayday[0]?.isCurrentPartial).toBe(false);
    expect(onPayday[0]?.rowIds).toContain("overdue");
    expect(onPayday[0]?.rowIds).toContain("undated");
    expect(onPayday.flatMap((period) => period.rowIds)).toHaveLength(events.length);
  });
});

describe("the windows cover the horizon", () => {
  it("adds windows until one reaches the date it is told to cover", () => {
    const short = payPeriodWindows("2026-11-09", JORDAN, 3);
    const long = payPeriodWindows("2026-11-09", JORDAN, 3, "2027-02-01");

    // The partial window counts towards the minimum, so three means a partial
    // one plus two full ones - about four weeks, which is less reach than it
    // sounds and the reason `coverThrough` exists.
    expect(short).toHaveLength(3);
    expect(long.length).toBeGreaterThan(short.length);
    expect(long[long.length - 1]?.end >= "2027-02-01").toBe(true);
  });

  it("asks for no more than the minimum when that already reaches", () => {
    const windows = payPeriodWindows("2026-11-09", JORDAN, 3, "2026-11-20");

    expect(windows).toHaveLength(3);
  });

  it("will not run away on an absurd horizon", () => {
    expect(payPeriodWindows("2026-11-09", JORDAN, 3, "2400-01-01").length).toBeLessThanOrEqual(60);
  });

  it("keeps a row beyond the default three windows inside one", () => {
    // Without `coverThrough` this row lands in no window, and the household
    // can reach this state just by raising the horizon setting.
    const far = autoBill("far", "2027-01-20", -5_000n);
    const timeline = computeTimeline({
      events: [paycheque("pay_jordan", "2026-11-12", 200_000n, "jordan"), far],
      startBalanceCents: 50_000n,
    });

    const covered = computePayPeriods({
      timeline,
      paySchedules: [JORDAN],
      today: "2026-11-09",
      periodCount: 3,
      coverThrough: "2027-01-20",
      anchorScheduleId: "jordan",
    });

    expect(covered.flatMap((period) => period.rowIds)).toContain("far");
  });
});

describe("explaining a figure", () => {
  /*
   * The working behind the headline numbers, for the info button.
   *
   * The reason this is in the engine and not written out in the UI: an
   * explanation that can disagree with the figure it explains is worse than no
   * explanation. Both come off the same rows.
   */
  const pay = (id: string, date: string, cents: bigint) => ({
    id,
    name: "Pay",
    cents,
    kind: "paycheque" as const,
    placement: "auto" as const,
    date,
  });

  const bill = (id: string, name: string, date: string, cents: bigint) => ({
    id,
    name,
    cents,
    kind: "bill" as const,
    placement: "auto" as const,
    date,
  });

  it("splits the horizon into what comes in and what goes out", () => {
    const result = computeTimeline({
      events: [
        pay("p1", "2026-11-16", 210_000n),
        bill("b1", "Rent", "2026-11-17", -90_000n),
        bill("b2", "Power", "2026-11-20", -14_700n),
      ],
      startBalanceCents: 200_000n,
    });

    const working = summariseTimeline(result);

    expect(working.startBalanceCents).toBe(200_000n);
    expect(working.inCents).toBe(210_000n);
    expect(working.inCount).toBe(1);
    // A magnitude, because "less $1,047.00 going out" reads better than a
    // double negative.
    expect(working.outCents).toBe(104_700n);
    expect(working.outCount).toBe(2);

    // And it adds up to the figure the headline shows.
    expect(working.endCents).toBe(result.leftThisCycleCents);
    expect(working.endCents).toBe(305_300n);
  });

  it("names the row the balance is lowest after", () => {
    const result = computeTimeline({
      events: [
        bill("b1", "Rent", "2026-11-17", -90_000n),
        pay("p1", "2026-11-20", 210_000n),
      ],
      startBalanceCents: 200_000n,
    });

    // The dip is after the rent, before the pay arrives.
    expect(summariseTimeline(result).lowestAfterName).toBe("Rent");
    expect(result.lowest.cents).toBe(110_000n);
  });

  it("says the lowest point is the opening balance when nothing dips below it", () => {
    /*
     * The case that confuses people, and the reason the button is wanted:
     * "safe to spend" equals the whole balance because the pay arrives before
     * anything goes out, so the balance never falls below where it starts.
     * There is no row to blame, and the explanation has to say so.
     */
    const result = computeTimeline({
      events: [
        pay("p1", "2026-11-16", 210_000n),
        bill("b1", "Rent", "2026-11-17", -90_000n),
      ],
      startBalanceCents: 200_000n,
    });

    expect(result.lowest.cents).toBe(200_000n);
    expect(summariseTimeline(result).lowestAfterName).toBeNull();
  });

  it("holds up with nothing on the ledger at all", () => {
    const result = computeTimeline({ events: [], startBalanceCents: 200_000n });
    const working = summariseTimeline(result);

    expect(working).toEqual({
      startBalanceCents: 200_000n,
      inCents: 0n,
      inCount: 0,
      outCents: 0n,
      outCount: 0,
      endCents: 200_000n,
      lowestAfterName: null,
    });
  });
});

describe("money that moves between accounts", () => {
  /*
   * A credit card charge is not a chequing withdrawal, and never was. The
   * household pays the card from chequing, in amounts and on days of their
   * own choosing, so the chequing outflow is the payment - not the charge.
   *
   * Projecting it the old way meant the chequing forecast fell on the day the
   * card was charged, for money that stayed in the account, and then had
   * nowhere to put the real payment when it came out.
   */
  const CHEQUING = "account-chequing";
  const VISA = "account-visa";
  const SAVINGS = "account-savings";

  /** A charge on a card: leaves the card, arrives nowhere, money is spent. */
  function charge(id: string, date: string, cents: bigint, from: string): TimelineInput {
    return { ...autoBill(id, date, cents), fromAccountId: from };
  }

  /** A payment toward a card: leaves one account and arrives in another. */
  function transfer(
    id: string,
    date: string,
    cents: bigint,
    from: string,
    to: string,
  ): TimelineInput {
    return {
      id,
      name: id,
      cents,
      kind: "bill",
      placement: "flexible",
      date,
      fromAccountId: from,
      toAccountId: to,
    };
  }

  /**
   * One cycle: two charges on the card, one payment toward it, one ordinary
   * chequing bill. Every figure below is derived from this single list, run
   * once per account.
   */
  const events: readonly TimelineInput[] = [
    charge("rogers", "2026-11-24", -9_500n, VISA),
    charge("netflix", "2026-11-25", -2_000n, VISA),
    transfer("visa-payment", "2026-11-28", -40_000n, CHEQUING, VISA),
    { ...autoBill("power", "2026-12-01", -14_000n), fromAccountId: CHEQUING },
  ];

  const chequing = computeTimeline({
    events,
    startBalanceCents: 240_000n,
    accountId: CHEQUING,
  });

  // A card is projected as an ordinary signed balance where debt is negative,
  // so owing $842.00 opens at -84_200. The flip to "owed" is for display only.
  const visa = computeTimeline({
    events,
    startBalanceCents: -84_200n,
    accountId: VISA,
  });

  describe("accountDelta", () => {
    it("takes the money out of the source account", () => {
      expect(accountDelta({ cents: -9_500n, fromAccountId: VISA }, VISA)).toBe(-9_500n);
    });

    it("leaves every other account alone", () => {
      expect(accountDelta({ cents: -9_500n, fromAccountId: VISA }, CHEQUING)).toBe(0n);
      expect(accountDelta({ cents: -9_500n, fromAccountId: VISA }, SAVINGS)).toBe(0n);
    });

    it("moves a transfer out of one account and into the other", () => {
      const payment = { cents: -40_000n, fromAccountId: CHEQUING, toAccountId: VISA };

      expect(accountDelta(payment, CHEQUING)).toBe(-40_000n);
      // The card's balance rises by the same amount: less debt.
      expect(accountDelta(payment, VISA)).toBe(40_000n);
      expect(accountDelta(payment, SAVINGS)).toBe(0n);
    });

    it("brings money the other way when savings pays chequing", () => {
      const move = { cents: -50_000n, fromAccountId: SAVINGS, toAccountId: CHEQUING };

      expect(accountDelta(move, SAVINGS)).toBe(-50_000n);
      expect(accountDelta(move, CHEQUING)).toBe(50_000n);
    });

    it("does not read a missing destination as the account being projected", () => {
      /*
       * The trap this guards. Both "no destination" and "the only account"
       * are null, so an unguarded `to === accountId` would credit every
       * ordinary bill back into the account it had just left, and the balance
       * would never move at all.
       */
      expect(accountDelta({ cents: -9_500n }, null)).toBe(-9_500n);
      expect(accountDelta({ cents: -9_500n, fromAccountId: VISA }, null)).toBe(0n);
    });

    it("nets a transfer into the account it came from to nothing", () => {
      expect(
        accountDelta({ cents: -40_000n, fromAccountId: VISA, toAccountId: VISA }, VISA),
      ).toBe(0n);
    });
  });

  describe("a charge on a card", () => {
    it("stays on the ledger, and chequing carries straight past it", () => {
      expect(chequing.rows.map((row) => row.event.id)).toEqual([
        "rogers",
        "netflix",
        "visa-payment",
        "power",
      ]);

      // Two charges, and the chequing balance is exactly where it started.
      expect(chequing.rows[0]?.runningCents).toBe(240_000n);
      expect(chequing.rows[1]?.runningCents).toBe(240_000n);
      expect(chequing.rows[0]?.deltaCents).toBe(0n);
      expect(chequing.rows[1]?.deltaCents).toBe(0n);
    });

    it("does not ask chequing to cover it", () => {
      // Only the power bill is an automatic withdrawal out of chequing. The
      // charges are automatic too, but not out of this account.
      expect(chequing.coverage.autoWithdrawalCount).toBe(1);
      expect(chequing.coverage.allCovered).toBe(true);
    });

    it("is not counted among chequing's estimates", () => {
      // The payment and the power bill; not the two charges.
      expect(chequing.estimatesCount).toBe(2);
    });

    it("is counted among the estimates of the card that carries it", () => {
      // Every row that moves the card: both charges, and the payment, whose
      // amount is equally unconfirmed. Nothing an account has to answer for
      // goes uncounted by every account, which was the thing to avoid.
      expect(visa.estimatesCount).toBe(3);
    });

    it("does not lower the chequing low point for money that stayed put", () => {
      expect(chequing.lowest.cents).toBe(186_000n);
      expect(chequing.lowest.afterEventId).toBe("power");
      expect(chequing.safeToSpendNowCents).toBe(186_000n);
    });
  });

  describe("a payment toward a card", () => {
    it("comes out of chequing on the day it is paid", () => {
      const row = chequing.rows.find((entry) => entry.event.id === "visa-payment");

      expect(row?.deltaCents).toBe(-40_000n);
      expect(row?.runningCents).toBe(200_000n);
    });

    it("comes off the card by the same amount, from the same row", () => {
      const row = visa.rows.find((entry) => entry.event.id === "visa-payment");

      expect(row?.deltaCents).toBe(40_000n);
    });

    it("is not an automatic withdrawal, so it can be moved when money is tight", () => {
      const row = chequing.rows.find((entry) => entry.event.id === "visa-payment");

      expect(row?.requiresCoverage).toBe(false);
    });
  });

  describe("the card, projected on its own", () => {
    it("owes more as charges land and less when a payment is made", () => {
      const owed = (id: string): bigint => {
        const row = visa.rows.find((entry) => entry.event.id === id);
        if (!row) throw new Error(`no row ${id}`);
        // Negative balance, read back as a positive debt.
        return -row.runningCents;
      };

      expect(owed("rogers")).toBe(93_700n);
      expect(owed("netflix")).toBe(95_700n);
      expect(owed("visa-payment")).toBe(55_700n);
      // The chequing bill is nothing to do with the card.
      expect(owed("power")).toBe(55_700n);
    });

    it("ends the horizon still owing something, which is the warning's job", () => {
      expect(-visa.leftThisCycleCents).toBe(55_700n);
    });

    it("reaches its deepest debt at the last charge before a payment", () => {
      // `lowest` on a card is the most it ever owes, for free.
      expect(-visa.lowest.cents).toBe(95_700n);
      expect(visa.lowest.afterEventId).toBe("netflix");
    });
  });

  describe("explaining a figure", () => {
    it("adds up to the balance the ledger actually ends on", () => {
      const breakdown = summariseTimeline(chequing);

      // The payment and the power bill. The charges are not chequing's money
      // going out, so an explanation that counted them would not reconcile.
      expect(breakdown.outCents).toBe(54_000n);
      expect(breakdown.outCount).toBe(2);
      expect(breakdown.endCents).toBe(chequing.leftThisCycleCents);
    });
  });

  describe("a pay period's totals", () => {
    const periods = computePayPeriods({
      timeline: chequing,
      paySchedules: [JORDAN],
      today: "2026-11-20",
      periodCount: 2,
      anchorScheduleId: JORDAN.id,
    });

    it("shows the charges in the window they fall in", () => {
      expect(periods[0]?.rowIds).toEqual(["rogers", "netflix"]);
    });

    it("takes nothing out of chequing for a fortnight of card charges", () => {
      expect(periods[0]?.autoCents).toBe(0n);
      expect(periods[0]?.flexibleCents).toBe(0n);
      expect(periods[0]?.leftCents).toBe(240_000n);
    });

    it("still says how much went on the cards, so the window adds up", () => {
      // A fortnight reporting nothing going out, with two charges on screen,
      // would read as broken rather than as accurate.
      expect(periods[0]?.elsewhereCents).toBe(11_500n);
      expect(periods[1]?.elsewhereCents).toBe(0n);
    });

    it("has no low point of its own when nothing in it moved", () => {
      expect(periods[0]?.lowest).toBeNull();
    });

    it("counts the payment in the window it is paid from", () => {
      expect(periods[1]?.rowIds).toEqual(["visa-payment", "power"]);
      expect(periods[1]?.flexibleCents).toBe(40_000n);
      expect(periods[1]?.autoCents).toBe(14_000n);
    });
  });

  describe("naming an account to project", () => {
    it("refuses a row that does not say where its money comes from", () => {
      expect(() =>
        computeTimeline({
          events: [autoBill("power", "2026-12-01", -14_000n)],
          startBalanceCents: 240_000n,
          accountId: CHEQUING,
        }),
      ).toThrow(/no source account/);
    });

    it("still runs the single-account way when no account is named", () => {
      const result = computeTimeline({
        events: [autoBill("power", "2026-12-01", -14_000n)],
        startBalanceCents: 240_000n,
      });

      expect(result.leftThisCycleCents).toBe(226_000n);
    });
  });
});
