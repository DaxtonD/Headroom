/**
 * Budget, goals, reimbursements and banked hours, for the paths the golden
 * fixture does not reach (it has no reimbursements and no banked hours).
 *
 * Every amount here is invented.
 */
import { describe, expect, it } from "vitest";
import {
  computeBudget,
  computeReimbursements,
  sumBankedHours,
} from "../src/budget.js";
import { computeNetWorth, computeRetirement } from "../src/netWorth.js";
import type { BudgetLineInput } from "../src/types.js";

describe("computeBudget", () => {
  const income = { netMonthlyCents: 100_000n, netYearlyCents: 1_200_000n };

  it("splits the sections and totals them", () => {
    const lines: BudgetLineInput[] = [
      { name: "Rent", section: "fixed", monthlyCents: 50_000n },
      { name: "Insurance", section: "fixed", monthlyCents: 10_000n },
      { name: "Food", section: "variable", monthlyCents: 20_000n },
    ];

    const budget = computeBudget({ income, lines });

    expect(budget.fixed.monthlyCents).toBe(60_000n);
    expect(budget.fixed.yearlyCents).toBe(720_000n);
    expect(budget.variable.monthlyCents).toBe(20_000n);
    expect(budget.totalMonthlyCents).toBe(80_000n);
    expect(budget.balanceMonthlyCents).toBe(20_000n);
    expect(budget.balanceYearlyCents).toBe(1_200_000n - 960_000n);
  });

  it("gives each line its share of its own section, not of income", () => {
    const lines: BudgetLineInput[] = [
      { name: "Rent", section: "fixed", monthlyCents: 75_000n },
      { name: "Insurance", section: "fixed", monthlyCents: 25_000n },
      { name: "Food", section: "variable", monthlyCents: 10_000n },
    ];

    const budget = computeBudget({ income, lines });

    // Rent is 75% of fixed expenses, which is not 75% of what comes in.
    expect(budget.fixed.lines.find((line) => line.name === "Rent")?.sharePct).toBe(75);
    expect(budget.fixed.lines.find((line) => line.name === "Insurance")?.sharePct).toBe(25);
    // The only variable line is all of its section.
    expect(budget.variable.lines[0]?.sharePct).toBe(100);
  });

  it("uses a yearly override where twelve times monthly is wrong", () => {
    const lines: BudgetLineInput[] = [
      { name: "Property tax", section: "fixed", monthlyCents: 30_000n, yearlyCentsOverride: 350_000n },
    ];

    const budget = computeBudget({ income, lines });

    expect(budget.fixed.monthlyCents).toBe(30_000n);
    expect(budget.fixed.yearlyCents).toBe(350_000n);
    expect(budget.totalYearlyCents).toBe(350_000n);
  });

  it("handles an empty section without dividing by zero", () => {
    const budget = computeBudget({
      income,
      lines: [{ name: "Rent", section: "fixed", monthlyCents: 50_000n }],
    });

    expect(budget.variable.monthlyCents).toBe(0n);
    expect(budget.variable.lines).toEqual([]);
    expect(budget.balanceMonthlyCents).toBe(50_000n);
  });

  it("reports a negative balance when the household is overspending", () => {
    const budget = computeBudget({
      income,
      lines: [{ name: "Rent", section: "fixed", monthlyCents: 150_000n }],
    });

    expect(budget.balanceMonthlyCents).toBe(-50_000n);
  });
});

// Goals moved out of this module. They are earmarks against one real savings
// account now, with an optional target, and they live in `savings.test.ts`.
// The one behaviour that changed on the way: `remainingCents` is clamped at
// zero instead of going negative when a target is overshot, because "met" is
// what a screen wants to say. How far past is still recoverable from the
// amount set aside and the target.

describe("computeReimbursements", () => {
  it("sorts each purchase into bought, submitted or paid back", () => {
    const summary = computeReimbursements([
      { purchase: "Cable", cents: 5_000n },
      { purchase: "Drill bits", cents: 12_000n, submittedAt: "2026-11-03T10:00:00-06:00" },
      {
        purchase: "Fittings",
        cents: 8_000n,
        submittedAt: "2026-10-20T10:00:00-06:00",
        paidAt: "2026-10-31T10:00:00-06:00",
      },
    ]);

    expect(summary.items.map((item) => item.status)).toEqual(["bought", "submitted", "paid"]);
    expect(summary.awaitingSubmissionCents).toBe(5_000n);
    expect(summary.submittedCents).toBe(12_000n);
    expect(summary.paidCents).toBe(8_000n);
    // What the employer still owes the household.
    expect(summary.outstandingCents).toBe(17_000n);
    expect(summary.totalCents).toBe(25_000n);
  });

  it("walks the household's own worked example", () => {
    /*
     * Two purchases at $50, submitted one at a time, then one paid back.
     * This is the sequence the screen was redesigned around on 2026-11-18,
     * and the figures it has to produce at each step.
     *
     * The screen shows "Submitted X of Y" where Y is what is still out, and
     * warns while `awaitingSubmissionCents` is above zero - so the gap
     * between the two is the only thing on that panel with anything left to
     * do about it.
     */
    const both = [
      { purchase: "Lumber", cents: 5_000n },
      { purchase: "Tools", cents: 5_000n },
    ];

    const bought = computeReimbursements(both);
    expect(bought.awaitingSubmissionCents).toBe(10_000n);
    expect(bought.submittedCents).toBe(0n);
    expect(bought.outstandingCents).toBe(10_000n);

    const half = computeReimbursements([
      both[0] as (typeof both)[number],
      { ...(both[1] as (typeof both)[number]), submittedAt: "2026-11-18T10:00:00-06:00" },
    ]);
    // "Submitted $50.00 of $100.00", and $50.00 still to submit.
    expect(half.submittedCents).toBe(5_000n);
    expect(half.outstandingCents).toBe(10_000n);
    expect(half.awaitingSubmissionCents).toBe(5_000n);

    const submitted = both.map((item) => ({
      ...item,
      submittedAt: "2026-11-18T10:00:00-06:00",
    }));
    const all = computeReimbursements(submitted);
    // "Submitted $100.00 of $100.00", and no warning.
    expect(all.submittedCents).toBe(10_000n);
    expect(all.outstandingCents).toBe(10_000n);
    expect(all.awaitingSubmissionCents).toBe(0n);

    const paid = computeReimbursements([
      submitted[0] as (typeof submitted)[number],
      { ...(submitted[1] as (typeof submitted)[number]), paidAt: "2026-11-19T10:00:00-06:00" },
    ]);
    // One has come back, so it leaves the live figures entirely and the
    // history carries it instead: "Submitted $50.00 of $50.00".
    expect(paid.submittedCents).toBe(5_000n);
    expect(paid.outstandingCents).toBe(5_000n);
    expect(paid.awaitingSubmissionCents).toBe(0n);
    expect(paid.paidCents).toBe(5_000n);
  });

  it("never lets the two live figures disagree with the gap", () => {
    // The screen prints one as a fraction of the other and warns on the
    // difference, so this is the invariant underneath all three numbers.
    const summary = computeReimbursements([
      { purchase: "A", cents: 1_234n },
      { purchase: "B", cents: 9_900n, submittedAt: "2026-11-01T10:00:00-06:00" },
      {
        purchase: "C",
        cents: 4_000n,
        submittedAt: "2026-10-01T10:00:00-06:00",
        paidAt: "2026-10-15T10:00:00-06:00",
      },
    ]);

    expect(summary.awaitingSubmissionCents + summary.submittedCents).toBe(
      summary.outstandingCents,
    );
    expect(summary.outstandingCents + summary.paidCents).toBe(summary.totalCents);
  });

  it("is zero across the board when there is nothing to claim", () => {
    const summary = computeReimbursements([]);

    expect(summary.items).toEqual([]);
    expect(summary.outstandingCents).toBe(0n);
    expect(summary.totalCents).toBe(0n);
  });

  it("treats paid as paid even if the submission date was never recorded", () => {
    const summary = computeReimbursements([
      { purchase: "Odd one", cents: 1_000n, paidAt: "2026-11-01T10:00:00-06:00" },
    ]);

    expect(summary.items[0]?.status).toBe("paid");
    expect(summary.outstandingCents).toBe(0n);
  });
});

describe("sumBankedHours", () => {
  it("adds hours exactly, where repeated float addition would drift", () => {
    const entries = Array.from({ length: 10 }, () => ({ userId: "jordan", hours: "0.10" }));
    expect(sumBankedHours(entries)).toBe("1.00");
  });

  it("handles quarters and halves", () => {
    expect(
      sumBankedHours([
        { userId: "jordan", hours: "7.50" },
        { userId: "jordan", hours: "0.25" },
        { userId: "alex", hours: "2.25" },
      ]),
    ).toBe("10.00");
  });

  it("accepts whole hours and one decimal place", () => {
    expect(sumBankedHours([{ userId: "jordan", hours: "8" }])).toBe("8.00");
    expect(sumBankedHours([{ userId: "jordan", hours: "8.5" }])).toBe("8.50");
  });

  it("handles hours taken back out", () => {
    expect(
      sumBankedHours([
        { userId: "jordan", hours: "8.00" },
        { userId: "jordan", hours: "-3.50" },
      ]),
    ).toBe("4.50");
  });

  it("is zero for no entries", () => {
    expect(sumBankedHours([])).toBe("0.00");
  });

  it("reads a real minus sign as a minus", () => {
    /*
     * U+2212, not a hyphen. The form's own hint used to offer "\u22127.5" as
     * the way to take hours back out, while only an ASCII hyphen parsed - so
     * following the instruction to the letter was rejected. Both are a minus.
     */
    expect(sumBankedHours([{ userId: "jordan", hours: "\u22127.5" }])).toBe("-7.50");
    expect(
      sumBankedHours([
        { userId: "jordan", hours: "8" },
        { userId: "jordan", hours: "\u22123.25" },
      ]),
    ).toBe("4.75");
  });

  it("refuses something that is not an hours value", () => {
    expect(() => sumBankedHours([{ userId: "jordan", hours: "eight" }])).toThrow(SyntaxError);
    expect(() => sumBankedHours([{ userId: "jordan", hours: "1.234" }])).toThrow(SyntaxError);
  });
});

describe("computeNetWorth", () => {
  it("subtracts what is owed from what is owned", () => {
    const result = computeNetWorth({
      assets: [
        { name: "Home", cents: 40_000_000n },
        { name: "RRSPs", cents: 15_000_000n },
      ],
      liabilities: [{ name: "Mortgage", cents: 14_000_000n }],
    });

    expect(result.assetsCents).toBe(55_000_000n);
    expect(result.liabilitiesCents).toBe(14_000_000n);
    expect(result.netWorthCents).toBe(41_000_000n);
  });

  it("can be negative when the debts are bigger", () => {
    const result = computeNetWorth({
      assets: [{ name: "Car", cents: 500_000n }],
      liabilities: [{ name: "Loan", cents: 900_000n }],
    });

    expect(result.netWorthCents).toBe(-400_000n);
  });

  it("is zero with nothing recorded", () => {
    expect(computeNetWorth({ assets: [], liabilities: [] }).netWorthCents).toBe(0n);
  });
});

describe("computeRetirement", () => {
  const inputs = {
    rrspCurrentPlusContribCents: 30_000_000n,
    mortgageMonthlyCents: 200_000n,
    redirectYears: 16,
    flatGrowthPct: 10,
    drawdownYears: 25,
    govPensionAnnualCents: 2_000_000n,
    retirementExpensesAnnualCents: 2_200_000n,
  };

  it("redirects the mortgage payment for the stated number of years", () => {
    const result = computeRetirement({ inputs, netWorthCents: 0n });
    // 200,000 cents x 12 months x 16 years.
    expect(result.mortgageRedirectCents).toBe(38_400_000n);
    expect(result.baseBeforeGrowthCents).toBe(68_400_000n);
  });

  it("applies the growth once, not compounded", () => {
    const result = computeRetirement({ inputs, netWorthCents: 0n });
    expect(result.rrspAt65Cents).toBe(75_240_000n);
    expect(result.growthCents).toBe(6_840_000n);
  });

  it("compounds yearly when that setting is turned on", () => {
    const flat = computeRetirement({ inputs, netWorthCents: 0n });
    const compounded = computeRetirement({
      inputs: { ...inputs, compoundYearly: true },
      netWorthCents: 0n,
    });

    expect(compounded.rrspAt65Cents > flat.rrspAt65Cents).toBe(true);
  });

  it("divides the pot across the years in retirement", () => {
    const result = computeRetirement({ inputs, netWorthCents: 0n });
    expect(result.annualDrawCents).toBe(3_009_600n);
    expect(result.extraPerYearCents).toBe(3_009_600n + 2_000_000n - 2_200_000n);
    expect(result.extraPerMonthCents).toBe(234_133n);
  });

  it("adds net worth to the RRSPs for the total", () => {
    const result = computeRetirement({ inputs, netWorthCents: 43_000_000n });
    expect(result.totalForRetirementCents).toBe(43_000_000n + 75_240_000n);
  });

  it("works with no growth at all", () => {
    const result = computeRetirement({
      inputs: { ...inputs, flatGrowthPct: 0 },
      netWorthCents: 0n,
    });

    expect(result.growthCents).toBe(0n);
    expect(result.rrspAt65Cents).toBe(result.baseBeforeGrowthCents);
  });

  it("refuses a drawdown of zero years rather than dividing by it", () => {
    expect(() =>
      computeRetirement({ inputs: { ...inputs, drawdownYears: 0 }, netWorthCents: 0n }),
    ).toThrow(/at least 1/);
  });

  it("refuses a fractional number of years", () => {
    expect(() =>
      computeRetirement({ inputs: { ...inputs, redirectYears: 1.5 }, netWorthCents: 0n }),
    ).toThrow(RangeError);
  });
});
