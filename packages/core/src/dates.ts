/**
 * Calendar dates, where only the day matters.
 *
 * Headroom's timezone is `America/Regina`, which has **no daylight saving**:
 * it sits at UTC−06:00 all year. That is the reason this module can do exact
 * integer arithmetic on year/month/day without a timezone library, and never
 * meet the usual "the day repeated / the day vanished" bugs.
 *
 * A `PlainDate` is the string `YYYY-MM-DD`. Strings in that form sort
 * lexicographically in true date order, which the timeline relies on.
 *
 * Nothing here reads the clock. The current date is always passed in, because
 * the server clock is authoritative (HANDOFF section 16.1 rule 10) and a pure
 * function is testable.
 */

/** A calendar date with no time and no zone: `YYYY-MM-DD`. */
export type PlainDate = string;

export const HEADROOM_TIMEZONE = "America/Regina";

const PLAIN_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

/** Parse `YYYY-MM-DD`, rejecting anything that is not a real calendar date. */
export function parseDate(value: PlainDate): DateParts {
  const match = PLAIN_DATE_PATTERN.exec(value);
  if (!match) {
    throw new SyntaxError(`"${value}" is not a date in YYYY-MM-DD form.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new RangeError(`"${value}" has no month ${month}.`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`"${value}" is not a real date: ${month}/${year} has ${daysInMonth(year, month)} days.`);
  }

  return { year, month, day };
}

/** True when the string is a real `YYYY-MM-DD` date. */
export function isPlainDate(value: string): value is PlainDate {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export function formatDate(parts: DateParts): PlainDate {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** How many days the given month has. */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new RangeError(`There is no month ${month}.`);
  }
}

/**
 * Days since 1970-01-01, computed in UTC.
 *
 * `Date.UTC` has no daylight saving of its own, so this is exact for every
 * date and is only ever used as an integer day counter.
 */
export function toEpochDay(value: PlainDate): number {
  const { year, month, day } = parseDate(value);
  // Math.round is restricted for money, which this is not: it is a day count,
  // and the rounding only guards against floating-point wobble in the
  // division. Date.UTC at midnight is always an exact multiple of a day.
  // eslint-disable-next-line no-restricted-properties
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromEpochDay(epochDay: number): PlainDate {
  const date = new Date(epochDay * 86_400_000);
  return formatDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

/** Add (or subtract) whole days. */
export function addDays(value: PlainDate, days: number): PlainDate {
  if (!Number.isInteger(days)) {
    throw new RangeError(`Can only add whole days; received ${String(days)}.`);
  }
  return fromEpochDay(toEpochDay(value) + days);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Compare as dates. Negative, zero or positive, for use as a sort key. */
export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: PlainDate, b: PlainDate): PlainDate {
  return a <= b ? a : b;
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return a >= b ? a : b;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayIndex(value: PlainDate): number {
  // 1970-01-01 was a Thursday (index 4).
  const day = (toEpochDay(value) + 4) % 7;
  return day < 0 ? day + 7 : day;
}

export function weekdayName(value: PlainDate): Weekday {
  return WEEKDAYS[weekdayIndex(value)] as Weekday;
}

export function isWeekend(value: PlainDate): boolean {
  const index = weekdayIndex(value);
  return index === 0 || index === 6;
}

/* -------------------------------------------------------------------------- */
/* Pay schedules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Biweekly paydays: every 14 days from an anchor, in both directions
 * (HANDOFF section 5 rule 1). Pay is **every two weeks**, not twice a month,
 * so a month can hold three cheques and that needs no special handling.
 */
export function isPaydayOn(anchorDate: PlainDate, candidate: PlainDate): boolean {
  const offset = daysBetween(anchorDate, candidate);
  return offset % 14 === 0;
}

/** The first payday on or after `from`. */
export function firstPaydayOnOrAfter(anchorDate: PlainDate, from: PlainDate): PlainDate {
  const offset = daysBetween(anchorDate, from);
  // Round up to the next multiple of 14, including negative offsets.
  const periods = Math.ceil(offset / 14);
  return addDays(anchorDate, periods * 14);
}

/** Paydays in `[from, to]`, in order. */
export function paydaysBetween(anchorDate: PlainDate, from: PlainDate, to: PlainDate): PlainDate[] {
  const result: PlainDate[] = [];
  let payday = firstPaydayOnOrAfter(anchorDate, from);
  while (compareDates(payday, to) <= 0) {
    result.push(payday);
    payday = addDays(payday, 14);
  }
  return result;
}

/** The next `count` paydays strictly after `from`, in order. */
export function nextPaydays(anchorDate: PlainDate, from: PlainDate, count: number): PlainDate[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative whole number; received ${String(count)}.`);
  }

  const result: PlainDate[] = [];
  let payday = firstPaydayOnOrAfter(anchorDate, from);
  if (compareDates(payday, from) === 0) payday = addDays(payday, 14);

  for (let i = 0; i < count; i += 1) {
    result.push(payday);
    payday = addDays(payday, 14);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Monthly schedules                                                          */
/* -------------------------------------------------------------------------- */

/** `day = "last"` covers the spreadsheet's "31st"-style bills. */
export type MonthlyDay = number | "last";

/** The date a monthly bill falls on in the given month. */
export function monthlyOccurrenceDate(year: number, month: number, day: MonthlyDay): PlainDate {
  const lastDay = daysInMonth(year, month);

  if (day === "last") {
    return formatDate({ year, month, day: lastDay });
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new RangeError(`A monthly day must be 1-31 or "last"; received ${String(day)}.`);
  }

  // A bill "on the 31st" comes out on the 30th in November, and on the 28th or
  // 29th in February.
  return formatDate({ year, month, day: Math.min(day, lastDay) });
}

/* -------------------------------------------------------------------------- */
/* Weekend handling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * HANDOFF section 14 question 8. The default, `as_scheduled`, reproduces the
 * spreadsheet and the golden fixture; the other two are offered as a household
 * setting because a bank may well move the withdrawal.
 */
export type WeekendRule = "as_scheduled" | "friday_before" | "next_business_day";

export function applyWeekendRule(value: PlainDate, rule: WeekendRule): PlainDate {
  if (rule === "as_scheduled" || !isWeekend(value)) return value;

  const index = weekdayIndex(value);

  if (rule === "friday_before") {
    // Saturday back 1, Sunday back 2.
    return addDays(value, index === 6 ? -1 : -2);
  }

  // next_business_day: Saturday forward 2, Sunday forward 1.
  return addDays(value, index === 6 ? 2 : 1);
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** `Sun, Nov 22`, the form the mockups use in chips and warnings. */
export function formatDateShort(value: PlainDate): string {
  const { month, day } = parseDate(value);
  const weekday = weekdayName(value).slice(0, 3);
  return `${weekday}, ${MONTHS_SHORT[month - 1]} ${day}`;
}

/** `Nov 22`, for places where the weekday is noise. */
export function formatDayAndMonth(value: PlainDate): string {
  const { month, day } = parseDate(value);
  return `${MONTHS_SHORT[month - 1]} ${day}`;
}
