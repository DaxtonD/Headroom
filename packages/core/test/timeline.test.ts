/**
 * Timeline and pay-period behaviour the golden fixture does not reach:
 * an empty account, a non-zero cushion, ordering tie-breaks, clearing, and the
 * inputs the engine should refuse outright.
 *
 * Every amount here is invented.
 */
import { describe, expect, it } from "vitest";
import { computeHorizonEnd, computePayPeriods, payPeriodWindows } from "../src/payPeriods.js";
import { computeTimeline, effectiveBalance, orderTimeline } from "../src/timeline.js";
import type { PaySchedule, TimelineInput } from "../src/types.js";

const DAX: PaySchedule = {
  id: "dax",
  ownerId: "dax",
  anchorDate: "2026-11-12",
  defaultCents: 200_000n,
};
const CAROL: PaySchedule = {
  id: "carol",
  ownerId: "carol",
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

  it("shows a settled item without counting it", () => {
    /*
     * The money left before the balance at the top was typed in, so the
     * balance already knows about it. Counting it here as well would subtract
     * the same bill twice - which is exactly what marking a bill paid used to
     * do, leaving the household short by its amount with nothing to say why.
     *
     * It still has to appear: a ledger that hides what has been paid is no use
     * to the person reading it.
     */
    const result = computeTimeline({
      events: [
        {
          id: "power",
          name: "Power",
          cents: -18_600n,
          kind: "bill",
          placement: "auto",
          date: "2026-11-10",
          settled: true,
        },
        {
          id: "water",
          name: "Water",
          cents: -14_400n,
          kind: "bill",
          placement: "auto",
          date: "2026-11-18",
        },
      ],
      startBalanceCents: 100_000n,
    });

    // Both rows, in order.
    expect(result.rows.map((row) => row.event.id)).toEqual(["power", "water"]);

    // The settled one carries the balance past it unchanged.
    expect(result.rows[0]?.runningCents).toBe(100_000n);
    expect(result.rows[1]?.runningCents).toBe(85_600n);
    expect(result.leftThisCycleCents).toBe(85_600n);
    expect(result.lowest.cents).toBe(85_600n);

    // And it is not something to be covered: it has already come out.
    expect(result.rows[0]?.requiresCoverage).toBe(false);
    expect(result.coverage.autoWithdrawalCount).toBe(1);
  });

  it("does not count a settled bill as an estimate", () => {
    // It has been paid. Asking anyone to go and confirm the amount of it would
    // be asking about something that is over.
    const result = computeTimeline({
      events: [
        {
          id: "power",
          name: "Power",
          cents: -18_600n,
          kind: "bill",
          placement: "auto",
          date: "2026-11-10",
          settled: true,
        },
      ],
      startBalanceCents: 100_000n,
    });

    expect(result.estimatesCount).toBe(0);
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
    const windows = payPeriodWindows("2026-11-07", DAX, 3);

    expect(windows[0]).toEqual({ start: "2026-11-07", end: "2026-11-11", isCurrentPartial: true });
    expect(windows[1]).toEqual({ start: "2026-11-12", end: "2026-11-25", isCurrentPartial: false });
    expect(windows[2]).toEqual({ start: "2026-11-26", end: "2026-12-09", isCurrentPartial: false });
  });

  it("has no partial window when today IS a payday", () => {
    const windows = payPeriodWindows("2026-11-12", DAX, 2);

    expect(windows[0]).toEqual({ start: "2026-11-12", end: "2026-11-25", isCurrentPartial: false });
    expect(windows[1]).toEqual({ start: "2026-11-26", end: "2026-12-09", isCurrentPartial: false });
  });

  it("keeps every full window exactly fourteen days", () => {
    for (const window of payPeriodWindows("2026-11-07", DAX, 6)) {
      if (window.isCurrentPartial) continue;
      expect(new Date(window.end).getTime() - new Date(window.start).getTime()).toBe(13 * 86_400_000);
    }
  });
});

describe("pay periods", () => {
  it("projects a cheque that is due in the window but not placed yet", () => {
    const timeline = computeTimeline({
      events: [paycheque("pay_dax", "2026-11-26", 200_000n, "dax")],
      startBalanceCents: 0n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [DAX, CAROL],
      today: "2026-11-26",
      periodCount: 1,
      anchorScheduleId: "dax",
    });

    const period = periods[0];
    // Dax's cheque is placed; Carol's Dec 3 one is projected from her schedule.
    expect(period?.inCents).toBe(200_000n + CAROL.defaultCents);
    expect(period?.projectedPaychequeIds).toEqual(["carol|2026-12-03"]);
  });

  it("does not double-count a cheque that is already placed", () => {
    const timeline = computeTimeline({
      events: [
        paycheque("pay_dax", "2026-11-26", 200_000n, "dax"),
        paycheque("pay_carol", "2026-12-03", 185_000n, "carol"),
      ],
      startBalanceCents: 0n,
    });

    const periods = computePayPeriods({
      timeline,
      paySchedules: [DAX, CAROL],
      today: "2026-11-26",
      periodCount: 1,
      anchorScheduleId: "dax",
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
      paySchedules: [DAX],
      today: "2026-11-07",
      periodCount: 1,
      anchorScheduleId: "dax",
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
        paySchedules: [DAX],
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
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [DAX, CAROL], paychequeCount: 4 }),
    ).toBe("2026-12-02");

    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [DAX, CAROL], paychequeCount: 1 }),
    ).toBe("2026-11-11");

    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [DAX, CAROL], paychequeCount: 2 }),
    ).toBe("2026-11-18");
  });

  it("treats a cheque arriving today as already in the balance", () => {
    // On Nov 12 the next cheque is Carol's on Nov 19, not Dax's today.
    expect(
      computeHorizonEnd({ today: "2026-11-12", paySchedules: [DAX, CAROL], paychequeCount: 1 }),
    ).toBe("2026-11-18");
  });

  it("is an editable setting, so a longer view works too", () => {
    expect(
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [DAX, CAROL], paychequeCount: 6 }),
    ).toBe("2026-12-16");
  });

  it("refuses a nonsensical count", () => {
    expect(() =>
      computeHorizonEnd({ today: "2026-11-07", paySchedules: [DAX], paychequeCount: 0 }),
    ).toThrow(RangeError);
  });
});

describe("room to save", () => {
  // $500 in the account, a flexible bill not yet placed on a payday, then two
  // cheques and an automatic withdrawal.
  //
  // Running balances:
  //   flex    (anchored to "now")   38,000
  //   dax     2026-11-12           238,000
  //   carol   2026-11-19           418,000
  //   auto    2026-11-22           388,000
  const timeline = computeTimeline({
    events: [
      flexibleBill("flex", null, -12_000n),
      paycheque("pay_dax", "2026-11-12", 200_000n, "dax"),
      paycheque("pay_carol", "2026-11-19", 180_000n, "carol"),
      autoBill("auto", "2026-11-22", -30_000n),
    ],
    startBalanceCents: 50_000n,
  });

  function periods(cushionCents = 0n) {
    return computePayPeriods({
      timeline,
      paySchedules: [DAX, CAROL],
      today: "2026-11-07",
      periodCount: 2,
      anchorScheduleId: "dax",
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
    // By the time anyone acts in the Nov 12-25 window, Dax's cheque has
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
      paySchedules: [DAX, CAROL],
      today: "2026-11-07",
      periodCount: 2,
      anchorScheduleId: "dax",
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
      paySchedules: [DAX, CAROL],
      today: "2026-11-07",
      periodCount: 1,
      anchorScheduleId: "dax",
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
    paycheque("pay_dax", "2026-11-12", 200_000n, "dax"),
    autoBill("later", "2026-11-20", -9_000n), // inside the second window
  ];

  const timeline = computeTimeline({ events, startBalanceCents: 100_000n });

  const periods = computePayPeriods({
    timeline,
    paySchedules: [DAX, CAROL],
    // Not a payday, so there is a partial window from today to Nov 11.
    today: "2026-11-09",
    periodCount: 2,
    anchorScheduleId: "dax",
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
    expect(periods[1]?.rowIds).toEqual(["pay_dax", "later"]);
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
      paySchedules: [DAX, CAROL],
      today: "2026-11-12",
      periodCount: 2,
      anchorScheduleId: "dax",
    });

    expect(onPayday[0]?.isCurrentPartial).toBe(false);
    expect(onPayday[0]?.rowIds).toContain("overdue");
    expect(onPayday[0]?.rowIds).toContain("undated");
    expect(onPayday.flatMap((period) => period.rowIds)).toHaveLength(events.length);
  });
});

describe("the windows cover the horizon", () => {
  it("adds windows until one reaches the date it is told to cover", () => {
    const short = payPeriodWindows("2026-11-09", DAX, 3);
    const long = payPeriodWindows("2026-11-09", DAX, 3, "2027-02-01");

    // The partial window counts towards the minimum, so three means a partial
    // one plus two full ones - about four weeks, which is less reach than it
    // sounds and the reason `coverThrough` exists.
    expect(short).toHaveLength(3);
    expect(long.length).toBeGreaterThan(short.length);
    expect(long[long.length - 1]?.end >= "2027-02-01").toBe(true);
  });

  it("asks for no more than the minimum when that already reaches", () => {
    const windows = payPeriodWindows("2026-11-09", DAX, 3, "2026-11-20");

    expect(windows).toHaveLength(3);
  });

  it("will not run away on an absurd horizon", () => {
    expect(payPeriodWindows("2026-11-09", DAX, 3, "2400-01-01").length).toBeLessThanOrEqual(60);
  });

  it("keeps a row beyond the default three windows inside one", () => {
    // Without `coverThrough` this row lands in no window, and the household
    // can reach this state just by raising the horizon setting.
    const far = autoBill("far", "2027-01-20", -5_000n);
    const timeline = computeTimeline({
      events: [paycheque("pay_dax", "2026-11-12", 200_000n, "dax"), far],
      startBalanceCents: 50_000n,
    });

    const covered = computePayPeriods({
      timeline,
      paySchedules: [DAX],
      today: "2026-11-09",
      periodCount: 3,
      coverThrough: "2027-01-20",
      anchorScheduleId: "dax",
    });

    expect(covered.flatMap((period) => period.rowIds)).toContain("far");
  });
});
