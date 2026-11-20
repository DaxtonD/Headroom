/**
 * The four things the Year screen says beyond the cheque calendar.
 *
 * Every amount in here is invented. The real seed is git-ignored and never
 * quoted; the golden tests are where real figures are checked.
 */
import { describe, expect, it } from "vitest";
import {
  computeYearAhead,
  isIrregular,
  lowestMonth,
  pairUnusualMonths,
  setAsideFor,
  type Lump,
  type ProjectedMove,
  type UnusualMonth,
} from "../src/yearAhead.js";
import type { PlainDate } from "../src/dates.js";
import type { Cadence } from "../src/monthlyEquivalent.js";

/** A move out of the account. */
function out(date: PlainDate, name: string, dollars: number) {
  return { date, name, deltaCents: BigInt(-dollars * 100) } satisfies ProjectedMove;
}

/** A move into it. */
function into(date: PlainDate, name: string, dollars: number) {
  return { date, name, deltaCents: BigInt(dollars * 100) } satisfies ProjectedMove;
}

/** One irregular bill, as the templates report it. */
function lump(date: PlainDate, name: string, dollars: number, cadence: Cadence = "yearly"): Lump {
  return { date, name, cents: BigInt(dollars * 100), cadence };
}

/* -------------------------------------------------------------------------- */
/* Which cadences skip months                                                 */
/* -------------------------------------------------------------------------- */

describe("isIrregular", () => {
  it("is the two cadences that skip months", () => {
    expect(isIrregular("yearly")).toBe(true);
    expect(isIrregular("quarterly")).toBe(true);
  });

  /**
   * Biweekly lands three times in some months, which is a real oddity and
   * somebody else's job: `chequeCalendar.ts` answers that, and answering it
   * twice in two different shapes is how two screens start disagreeing.
   */
  it("is not the ones that turn up every month, biweekly included", () => {
    expect(isIrregular("monthly")).toBe(false);
    expect(isIrregular("semi_monthly")).toBe(false);
    expect(isIrregular("weekly")).toBe(false);
    expect(isIrregular("biweekly")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Month by month                                                             */
/* -------------------------------------------------------------------------- */

describe("computeYearAhead", () => {
  it("starts with the month `from` is in and runs forward", () => {
    const months = computeYearAhead({
      from: "2026-11-20",
      monthCount: 3,
      startBalanceCents: 0n,
      moves: [],
    });

    expect(months.map((month) => month.label)).toEqual(["Nov 2026", "Dec 2026", "Jan 2027"]);
    expect(months.map((month) => month.start)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(months.map((month) => month.end)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"]);
  });

  it("knows how long February is, leap year or not", () => {
    const [feb2027] = computeYearAhead({
      from: "2027-02-10",
      monthCount: 1,
      startBalanceCents: 0n,
      moves: [],
    });
    const [feb2028] = computeYearAhead({
      from: "2028-02-10",
      monthCount: 1,
      startBalanceCents: 0n,
      moves: [],
    });

    expect(feb2027?.end).toBe("2027-02-28");
    expect(feb2028?.end).toBe("2028-02-29");
  });

  it("carries the balance from one month into the next", () => {
    const months = computeYearAhead({
      from: "2026-11-20",
      monthCount: 3,
      startBalanceCents: 100_000n,
      moves: [
        into("2026-11-27", "Pay", 2000),
        out("2026-11-28", "Rent", 1500),
        out("2026-12-05", "Rent", 1500),
        into("2027-01-08", "Pay", 2000),
      ],
    });

    // 1000 + 2000 - 1500
    expect(months[0]?.endBalanceCents).toBe(150_000n);
    expect(months[0]?.inCents).toBe(200_000n);
    expect(months[0]?.outCents).toBe(150_000n);
    // No income in December, so it falls by the rent.
    expect(months[1]?.endBalanceCents).toBe(0n);
    expect(months[2]?.endBalanceCents).toBe(200_000n);
  });

  /**
   * The one thing a monthly projection can do that a fortnight of ledger
   * cannot: say that the account goes under at all.
   */
  it("lets the balance go negative rather than clamping it", () => {
    const months = computeYearAhead({
      from: "2026-11-20",
      monthCount: 2,
      startBalanceCents: 10_000n,
      moves: [out("2026-12-05", "Insurance", 400)],
    });

    expect(months[1]?.endBalanceCents).toBe(-30_000n);
    expect(lowestMonth(months)?.label).toBe("Dec 2026");
  });

  it("has no lowest month when there are no months", () => {
    expect(lowestMonth([])).toBe(null);
  });

  /** A move outside the window belongs to no month and moves nothing. */
  it("ignores anything past the end of the window", () => {
    const months = computeYearAhead({
      from: "2026-11-20",
      monthCount: 2,
      startBalanceCents: 0n,
      moves: [out("2027-06-01", "Later", 500)],
    });

    expect(months.at(-1)?.endBalanceCents).toBe(0n);
  });

  it("refuses a month count that is not a positive whole number", () => {
    for (const monthCount of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        computeYearAhead({ from: "2026-11-20", monthCount, startBalanceCents: 0n, moves: [] }),
      ).toThrow(RangeError);
    }
  });

  describe("the bills that skip months", () => {
    it("files each one in its own month and totals it", () => {
      const months = computeYearAhead({
        from: "2027-03-01",
        monthCount: 2,
        startBalanceCents: 0n,
        moves: [],
        lumps: [
          lump("2027-03-04", "House insurance", 1450),
          lump("2027-03-15", "Water", 180, "quarterly"),
          lump("2027-04-02", "Car registration", 220),
        ],
      });

      expect(months[0]?.lumps.map((entry) => entry.name)).toEqual(["House insurance", "Water"]);
      expect(months[0]?.lumpTotalCents).toBe(163_000n);
      expect(months[1]?.lumpTotalCents).toBe(22_000n);
    });

    /**
     * The balance is projected from `moves` alone. A lump is a label on money
     * that is already in there once, from whichever source covers its date -
     * counting it again would take every yearly bill out of the account
     * twice.
     */
    it("never moves the balance by itself", () => {
      const months = computeYearAhead({
        from: "2027-03-01",
        monthCount: 1,
        startBalanceCents: 500_000n,
        moves: [out("2027-03-04", "House insurance", 1450)],
        lumps: [lump("2027-03-04", "House insurance", 1450)],
      });

      expect(months[0]?.endBalanceCents).toBe(355_000n);
      expect(months[0]?.outCents).toBe(145_000n);
      expect(months[0]?.lumpTotalCents).toBe(145_000n);
    });

    it("puts them in date order inside their month", () => {
      const [month] = computeYearAhead({
        from: "2027-03-01",
        monthCount: 1,
        startBalanceCents: 0n,
        moves: [],
        lumps: [
          lump("2027-03-28", "Last", 100),
          lump("2027-03-02", "First", 100),
          lump("2027-03-14", "Middle", 100, "quarterly"),
        ],
      });

      expect(month?.lumps.map((entry) => entry.name)).toEqual(["First", "Middle", "Last"]);
    });

    it("has none at all when nothing irregular was passed", () => {
      const [month] = computeYearAhead({
        from: "2027-03-01",
        monthCount: 1,
        startBalanceCents: 0n,
        moves: [out("2027-03-01", "Rent", 1500)],
      });

      expect(month?.lumps).toEqual([]);
      expect(month?.lumpTotalCents).toBe(0n);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* What to set aside                                                          */
/* -------------------------------------------------------------------------- */

describe("setAsideFor", () => {
  /** Twelve months, one bill, in the month given. */
  function year(bills: { month: number; dollars: number }[]) {
    return computeYearAhead({
      from: "2027-01-01",
      monthCount: 12,
      startBalanceCents: 0n,
      moves: [],
      lumps: bills.map((bill) =>
        lump(
          `2027-${String(bill.month).padStart(2, "0")}-15` as PlainDate,
          `Bill ${String(bill.month)}`,
          bill.dollars,
        ),
      ),
    });
  }

  it("is nothing when there is nothing irregular", () => {
    const aside = setAsideFor(year([]));
    expect(aside.totalCents).toBe(0n);
    expect(aside.evenCents).toBe(0n);
    expect(aside.levelCents).toBe(0n);
    expect(aside.bindingLabel).toBe(null);
  });

  it("is nothing when there are no months at all", () => {
    expect(setAsideFor([]).monthCount).toBe(0);
  });

  /**
   * A bill in the last month of the year is the easy case: there is a whole
   * year to save for it, so the two figures agree and there is nobody to
   * blame.
   */
  it("agrees with the obvious answer when the bill is at the end", () => {
    const aside = setAsideFor(year([{ month: 12, dollars: 1200 }]));
    expect(aside.totalCents).toBe(120_000n);
    expect(aside.evenCents).toBe(10_000n);
    expect(aside.levelCents).toBe(10_000n);
    expect(aside.bindingLabel).toBe(null);
  });

  /**
   * The whole reason this function exists. The same bill in January needs all
   * of itself in month one, not a twelfth of itself - and dividing by twelve
   * would have told the household they were covered while they were short by
   * eleven twelfths of it.
   */
  it("asks for the whole bill when the bill is in the first month", () => {
    const aside = setAsideFor(year([{ month: 1, dollars: 1200 }]));
    expect(aside.evenCents).toBe(10_000n);
    expect(aside.levelCents).toBe(120_000n);
    expect(aside.bindingLabel).toBe("Jan 2027");
  });

  /** The month that forces the figure up is the one named, not the biggest. */
  it("blames the month that actually binds", () => {
    // $600 in March (needs 200/month by then) and $600 in December
    // (1200 over 12 = 100/month). March wins.
    const aside = setAsideFor(year([
      { month: 3, dollars: 600 },
      { month: 12, dollars: 600 },
    ]));

    expect(aside.evenCents).toBe(10_000n);
    expect(aside.levelCents).toBe(20_000n);
    expect(aside.bindingLabel).toBe("Mar 2027");
    expect(aside.bindingStart).toBe("2027-03-01");
  });

  it("counts the bills as well as the money", () => {
    const aside = setAsideFor(year([
      { month: 2, dollars: 100 },
      { month: 5, dollars: 100 },
      { month: 9, dollars: 100 },
    ]));

    expect(aside.billCount).toBe(3);
    expect(aside.totalCents).toBe(30_000n);
  });

  /** Cents, not fractions of one: always round the ask UP. */
  it("rounds the monthly figure up, so it is never a cent short", () => {
    const aside = setAsideFor(year([{ month: 12, dollars: 100 }]));
    // 10000 / 12 = 833.33...
    expect(aside.evenCents).toBe(834n);
    expect(834n * 12n).toBeGreaterThanOrEqual(10_000n);
  });
});

/* -------------------------------------------------------------------------- */
/* Which windfall pays for which squeeze                                      */
/* -------------------------------------------------------------------------- */

describe("pairUnusualMonths", () => {
  function month(start: PlainDate, label: string, dollars: number): UnusualMonth {
    return { start, label, netExtraCents: BigInt(dollars * 100) };
  }

  it("pairs one windfall with the squeeze after it", () => {
    const { pairs, uncoveredCents, spareCents } = pairUnusualMonths([
      month("2027-03-01", "Mar 2027", 2300),
      month("2027-11-01", "Nov 2027", -1540),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.windfallLabel).toBe("Mar 2027");
    expect(pairs[0]?.squeezeLabel).toBe("Nov 2027");
    expect(pairs[0]?.coveredCents).toBe(154_000n);
    expect(pairs[0]?.squeezeFirst).toBe(false);
    expect(uncoveredCents).toBe(0n);
    expect(spareCents).toBe(76_000n);
  });

  /**
   * The case worth building this for: the year balances and the household is
   * still short in March, because the cheque that pays for it does not arrive
   * until August.
   */
  it("says when the squeeze lands before the money for it", () => {
    const { pairs, uncoveredCents } = pairUnusualMonths([
      month("2027-03-01", "Mar 2027", -1540),
      month("2027-08-01", "Aug 2027", 2300),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.squeezeFirst).toBe(true);
    expect(uncoveredCents).toBe(0n);
  });

  it("splits one windfall across two squeezes, in order", () => {
    const { pairs, spareCents } = pairUnusualMonths([
      month("2027-01-01", "Jan 2027", 1000),
      month("2027-04-01", "Apr 2027", -600),
      month("2027-07-01", "Jul 2027", -600),
    ]);

    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ squeezeLabel: "Apr 2027", coveredCents: 60_000n });
    // The second squeeze eats what is left of the same windfall, and the rest
    // is simply not covered.
    expect(pairs[1]).toMatchObject({
      windfallLabel: "Jan 2027",
      squeezeLabel: "Jul 2027",
      coveredCents: 40_000n,
    });
    expect(spareCents).toBe(0n);
  });

  it("draws one squeeze from two windfalls, earliest first", () => {
    const { pairs, uncoveredCents } = pairUnusualMonths([
      month("2027-01-01", "Jan 2027", 400),
      month("2027-02-01", "Feb 2027", 400),
      month("2027-06-01", "Jun 2027", -1000),
    ]);

    expect(pairs.map((pair) => pair.windfallLabel)).toEqual(["Jan 2027", "Feb 2027"]);
    expect(pairs.map((pair) => pair.coveredCents)).toEqual([40_000n, 40_000n]);
    expect(uncoveredCents).toBe(20_000n);
  });

  it("reports a squeeze nothing in the window answers", () => {
    const { pairs, uncoveredCents, spareCents } = pairUnusualMonths([
      month("2027-05-01", "May 2027", -1540),
    ]);

    expect(pairs).toEqual([]);
    expect(uncoveredCents).toBe(154_000n);
    expect(spareCents).toBe(0n);
  });

  /**
   * A month holding an extra cheque AND an extra payment of the same size.
   * The cheque calendar already shows it as unusual; there is nothing here to
   * pair, and inventing a pairing of it with itself would read as advice.
   */
  it("leaves out a month whose extras cancel", () => {
    const { pairs, uncoveredCents, spareCents } = pairUnusualMonths([
      month("2027-05-01", "May 2027", 0),
    ]);

    expect(pairs).toEqual([]);
    expect(uncoveredCents).toBe(0n);
    expect(spareCents).toBe(0n);
  });

  it("works from the calendar order, not the order it was handed", () => {
    const { pairs } = pairUnusualMonths([
      month("2027-09-01", "Sep 2027", 500),
      month("2027-02-01", "Feb 2027", 500),
      month("2027-11-01", "Nov 2027", -1000),
    ]);

    expect(pairs.map((pair) => pair.windfallLabel)).toEqual(["Feb 2027", "Sep 2027"]);
  });

  it("has nothing to say about nothing", () => {
    expect(pairUnusualMonths([])).toEqual({ pairs: [], uncoveredCents: 0n, spareCents: 0n });
  });
});
