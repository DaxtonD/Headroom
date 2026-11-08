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

  it("refuses a flexible item that carries a date", () => {
    expect(() =>
      computeTimeline({
        events: [
          {
            id: "x",
            name: "Power",
            cents: -1n,
            kind: "bill",
            placement: "flexible",
            date: "2026-11-12",
          },
        ],
        startBalanceCents: 0n,
      }),
    ).toThrow(/carries a date/);
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
