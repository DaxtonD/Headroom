/**
 * An expense that comes out once a year, on the screens that offer it.
 *
 * ## What was asked for
 *
 * "When I mentioned annual expenses / subscriptions I thought you'd add an
 * option on the expense form to select every year on a date." Reported
 * 2026-11-19, and the gap was exactly that narrow: the Budget page has always
 * known how to spread a yearly amount over twelve months - `Cadence` in
 * `monthlyEquivalent.ts` has had `yearly` from the first commit - but no
 * schedule could produce one, so an annual policy had to be entered as a
 * monthly twelfth and the date the money really leaves was lost.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite, and everything with arithmetic in it is
 * tested where it lives, with values: the engine tests prove the dates
 * (including the 29th of February and the weekend rule), the engine tests
 * prove a twelfth of the amount, and the API tests prove both ends meet
 * against real Postgres - the whole amount on the ledger on its date, a
 * twelfth of it in the monthly budget.
 *
 * What a grep covers well is the option quietly disappearing from the form,
 * the controls for it ceasing to render, or - the one that has actually
 * happened in this file before - a stored schedule mapping back to the wrong
 * option, which silently rewrites it on the next save.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const billForm = source("src/components/BillForm.tsx");
const manage = source("src/pages/Manage.tsx");
const manageQueries = source("src/lib/manageQueries.ts");

describe("the expense form offers it", () => {
  it("has a yearly option, in the words someone would use", () => {
    expect(billForm).toMatch(/key: "yearly", label: "Every year, on a date"/);
  });

  /**
   * The bug this file has already seen once, on the biweekly option.
   *
   * `recurrenceOf` turns a stored schedule back into the option that produced
   * it. When it maps to the wrong one, nothing fails: the form opens showing
   * the wrong answer and the next save writes that answer back. A yearly
   * expense would quietly become a monthly one, at twelve times the cost.
   */
  it("maps a stored yearly schedule back to the yearly option", () => {
    expect(billForm).toMatch(/case "yearly":\s*\n\s*return "yearly";/);
  });

  it("sends a month and a day, and refuses a month that is not one", () => {
    expect(billForm).toMatch(/type: "yearly", month: parsedMonth, day: parsedDay/);
    expect(billForm).toMatch(/parsedMonth < 1 \|\| parsedMonth > 12/);
    expect(billForm).toMatch(/parsedDay < 1 \|\| parsedDay > 31/);
  });

  it("renders a month picker from the engine's list, not its own", () => {
    expect(billForm).toMatch(/MONTH_NAMES\.map\(/);
    // Twelve month names written out in a component would be a second list to
    // keep in step with the one the Manage screen reads back out.
    expect(billForm).not.toMatch(/"January",\s*\n\s*"February"/);
  });

  it("asks for the day with the same control the monthly option uses", () => {
    expect(billForm).toMatch(/recurrence === "monthly_day" \|\| recurrence === "yearly"/);
  });

  /**
   * "1 times a year" is not a sentence, and it is what the generic line would
   * have produced. The useful fact for a yearly expense is the monthly figure
   * above it, so the note explains that instead of counting to one.
   */
  it("does not tell anyone a yearly bill is charged 1 times a year", () => {
    expect(billForm).toMatch(/preview\.cadence === "yearly"/);
    expect(billForm).toMatch(/Charged once a year/);
  });
});

describe("the Manage list reads it back", () => {
  it("names the month, so the row says which date it is", () => {
    expect(manage).toMatch(/Yearly, on the \$\{ordinal\(schedule\.day\)\} of \$\{monthName\(/);
  });

  /**
   * Every other schedule gets a "· 26x a year" tail, and it earns its place
   * there: it is what tells somebody a fortnightly bill is 26 payments and not
   * 24. On a yearly one it restates the word and reads like a mistake.
   */
  it("leaves the times-a-year tail off, because it would say 1x", () => {
    const yearlyCase = /case "yearly":\s*\n\s*return `Yearly[^`]*`/.exec(manage)?.[0] ?? "";
    expect(yearlyCase).not.toBe("");
    expect(yearlyCase).not.toMatch(/howOften/);
  });
});

describe("the type says it", () => {
  it("is in the schedule union the forms and the list share", () => {
    expect(manageQueries).toMatch(
      /type: "yearly"; readonly month: number; readonly day: number/,
    );
  });
});

describe("one place decides the date", () => {
  /**
   * The mirror of `accountDelta` being the only place that decides a sign, and
   * of `routing.ts` being the only place that decides an account.
   *
   * Clamping the 29th of February, applying the weekend rule and keying by the
   * year are the engine's job. A screen that worked any of them out itself
   * would agree with the ledger until a leap year or a Saturday, which is the
   * worst kind of disagreement: right in testing, wrong in February.
   */
  it("is the engine, not a screen", () => {
    for (const [name, text] of [
      ["BillForm", billForm],
      ["Manage", manage],
    ] as const) {
      // Nothing works out which day of the month a yearly date lands on...
      expect(text, name).not.toMatch(/daysInMonth|getDaysInMonth/);
      // ...and nothing decides a leap year for itself.
      expect(text, name).not.toMatch(/% 4 === 0|isLeapYear/);
    }
  });
});
