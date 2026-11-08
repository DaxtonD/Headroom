/**
 * Which months are unusual, and by how much.
 *
 * Anything biweekly lands in a calendar month twice, except when it lands
 * three times. Pay is biweekly and so is the mortgage, so some months carry an
 * extra paycheque, some carry an extra mortgage payment, and the two are not
 * the same months.
 *
 * ## Why this module exists
 *
 * The spec said, in three separate places, that a month with a third cheque
 * "needs no special handling". That is true of the arithmetic and false of the
 * decision. The running balance absorbs a third cheque silently and correctly,
 * which is exactly why nobody can see it coming - and finding those months is
 * the household's entire monthly ritual, because a third mortgage payment
 * means shifting things around and a third paycheque means more can go to
 * savings.
 *
 * ## The part nobody can hold in their head
 *
 * The mortgage comes out the day after a payday. That one-day offset means a
 * month can hold three paycheques but only two mortgage payments, or two
 * paycheques and three mortgage payments, because the third one slipped over
 * a month boundary. A good month can sit directly beside a bad one for no
 * reason anyone would guess. This module finds both kinds.
 *
 * Nothing here needs amounts to be verified or bills to be entered - only the
 * schedules - so it stays honest a year out, which is well past the point
 * where a running ledger becomes fiction.
 */
import {
  addDays,
  daysInMonth,
  formatMonthAndYear,
  nextMonth,
  parseDate,
  paydaysBetween,
} from "./dates.js";
import type { PlainDate } from "./dates.js";
import type { Cents } from "./money.js";

/**
 * How many times a biweekly series lands in a normal month. Fourteen days into
 * a 28-to-31 day month gives two, and occasionally three.
 */
export const USUAL_MONTHLY_COUNT = 2;

/** Anything that recurs every fourteen days: a paycheque, the mortgage. */
export interface BiweeklySeries {
  readonly id: string;
  readonly name: string;
  /** Any real date the series falls on; the rest are every 14 days from it. */
  readonly anchorDate: PlainDate;
  /** Signed: positive arrives, negative leaves. */
  readonly cents: Cents;
}

export interface ChequeCalendarEntry {
  readonly id: string;
  readonly name: string;
  readonly cents: Cents;
  /** Times this series lands in the month. */
  readonly count: number;
  /** How many more than the usual two. Zero for a normal month. */
  readonly extraCount: number;
  /** `extraCount x cents`, signed. What the oddity is worth. */
  readonly extraCents: Cents;
  readonly dates: readonly PlainDate[];
}

export interface ChequeCalendarMonth {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** `Apr 2027`. */
  readonly label: string;
  readonly start: PlainDate;
  readonly end: PlainDate;
  readonly entries: readonly ChequeCalendarEntry[];
  /**
   * Every entry's `extraCents` added up: what this month is worth relative to
   * a normal one. Positive is a windfall, negative is a squeeze.
   */
  readonly netExtraCents: Cents;
  /** True when any series lands a number of times other than twice. */
  readonly isUnusual: boolean;
}

export interface ChequeCalendarOptions {
  /** Any date inside the first month to report. */
  readonly from: PlainDate;
  /** How many months to report, starting with the one containing `from`. */
  readonly monthCount: number;
  readonly series: readonly BiweeklySeries[];
}

/**
 * Count each series per month and flag the months that differ from the usual
 * two.
 *
 * Whole months are counted, including the days of the first month before
 * `from`. The question "does April hold three mortgage payments" is about
 * April, not about the part of April that happens to be left.
 */
export function computeChequeCalendar(options: ChequeCalendarOptions): ChequeCalendarMonth[] {
  const { monthCount, series } = options;

  if (!Number.isInteger(monthCount) || monthCount < 1) {
    throw new RangeError(`monthCount must be a positive whole number; received ${String(monthCount)}.`);
  }

  const first = parseDate(options.from);
  const months: ChequeCalendarMonth[] = [];
  let cursor = { year: first.year, month: first.month };

  for (let index = 0; index < monthCount; index += 1) {
    const { year, month } = cursor;
    const last = daysInMonth(year, month);
    const start: PlainDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    const end: PlainDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;

    const entries = series.map((entry): ChequeCalendarEntry => {
      const dates = paydaysBetween(entry.anchorDate, start, end);
      const extraCount = dates.length - USUAL_MONTHLY_COUNT;

      return {
        id: entry.id,
        name: entry.name,
        cents: entry.cents,
        count: dates.length,
        extraCount,
        extraCents: BigInt(extraCount) * entry.cents,
        dates,
      };
    });

    let netExtra = 0n;
    for (const entry of entries) netExtra += entry.extraCents;

    months.push({
      year,
      month,
      label: formatMonthAndYear(year, month),
      start,
      end,
      entries,
      netExtraCents: netExtra,
      isUnusual: entries.some((entry) => entry.extraCount !== 0),
    });

    cursor = nextMonth(year, month);
  }

  return months;
}

/** Only the months worth looking at, for a summary strip. */
export function unusualMonths(
  months: readonly ChequeCalendarMonth[],
): readonly ChequeCalendarMonth[] {
  return months.filter((month) => month.isUnusual);
}

/**
 * Build the mortgage's series from the pay schedule it follows.
 *
 * The mortgage is `relative_to_pay`: it comes out a fixed number of days after
 * a given person's payday. Shifting the anchor by that offset turns it into an
 * ordinary biweekly series - and it is precisely this shift that lets a month
 * hold three paycheques but two mortgage payments.
 */
/**
 * The mortgage as a fortnightly series, from its own payment dates.
 *
 * Use this when the lender set the dates. {@link mortgageSeriesFromPaySchedule}
 * is for the other case, where the payment chases a payday.
 */
export function mortgageSeries(options: {
  readonly id: string;
  readonly name: string;
  /** Any real payment date; the rest fall every fourteen days from it. */
  readonly anchorDate: PlainDate;
  /** The payment, as a positive magnitude; it is negated here. */
  readonly paymentCents: Cents;
}): BiweeklySeries {
  if (options.paymentCents < 0n) {
    throw new RangeError("Pass the mortgage payment as a positive magnitude; it is negated here.");
  }

  return {
    id: options.id,
    name: options.name,
    anchorDate: options.anchorDate,
    cents: -options.paymentCents,
  };
}

export function mortgageSeriesFromPaySchedule(options: {
  readonly id: string;
  readonly name: string;
  /** The payday anchor the mortgage follows. */
  readonly payAnchorDate: PlainDate;
  /** Days after the payday the money leaves. Usually 1. */
  readonly offsetDays: number;
  /** The payment, as a positive magnitude; it is negated here. */
  readonly paymentCents: Cents;
}): BiweeklySeries {
  if (!Number.isInteger(options.offsetDays)) {
    throw new RangeError(`offsetDays must be a whole number; received ${String(options.offsetDays)}.`);
  }

  // Delegates, so the negation and the guard live in one place.
  return mortgageSeries({
    id: options.id,
    name: options.name,
    anchorDate: addDays(options.payAnchorDate, options.offsetDays),
    paymentCents: options.paymentCents,
  });
}
