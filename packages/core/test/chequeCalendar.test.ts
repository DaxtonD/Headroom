/**
 * The year view: which months are unusual, and by how much.
 *
 * Every date and amount here is invented. The synthetic pay anchor is
 * 2026-01-08 and the mortgage follows it by one day, which produces all three
 * interesting cases inside 2026:
 *
 *   Apr 2026  three paycheques, two mortgage payments  - a windfall
 *   May 2026  two paycheques, three mortgage payments  - a squeeze
 *   Oct 2026  three of each
 *
 * That May sitting immediately after that April is the whole point of the
 * module. It is caused by nothing but a one-day offset, and no one would guess
 * it from a calendar.
 */
import { describe, expect, it } from "vitest";
import {
  USUAL_MONTHLY_COUNT,
  computeChequeCalendar,
  mortgageSeriesFromPaySchedule,
  unusualMonths,
} from "../src/chequeCalendar.js";
import type { BiweeklySeries } from "../src/chequeCalendar.js";

const PAY_ANCHOR = "2026-01-08";

const PAY: BiweeklySeries = {
  id: "pay",
  name: "Pay",
  anchorDate: PAY_ANCHOR,
  cents: 200_000n,
};

const MORTGAGE = mortgageSeriesFromPaySchedule({
  id: "mortgage",
  name: "Mortgage",
  payAnchorDate: PAY_ANCHOR,
  offsetDays: 1,
  paymentCents: 100_000n,
});

const months = computeChequeCalendar({
  from: "2026-01-15",
  monthCount: 12,
  series: [PAY, MORTGAGE],
});

function month(label: string) {
  const found = months.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`No month labelled ${label} in the calendar.`);
  return found;
}

function entry(label: string, id: string) {
  const found = month(label).entries.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No series ${id} in ${label}.`);
  return found;
}

describe("the shape of the calendar", () => {
  it("starts with the month containing the given date", () => {
    expect(months).toHaveLength(12);
    expect(months[0]!.label).toBe("Jan 2026");
    expect(months[11]!.label).toBe("Dec 2026");
  });

  it("counts whole months, not the remainder of the first one", () => {
    // Asked on 2026-01-15, which is after the Jan 8 payday. "Does January
    // hold three paydays" is a question about January, not about what is left
    // of it, so the earlier payday still counts.
    expect(month("Jan 2026").start).toBe("2026-01-01");
    expect(month("Jan 2026").end).toBe("2026-01-31");
    expect(entry("Jan 2026", "pay").dates).toContain("2026-01-08");
  });

  it("ends each month on its real last day", () => {
    expect(month("Feb 2026").end).toBe("2026-02-28");
    expect(month("Apr 2026").end).toBe("2026-04-30");
  });
});

describe("a normal month", () => {
  it("holds two of everything and is not flagged", () => {
    const march = month("Mar 2026");

    expect(USUAL_MONTHLY_COUNT).toBe(2);
    expect(entry("Mar 2026", "pay").count).toBe(2);
    expect(entry("Mar 2026", "mortgage").count).toBe(2);
    expect(march.netExtraCents).toBe(0n);
    expect(march.isUnusual).toBe(false);
  });
});

describe("the month with a third paycheque", () => {
  it("is worth one extra cheque and nothing else", () => {
    expect(entry("Apr 2026", "pay").count).toBe(3);
    expect(entry("Apr 2026", "pay").extraCount).toBe(1);
    expect(entry("Apr 2026", "pay").extraCents).toBe(200_000n);

    // The offset keeps the third mortgage payment out of April.
    expect(entry("Apr 2026", "mortgage").count).toBe(2);
    expect(entry("Apr 2026", "mortgage").extraCents).toBe(0n);

    expect(month("Apr 2026").netExtraCents).toBe(200_000n);
    expect(month("Apr 2026").isUnusual).toBe(true);
  });
});

describe("the month with a third mortgage payment", () => {
  it("is a squeeze, and it is the month right after the windfall", () => {
    expect(entry("May 2026", "pay").count).toBe(2);
    expect(entry("May 2026", "mortgage").count).toBe(3);
    expect(entry("May 2026", "mortgage").extraCents).toBe(-100_000n);

    expect(month("May 2026").netExtraCents).toBe(-100_000n);
    expect(month("May 2026").isUnusual).toBe(true);

    // The pair is the finding: a good month immediately followed by a bad one.
    const april = months.findIndex((candidate) => candidate.label === "Apr 2026");
    expect(months[april + 1]!.label).toBe("May 2026");
    expect(months[april]!.netExtraCents).toBeGreaterThan(0n);
    expect(months[april + 1]!.netExtraCents).toBeLessThan(0n);
  });
});

describe("the month with three of each", () => {
  it("nets the extra cheque against the extra payment", () => {
    expect(entry("Oct 2026", "pay").count).toBe(3);
    expect(entry("Oct 2026", "mortgage").count).toBe(3);
    expect(month("Oct 2026").netExtraCents).toBe(100_000n);
    expect(month("Oct 2026").isUnusual).toBe(true);
  });
});

describe("the summary strip", () => {
  it("keeps only the months worth looking at", () => {
    const unusual = unusualMonths(months);

    expect(unusual.map((candidate) => candidate.label)).toEqual([
      "Apr 2026",
      "May 2026",
      "Oct 2026",
    ]);
  });
});

describe("deriving the mortgage series", () => {
  it("shifts the anchor by the offset", () => {
    expect(MORTGAGE.anchorDate).toBe("2026-01-09");
  });

  it("negates the payment, because it leaves the account", () => {
    expect(MORTGAGE.cents).toBe(-100_000n);
  });

  it("refuses a payment passed as a negative", () => {
    expect(() =>
      mortgageSeriesFromPaySchedule({
        id: "mortgage",
        name: "Mortgage",
        payAnchorDate: PAY_ANCHOR,
        offsetDays: 1,
        paymentCents: -100_000n,
      }),
    ).toThrow(/positive magnitude/);
  });

  it("handles an offset that crosses a month boundary", () => {
    // Offset 0 puts the mortgage on the payday itself, so the two series move
    // together and no month can disagree about them.
    const together = computeChequeCalendar({
      from: "2026-01-01",
      monthCount: 12,
      series: [
        PAY,
        mortgageSeriesFromPaySchedule({
          id: "same-day",
          name: "Mortgage",
          payAnchorDate: PAY_ANCHOR,
          offsetDays: 0,
          paymentCents: 100_000n,
        }),
      ],
    });

    for (const candidate of together) {
      const counts = candidate.entries.map((series) => series.count);
      expect(new Set(counts).size).toBe(1);
    }
  });
});

describe("inputs the calendar refuses", () => {
  it("needs at least one month", () => {
    expect(() => computeChequeCalendar({ from: "2026-01-01", monthCount: 0, series: [PAY] })).toThrow(
      /positive whole number/,
    );
  });

  it("copes with no series at all", () => {
    const empty = computeChequeCalendar({ from: "2026-01-01", monthCount: 2, series: [] });

    expect(empty).toHaveLength(2);
    expect(empty[0]!.isUnusual).toBe(false);
    expect(empty[0]!.netExtraCents).toBe(0n);
  });
});
