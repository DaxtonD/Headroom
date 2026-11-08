/**
 * Deriving a monthly budget figure from a recurring amount.
 *
 * The case that matters most: biweekly is 26 times a year, not 24. Treating it
 * as twice a month understates the yearly cost by two whole payments, which on
 * a mortgage is thousands.
 *
 * Amounts are invented.
 */
import { describe, expect, it } from "vitest";
import {
  cadenceOfSchedule,
  monthlyEquivalentCents,
  monthlyFigureFor,
  timesPerYear,
  yearlyEquivalentCents,
} from "../src/monthlyEquivalent.js";

describe("monthlyEquivalentCents", () => {
  it("leaves a monthly amount alone", () => {
    expect(monthlyEquivalentCents(15_000n, "monthly")).toBe(15_000n);
  });

  it("treats biweekly as 26 a year, not 24", () => {
    // 100000 * 26 / 12 = 216666.67 -> 216667
    expect(monthlyEquivalentCents(100_000n, "biweekly")).toBe(216_667n);

    // The wrong answer, for contrast: twice the amount.
    expect(monthlyEquivalentCents(100_000n, "biweekly")).not.toBe(200_000n);
    // And it is not the semi-monthly answer either.
    expect(monthlyEquivalentCents(100_000n, "semi_monthly")).toBe(200_000n);
  });

  it("converts the other cadences", () => {
    // 52 weeks / 12 months.
    expect(monthlyEquivalentCents(10_000n, "weekly")).toBe(43_333n);
    // Four times a year.
    expect(monthlyEquivalentCents(30_000n, "quarterly")).toBe(10_000n);
    // Once a year.
    expect(monthlyEquivalentCents(120_000n, "yearly")).toBe(10_000n);
  });

  it("rounds half away from zero, once, at the end", () => {
    // 1 * 26 / 12 = 2.1666 -> 2
    expect(monthlyEquivalentCents(1n, "biweekly")).toBe(2n);
    // 6 * 26 / 12 = 13 exactly.
    expect(monthlyEquivalentCents(6n, "biweekly")).toBe(13n);
    expect(monthlyEquivalentCents(0n, "biweekly")).toBe(0n);
  });

  it("stays exact for an amount no float could hold", () => {
    const huge = 9_007_199_254_740_993n;
    // Multiplication happens before the division, so nothing is lost.
    expect(monthlyEquivalentCents(huge, "monthly")).toBe(huge);
    expect(monthlyEquivalentCents(huge * 12n, "yearly")).toBe(huge);
  });
});

describe("yearlyEquivalentCents", () => {
  it("is the amount times how often it is charged", () => {
    expect(yearlyEquivalentCents(100_000n, "biweekly")).toBe(2_600_000n);
    expect(yearlyEquivalentCents(15_000n, "monthly")).toBe(180_000n);
    expect(yearlyEquivalentCents(10_000n, "weekly")).toBe(520_000n);
    expect(yearlyEquivalentCents(120_000n, "yearly")).toBe(120_000n);
  });

  it("does not lose the two extra payments a biweekly year has", () => {
    const biweekly = yearlyEquivalentCents(100_000n, "biweekly");
    const semiMonthly = yearlyEquivalentCents(100_000n, "semi_monthly");
    // Exactly two payments more.
    expect(biweekly - semiMonthly).toBe(200_000n);
  });
});

describe("timesPerYear", () => {
  it("reports what the UI should say", () => {
    expect(timesPerYear("biweekly")).toBe(26);
    expect(timesPerYear("monthly")).toBe(12);
    expect(timesPerYear("semi_monthly")).toBe(24);
    expect(timesPerYear("weekly")).toBe(52);
    expect(timesPerYear("quarterly")).toBe(4);
    expect(timesPerYear("yearly")).toBe(1);
  });
});

describe("cadenceOfSchedule", () => {
  it("maps the timeline's scheduling rules onto a cadence", () => {
    expect(cadenceOfSchedule({ type: "monthly" })).toBe("monthly");
    expect(cadenceOfSchedule({ type: "monthly_last" })).toBe("monthly");
    // Follows a biweekly payday, so it recurs with the paydays.
    expect(cadenceOfSchedule({ type: "relative_to_pay" })).toBe("biweekly");
    expect(cadenceOfSchedule({ type: "biweekly" })).toBe("biweekly");
    expect(cadenceOfSchedule({ type: "flexible", frequency: "monthly" })).toBe("monthly");
    expect(cadenceOfSchedule({ type: "flexible", frequency: "per_pay_period" })).toBe("biweekly");
  });
});

describe("monthlyFigureFor", () => {
  it("derives both figures when nothing is stated", () => {
    const figure = monthlyFigureFor({ cents: 100_000n, cadence: "biweekly" });

    expect(figure.monthlyCents).toBe(216_667n);
    expect(figure.yearlyCents).toBe(2_600_000n);
    expect(figure.overridden).toBe(false);
    expect(figure.derivedMonthlyCents).toBe(216_667n);
  });

  it("lets a stated monthly figure win", () => {
    // Someone's sheet says the month costs a round number.
    const figure = monthlyFigureFor({
      cents: 100_000n,
      cadence: "biweekly",
      monthlyOverrideCents: 215_000n,
    });

    expect(figure.monthlyCents).toBe(215_000n);
    expect(figure.overridden).toBe(true);
    // Still reports what the derivation gave, so the UI can show both and the
    // difference is visible rather than hidden.
    expect(figure.derivedMonthlyCents).toBe(216_667n);
  });

  it("takes the year from the stated month, not from the derivation", () => {
    const figure = monthlyFigureFor({
      cents: 100_000n,
      cadence: "biweekly",
      monthlyOverrideCents: 215_000n,
    });

    // If someone has said what a month costs, the year follows from that.
    expect(figure.yearlyCents).toBe(215_000n * 12n);
    expect(figure.yearlyCents).not.toBe(2_600_000n);
  });

  it("treats an absent override as absent, not as zero", () => {
    for (const monthlyOverrideCents of [null, undefined]) {
      const figure = monthlyFigureFor({ cents: 15_000n, cadence: "monthly", monthlyOverrideCents });
      expect(figure.monthlyCents).toBe(15_000n);
      expect(figure.overridden).toBe(false);
    }
  });

  it("allows an override of zero, which is a real thing to want", () => {
    // A bill that is being paid some other way, so it should not count
    // against the monthly budget.
    const figure = monthlyFigureFor({
      cents: 15_000n,
      cadence: "monthly",
      monthlyOverrideCents: 0n,
    });

    expect(figure.monthlyCents).toBe(0n);
    expect(figure.overridden).toBe(true);
    expect(figure.derivedMonthlyCents).toBe(15_000n);
  });
});
