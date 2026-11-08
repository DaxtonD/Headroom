/**
 * Calendar arithmetic.
 *
 * `America/Regina` has no daylight saving, which is why this can be exact
 * integer arithmetic. The tests below include the cases that break naive date
 * handling anyway: month ends, leap years, year boundaries, and a bill "on the
 * 31st" in a month with 30 days.
 *
 * Dates are structure, not money, so real dates from the household's schedule
 * are fine to use here.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  applyWeekendRule,
  compareDates,
  daysBetween,
  daysInMonth,
  firstPaydayOnOrAfter,
  formatDateShort,
  formatDayAndMonth,
  formatDayMonthAndYear,
  isPaydayOn,
  isPlainDate,
  isWeekend,
  monthlyOccurrenceDate,
  nextPaydays,
  parseDate,
  paydaysBetween,
  weekdayName,
} from "../src/dates.js";

describe("parsing", () => {
  it("accepts a real date", () => {
    expect(parseDate("2026-11-07")).toEqual({ year: 2026, month: 11, day: 7 });
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    for (const value of ["2026-11-7", "07/11/2026", "2026-11", "", "yesterday", "2026-11-07T00:00:00Z"]) {
      expect(isPlainDate(value), value).toBe(false);
    }
  });

  it("rejects a date that does not exist", () => {
    expect(isPlainDate("2026-02-30")).toBe(false);
    expect(isPlainDate("2026-13-01")).toBe(false);
    expect(isPlainDate("2026-11-31")).toBe(false);
    expect(isPlainDate("2026-00-10")).toBe(false);
  });

  it("knows about leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(isPlainDate("2028-02-29")).toBe(true);
    expect(isPlainDate("2026-02-29")).toBe(false);
  });
});

describe("day arithmetic", () => {
  it("adds and subtracts days across a month end", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
    expect(addDays("2026-11-07", 0)).toBe("2026-11-07");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("crosses a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("counts days between dates, in both directions", () => {
    expect(daysBetween("2026-11-12", "2026-11-26")).toBe(14);
    expect(daysBetween("2026-11-26", "2026-11-12")).toBe(-14);
    expect(daysBetween("2026-11-07", "2026-11-07")).toBe(0);
    // 2028 is a leap year.
    expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
  });

  it("refuses a fractional number of days", () => {
    expect(() => addDays("2026-11-07", 1.5)).toThrow(RangeError);
  });

  it("sorts as dates", () => {
    const dates = ["2026-12-02", "2026-11-07", "2026-11-30"];
    expect([...dates].sort(compareDates)).toEqual(["2026-11-07", "2026-11-30", "2026-12-02"]);
  });
});

describe("weekdays", () => {
  it("names the day correctly", () => {
    // Known anchors: 2026-11-12 is a Thursday, which is payday.
    expect(weekdayName("2026-11-12")).toBe("Thursday");
    expect(weekdayName("2026-11-07")).toBe("Saturday");
    expect(weekdayName("2026-11-22")).toBe("Sunday");
    expect(weekdayName("1970-01-01")).toBe("Thursday");
  });

  it("knows a weekend from a weekday", () => {
    expect(isWeekend("2026-11-07")).toBe(true); // Saturday
    expect(isWeekend("2026-11-22")).toBe(true); // Sunday
    expect(isWeekend("2026-11-12")).toBe(false); // Thursday
    expect(isWeekend("2026-11-13")).toBe(false); // Friday
  });
});

describe("biweekly paydays", () => {
  const anchor = "2026-11-12";

  it("recognises a payday as every 14 days from the anchor", () => {
    expect(isPaydayOn(anchor, "2026-11-12")).toBe(true);
    expect(isPaydayOn(anchor, "2026-11-26")).toBe(true);
    expect(isPaydayOn(anchor, "2026-12-10")).toBe(true);
    // Backwards from the anchor, too.
    expect(isPaydayOn(anchor, "2026-10-29")).toBe(true);

    expect(isPaydayOn(anchor, "2026-11-19")).toBe(false);
    expect(isPaydayOn(anchor, "2026-11-13")).toBe(false);
  });

  it("is biweekly, not twice a month: three cheques in a month need no special case", () => {
    // Dax's paydays in a long month, straight from the 14-day rule.
    const paydays = paydaysBetween(anchor, "2026-12-01", "2026-12-31");
    expect(paydays).toEqual(["2026-12-10", "2026-12-24"]);

    const january = paydaysBetween(anchor, "2027-01-01", "2027-01-31");
    expect(january).toEqual(["2027-01-07", "2027-01-21"]);
  });

  it("finds the first payday on or after a date", () => {
    expect(firstPaydayOnOrAfter(anchor, "2026-11-07")).toBe("2026-11-12");
    // On the day itself, that day counts.
    expect(firstPaydayOnOrAfter(anchor, "2026-11-12")).toBe("2026-11-12");
    expect(firstPaydayOnOrAfter(anchor, "2026-11-13")).toBe("2026-11-26");
    // Before the anchor it still works, counting backwards.
    expect(firstPaydayOnOrAfter(anchor, "2026-10-01")).toBe("2026-10-01");
  });

  it("lists the next paydays strictly after a date", () => {
    expect(nextPaydays(anchor, "2026-11-07", 3)).toEqual(["2026-11-12", "2026-11-26", "2026-12-10"]);
    // A cheque arriving today is already in the balance, so it is not "next".
    expect(nextPaydays(anchor, "2026-11-12", 2)).toEqual(["2026-11-26", "2026-12-10"]);
    expect(nextPaydays(anchor, "2026-11-07", 0)).toEqual([]);
  });

  it("interleaves two people paid on alternating Thursdays", () => {
    const dax = paydaysBetween("2026-11-12", "2026-11-07", "2026-12-09");
    const carol = paydaysBetween("2026-11-19", "2026-11-07", "2026-12-09");

    expect(dax).toEqual(["2026-11-12", "2026-11-26"]);
    expect(carol).toEqual(["2026-11-19", "2026-12-03"]);

    // Each two-week window holds one cheque from each person.
    const all = [...dax, ...carol].sort(compareDates);
    expect(all).toEqual(["2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"]);
  });

  it("refuses a negative count", () => {
    expect(() => nextPaydays(anchor, "2026-11-07", -1)).toThrow(RangeError);
  });
});

describe("monthly schedules", () => {
  it("places a bill on its day of the month", () => {
    expect(monthlyOccurrenceDate(2026, 11, 17)).toBe("2026-11-17");
    expect(monthlyOccurrenceDate(2026, 12, 1)).toBe("2026-12-01");
  });

  it('handles "last day of the month"', () => {
    // The sheet says the 31st; November has 30 days.
    expect(monthlyOccurrenceDate(2026, 11, "last")).toBe("2026-11-30");
    expect(monthlyOccurrenceDate(2026, 12, "last")).toBe("2026-12-31");
    expect(monthlyOccurrenceDate(2026, 2, "last")).toBe("2026-02-28");
    expect(monthlyOccurrenceDate(2028, 2, "last")).toBe("2028-02-29");
  });

  it("clamps a day the month does not have, rather than spilling into the next", () => {
    // A bill on the 31st must not become March 3rd.
    expect(monthlyOccurrenceDate(2026, 11, 31)).toBe("2026-11-30");
    expect(monthlyOccurrenceDate(2026, 2, 31)).toBe("2026-02-28");
    expect(monthlyOccurrenceDate(2026, 4, 31)).toBe("2026-04-30");
  });

  it("rejects an impossible day", () => {
    expect(() => monthlyOccurrenceDate(2026, 11, 0)).toThrow(RangeError);
    expect(() => monthlyOccurrenceDate(2026, 11, 32)).toThrow(RangeError);
  });
});

/**
 * HANDOFF section 14 question 8 asks for a test per option, because a bank may
 * or may not move a withdrawal that lands on a weekend.
 */
describe("weekend withdrawal rules", () => {
  const saturday = "2026-11-07";
  const sunday = "2026-11-22";
  const thursday = "2026-11-12";

  describe("as_scheduled (the default, and what the spreadsheet does)", () => {
    it("leaves every date exactly where it is", () => {
      expect(applyWeekendRule(saturday, "as_scheduled")).toBe(saturday);
      expect(applyWeekendRule(sunday, "as_scheduled")).toBe(sunday);
      expect(applyWeekendRule(thursday, "as_scheduled")).toBe(thursday);
    });
  });

  describe("friday_before", () => {
    it("moves a Saturday back one day and a Sunday back two", () => {
      expect(applyWeekendRule(saturday, "friday_before")).toBe("2026-11-06");
      expect(weekdayName("2026-11-06")).toBe("Friday");

      expect(applyWeekendRule(sunday, "friday_before")).toBe("2026-11-20");
      expect(weekdayName("2026-11-20")).toBe("Friday");
    });

    it("leaves a weekday alone", () => {
      expect(applyWeekendRule(thursday, "friday_before")).toBe(thursday);
    });

    it("can move a withdrawal into the previous month", () => {
      // 2026-08-01 is a Saturday.
      expect(weekdayName("2026-08-01")).toBe("Saturday");
      expect(applyWeekendRule("2026-08-01", "friday_before")).toBe("2026-07-31");
    });
  });

  describe("next_business_day", () => {
    it("moves a Saturday forward two days and a Sunday forward one", () => {
      expect(applyWeekendRule(saturday, "next_business_day")).toBe("2026-11-09");
      expect(weekdayName("2026-11-09")).toBe("Monday");

      expect(applyWeekendRule(sunday, "next_business_day")).toBe("2026-11-23");
      expect(weekdayName("2026-11-23")).toBe("Monday");
    });

    it("leaves a weekday alone", () => {
      expect(applyWeekendRule(thursday, "next_business_day")).toBe(thursday);
    });

    it("can move a withdrawal into the next month", () => {
      // 2026-10-31 is a Saturday.
      expect(weekdayName("2026-10-31")).toBe("Saturday");
      expect(applyWeekendRule("2026-10-31", "next_business_day")).toBe("2026-11-02");
    });
  });

  it("every rule lands on a weekday when it moves anything", () => {
    for (const rule of ["friday_before", "next_business_day"] as const) {
      for (const date of [saturday, sunday]) {
        expect(isWeekend(applyWeekendRule(date, rule)), `${rule} on ${date}`).toBe(false);
      }
    }
  });
});

describe("display", () => {
  it("formats the way the chips and warnings do", () => {
    expect(formatDateShort("2026-11-22")).toBe("Sun, Nov 22");
    expect(formatDateShort("2026-11-12")).toBe("Thu, Nov 12");
    expect(formatDayAndMonth("2026-12-02")).toBe("Dec 2");
    expect(formatDayAndMonth("2026-11-12")).toBe("Nov 12");
  });
});

describe("a date with the year on it", () => {
  it("writes the month, the day and the year", () => {
    expect(formatDayMonthAndYear("2027-08-13")).toBe("Aug 13, 2027");
    expect(formatDayMonthAndYear("2030-01-01")).toBe("Jan 1, 2030");
  });

  it("is the only formatter that keeps the year, because a payoff date needs it", () => {
    expect(formatDayAndMonth("2027-08-13")).toBe("Aug 13");
    expect(formatDayMonthAndYear("2027-08-13")).toContain("2027");
  });
});
