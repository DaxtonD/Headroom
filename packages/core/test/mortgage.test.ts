/**
 * Amortization, lump sums and the prepayment allowance.
 *
 * Every figure here is invented. The household's real terms live in the
 * git-ignored seed, and the golden tests pick them up from there when the file
 * is present on the machine.
 *
 * The synthetic mortgage is $20,000.00 at 5.00% with a $500.00 payment every
 * fourteen days from 2026-01-02. Expected values were computed independently
 * rather than read back out of this implementation.
 */
import { describe, expect, it } from "vitest";
import {
  BIWEEKLY_CADENCE_DAYS,
  BIWEEKLY_PERIODS_PER_YEAR,
  amortize,
  lumpSumRoom,
  payoffDelta,
  periodInterestCents,
} from "../src/mortgage.js";
import type { MortgageTerms, Prepayment } from "../src/mortgage.js";

const TERMS: MortgageTerms = {
  balanceCents: 2_000_000n,
  asOf: "2026-01-02",
  rateBasisPoints: 500,
  paymentCents: 50_000n,
  paymentAnchorDate: "2026-01-02",
};

describe("interest for one period", () => {
  it("divides the annual rate by the number of payments", () => {
    // 2,000,000 x 500 / (10,000 x 26) = 3,846.15..., half-up to 3,846.
    expect(periodInterestCents(2_000_000n, 500, 26)).toBe(3_846n);
  });

  it("charges less under the Canadian semi-annual convention", () => {
    const simple = periodInterestCents(2_000_000n, 500, 26, "simple_division");
    const canadian = periodInterestCents(2_000_000n, 500, 26, "semi_annual");

    expect(simple).toBe(3_846n);
    expect(canadian).toBe(3_802n);
    expect(canadian).toBeLessThan(simple);
  });

  it("is nothing on a cleared balance", () => {
    expect(periodInterestCents(0n, 500, 26)).toBe(0n);
    expect(periodInterestCents(-100n, 500, 26)).toBe(0n);
  });

  it("refuses a fractional rate", () => {
    expect(() => periodInterestCents(2_000_000n, 5.25, 26)).toThrow(/whole number of basis points/);
  });
});

describe("running the mortgage to zero", () => {
  const result = amortize(TERMS);

  it("clears the balance on a known date", () => {
    expect(result.paymentCount).toBe(42);
    expect(result.payoffDate).toBe("2027-08-13");
    expect(result.totalInterestCents).toBe(83_121n);
  });

  it("splits the first payment into interest and principal", () => {
    const first = result.rows[0]!;

    expect(first.date).toBe("2026-01-16");
    expect(first.interestCents).toBe(3_846n);
    expect(first.principalCents).toBe(46_154n);
    expect(first.principalCents + first.interestCents).toBe(TERMS.paymentCents);
    expect(first.balanceCents).toBe(1_953_846n);
  });

  it("takes only what is needed on the last payment", () => {
    const last = result.rows[result.rows.length - 1]!;

    expect(last.balanceCents).toBe(0n);
    expect(last.paymentCents).toBe(33_121n);
    expect(last.paymentCents).toBeLessThan(TERMS.paymentCents);
  });

  it("accounts for every cent of the opening balance", () => {
    // The identity that makes the whole schedule trustworthy: principal paid
    // plus lump sums equals what was owed, with no rounding leak across 42
    // periods.
    const principal = result.rows.reduce((total, row) => total + row.principalCents, 0n);

    expect(principal + result.totalPrepaidCents).toBe(TERMS.balanceCents);
  });

  it("charges interest that matches the sum of its rows", () => {
    const interest = result.rows.reduce((total, row) => total + row.interestCents, 0n);

    expect(interest).toBe(result.totalInterestCents);
  });

  it("steps every fourteen days", () => {
    expect(BIWEEKLY_CADENCE_DAYS).toBe(14);
    expect(BIWEEKLY_PERIODS_PER_YEAR).toBe(26);
    expect(result.rows[1]!.date).toBe("2026-01-30");
  });
});

describe("a lump sum", () => {
  const lump: Prepayment = { id: "lump", date: "2026-07-01", cents: 500_000n };
  const result = amortize(TERMS, [lump]);

  it("lands with the first payment on or after its date, never before", () => {
    // A forward-looking window here would credit the money on 2026-06-19 and
    // pay the mortgage off a fortnight early on paper.
    const applied = result.rows.filter((row) => row.prepaymentCents > 0n);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.date).toBe("2026-07-03");
    expect(applied[0]!.prepaymentCents).toBe(500_000n);
  });

  it("shortens the term", () => {
    expect(result.paymentCount).toBe(32);
    expect(result.payoffDate).toBe("2027-03-26");
    expect(result.totalPrepaidCents).toBe(500_000n);
  });

  it("still accounts for every cent", () => {
    const principal = result.rows.reduce((total, row) => total + row.principalCents, 0n);

    expect(principal + result.totalPrepaidCents).toBe(TERMS.balanceCents);
  });

  it("is ignored when it predates the opening balance", () => {
    // A prepayment already reflected in `balanceCents` must not be applied
    // twice.
    const already = amortize(TERMS, [{ date: "2025-12-01", cents: 500_000n }]);

    expect(already.totalPrepaidCents).toBe(0n);
    expect(already.payoffDate).toBe(amortize(TERMS).payoffDate);
  });

  it("never overpays the remaining balance", () => {
    const huge = amortize(TERMS, [{ date: "2026-07-01", cents: 99_000_000n }]);

    expect(huge.rows[huge.rows.length - 1]!.balanceCents).toBe(0n);
    expect(huge.totalPrepaidCents).toBeLessThan(99_000_000n);
  });
});

describe("what another lump sum buys", () => {
  it("reports days earlier and interest saved", () => {
    const delta = payoffDelta(TERMS, [], { date: "2026-07-01", cents: 500_000n });

    expect(delta.withoutPayoffDate).toBe("2027-08-13");
    expect(delta.payoffDate).toBe("2027-03-26");
    expect(delta.daysEarlier).toBe(140);
    expect(delta.interestSavedCents).toBe(23_518n);
    expect(delta.paymentsSaved).toBe(10);
  });

  it("buys nothing when there is nothing to buy", () => {
    const delta = payoffDelta(TERMS, [], { date: "2026-07-01", cents: 0n });

    expect(delta.daysEarlier).toBe(0);
    expect(delta.interestSavedCents).toBe(0n);
  });
});

describe("inputs the engine refuses", () => {
  it("rejects a payment that does not cover the interest", () => {
    expect(() => amortize({ ...TERMS, paymentCents: 100n })).toThrow(/does not cover/);
  });

  it("rejects a payment of nothing", () => {
    expect(() => amortize({ ...TERMS, paymentCents: 0n })).toThrow(/positive amount/);
  });

  it("rejects an as-of date that is not a payment date", () => {
    expect(() => amortize({ ...TERMS, asOf: "2026-01-03" })).toThrow(/not a payment date/);
  });

  it("rejects a cadence and a rate divisor that describe different schedules", () => {
    // 14 days x 12 payments is 168 days, not a year. Left unchecked this
    // silently misprices every period.
    expect(() => amortize({ ...TERMS, periodsPerYear: 12 })).toThrow(/same schedule/);
  });
});

describe("the prepayment allowance", () => {
  const prepayments: readonly Prepayment[] = [
    { date: "2025-11-15", cents: 700_000n },
    { date: "2026-04-10", cents: 1_100_000n },
    { date: "2026-11-20", cents: 350_000n },
  ];

  it("counts only the current calendar year", () => {
    // Dax confirmed the privilege runs on the calendar year, so the 2025 lump
    // sum is outside this window even though it is not the oldest.
    const room = lumpSumRoom({
      today: "2026-06-01",
      capCents: 5_000_000n,
      prepayments,
    });

    expect(room.usedCents).toBe(1_450_000n);
    expect(room.roomCents).toBe(3_550_000n);
    expect(room.isUsedUp).toBe(false);
    expect(room.resetsOn).toBe("2027-01-01");
  });

  it("rolls the window over at the new year", () => {
    const room = lumpSumRoom({ today: "2025-06-01", capCents: 5_000_000n, prepayments });

    expect(room.usedCents).toBe(700_000n);
    expect(room.resetsOn).toBe("2026-01-01");
  });

  it("reports an exhausted allowance without going negative", () => {
    const room = lumpSumRoom({
      today: "2026-06-01",
      capCents: 1_000_000n,
      prepayments,
    });

    expect(room.usedCents).toBe(1_450_000n);
    expect(room.roomCents).toBe(0n);
    expect(room.isUsedUp).toBe(true);
  });
});
