/**
 * Two-week pay periods (HANDOFF section 6.4).
 *
 * Pay is biweekly, not twice a month, so a period is a dated fourteen-day
 * window anchored on one person's paydays, and each window holds one cheque
 * from each person. A month with a third cheque needs no special handling.
 *
 * One subtlety worth knowing: a window can reach past the timeline's horizon.
 * The last window therefore counts a cheque that is **projected** from the pay
 * schedule rather than placed as an occurrence, so "left over" for that window
 * is still meaningful. Those cheques never touch the running balances, which
 * stop at the horizon; `projectedPaychequeIds` says which they were.
 */
import {
  addDays,
  compareDates,
  firstPaydayOnOrAfter,
  formatDayAndMonth,
  parseDate,
  paydaysBetween,
} from "./dates.js";
import type { PlainDate } from "./dates.js";
import type { Cents } from "./money.js";
import type {
  PayPeriod,
  PayPeriodLowest,
  PayPeriodOptions,
  PaySchedule,
  TimelineRow,
} from "./types.js";

const PERIOD_DAYS = 14;
const DEFAULT_PERIOD_COUNT = 3;

/**
 * "Nov 12-25" within a month, "Nov 26-Dec 9" across one. Matches the period
 * chips in the mockups.
 */
function periodLabel(start: PlainDate, end: PlainDate): string {
  const startParts = parseDate(start);
  const endParts = parseDate(end);

  if (startParts.year === endParts.year && startParts.month === endParts.month) {
    return `${formatDayAndMonth(start)}-${endParts.day}`;
  }
  return `${formatDayAndMonth(start)}-${formatDayAndMonth(end)}`;
}

function withinWindow(date: PlainDate, start: PlainDate, end: PlainDate): boolean {
  return compareDates(date, start) >= 0 && compareDates(date, end) <= 0;
}

/** The schedule the windows are anchored on. */
function resolveAnchorSchedule(
  paySchedules: readonly PaySchedule[],
  anchorScheduleId: string | undefined,
): PaySchedule {
  if (paySchedules.length === 0) {
    throw new Error("Pay periods need at least one pay schedule to anchor on.");
  }

  if (anchorScheduleId !== undefined) {
    const found = paySchedules.find((schedule) => schedule.id === anchorScheduleId);
    if (!found) {
      throw new Error(`No pay schedule with id "${anchorScheduleId}" to anchor the periods on.`);
    }
    return found;
  }

  // With no choice stated, use the earliest anchor date, deterministically.
  return [...paySchedules].sort(
    (a, b) => compareDates(a.anchorDate, b.anchorDate) || a.id.localeCompare(b.id),
  )[0] as PaySchedule;
}

interface WindowSpec {
  readonly start: PlainDate;
  readonly end: PlainDate;
  readonly isCurrentPartial: boolean;
}

/**
 * The windows to report: a partial one from today to the day before the next
 * anchor payday (when today is not itself a payday), then full fourteen-day
 * windows.
 */
export function payPeriodWindows(
  today: PlainDate,
  anchorSchedule: PaySchedule,
  periodCount: number,
): WindowSpec[] {
  const nextPayday = firstPaydayOnOrAfter(anchorSchedule.anchorDate, today);
  const windows: WindowSpec[] = [];

  if (compareDates(nextPayday, today) > 0) {
    windows.push({ start: today, end: addDays(nextPayday, -1), isCurrentPartial: true });
  }

  let start = nextPayday;
  while (windows.length < periodCount) {
    windows.push({ start, end: addDays(start, PERIOD_DAYS - 1), isCurrentPartial: false });
    start = addDays(start, PERIOD_DAYS);
  }

  return windows;
}

/**
 * Summarise each window: what comes in, what goes out automatically, what is
 * flexible, and what is left.
 */
export function computePayPeriods(options: PayPeriodOptions): PayPeriod[] {
  const { timeline, paySchedules, today } = options;
  const cushionCents = options.cushionCents ?? 0n;
  const periodCount = options.periodCount ?? DEFAULT_PERIOD_COUNT;
  const anchorSchedule = resolveAnchorSchedule(paySchedules, options.anchorScheduleId);

  const windows = payPeriodWindows(today, anchorSchedule, periodCount);

  // Which scheduled paydays already exist as placed paycheques, so they are
  // not counted twice. Matched by schedule when the data says which schedule a
  // cheque came from, and by date otherwise.
  const placedByScheduleAndDate = new Set<string>();
  const unclaimedByDate = new Map<PlainDate, number>();

  for (const row of timeline.rows) {
    if (row.event.kind !== "paycheque" || !row.effectiveDate) continue;
    if (row.event.payScheduleId) {
      placedByScheduleAndDate.add(`${row.event.payScheduleId}|${row.effectiveDate}`);
    } else {
      unclaimedByDate.set(row.effectiveDate, (unclaimedByDate.get(row.effectiveDate) ?? 0) + 1);
    }
  }

  const claimUnplacedPaycheque = (schedule: PaySchedule, payday: PlainDate): boolean => {
    if (placedByScheduleAndDate.has(`${schedule.id}|${payday}`)) return true;

    const unclaimed = unclaimedByDate.get(payday) ?? 0;
    if (unclaimed > 0) {
      unclaimedByDate.set(payday, unclaimed - 1);
      return true;
    }
    return false;
  };

  return windows.map((window) => {
    const rows = timeline.rows.filter((row) => {
      if (row.effectiveDate === null) {
        // Anchored to "now": it belongs to the current partial window, which
        // is where "before the first upcoming paycheque" means.
        return window.isCurrentPartial;
      }
      return withinWindow(row.effectiveDate, window.start, window.end);
    });

    let inCents = 0n;
    let autoCents = 0n;
    let flexibleCents = 0n;

    // The current partial window opens with whatever is in the account, which
    // is what "coming in" means for a window that starts today.
    if (window.isCurrentPartial) {
      inCents += timeline.startBalanceCents;
    }

    for (const row of rows) {
      const cents = row.event.cents;
      if (cents > 0n) {
        inCents += cents;
      } else if (row.event.placement === "auto") {
        autoCents -= cents;
      } else {
        flexibleCents -= cents;
      }
    }

    // Cheques due in this window that are not placed on the timeline yet.
    const projectedPaychequeIds: string[] = [];
    for (const schedule of paySchedules) {
      for (const payday of paydaysBetween(schedule.anchorDate, window.start, window.end)) {
        if (claimUnplacedPaycheque(schedule, payday)) continue;
        inCents += schedule.defaultCents;
        projectedPaychequeIds.push(`${schedule.id}|${payday}`);
      }
    }

    const lowest = lowestInWindow(rows);
    const autoRows = rows.filter((row) => row.requiresCoverage);

    return {
      label: window.isCurrentPartial ? `Now-${formatDayAndMonth(window.end)}` : periodLabel(window.start, window.end),
      start: window.start,
      end: window.end,
      isCurrentPartial: window.isCurrentPartial,
      inCents,
      autoCents,
      flexibleCents,
      leftCents: inCents - autoCents - flexibleCents,
      lowest,
      allAutoCovered: autoRows.every((row) => row.runningCents >= cushionCents),
      projectedPaychequeIds,
    } satisfies PayPeriod;
  });
}

/**
 * The lowest running balance reached inside the window.
 *
 * Deliberately only the rows in the window: the balance carried in from the
 * previous window is that window's story, not this one's.
 */
function lowestInWindow(rows: readonly TimelineRow[]): PayPeriodLowest | null {
  let lowest: PayPeriodLowest | null = null;

  for (const row of rows) {
    if (lowest === null || row.runningCents < lowest.cents) {
      lowest = { cents: row.runningCents, date: row.effectiveDate, afterEventId: row.event.id };
    }
  }

  return lowest;
}

/**
 * The horizon for "left this cycle" (section 6.3 and 14 q7): through the day
 * before the Nth upcoming paycheque, counting every person's cheques.
 *
 * The default of 4 reproduces the spreadsheet's end date.
 */
export function computeHorizonEnd(options: {
  readonly today: PlainDate;
  readonly paySchedules: readonly PaySchedule[];
  readonly paychequeCount?: number;
}): PlainDate {
  const count = options.paychequeCount ?? 4;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`The horizon needs a whole number of paycheques; received ${String(count)}.`);
  }
  if (options.paySchedules.length === 0) {
    throw new Error("The horizon needs at least one pay schedule.");
  }

  // Every upcoming payday from every schedule, in order, deduplicated by date
  // only when the same date appears twice for the same schedule.
  const paydays: PlainDate[] = [];
  const horizonSearchEnd = addDays(options.today, 14 * (count + 2));

  for (const schedule of options.paySchedules) {
    for (const payday of paydaysBetween(schedule.anchorDate, options.today, horizonSearchEnd)) {
      // "Upcoming" means strictly after today: a cheque arriving today is
      // already in the balance the user typed in.
      if (compareDates(payday, options.today) > 0) paydays.push(payday);
    }
  }

  paydays.sort(compareDates);

  const nth = paydays[count - 1];
  if (nth === undefined) {
    throw new Error(`Could not find ${count} upcoming paycheques within the search window.`);
  }

  return addDays(nth, -1);
}

/** Total of a window's figures, for the summary strip. */
export function sumPayPeriods(periods: readonly PayPeriod[]): {
  inCents: Cents;
  autoCents: Cents;
  flexibleCents: Cents;
  leftCents: Cents;
} {
  let inCents = 0n;
  let autoCents = 0n;
  let flexibleCents = 0n;

  for (const period of periods) {
    inCents += period.inCents;
    autoCents += period.autoCents;
    flexibleCents += period.flexibleCents;
  }

  return { inCents, autoCents, flexibleCents, leftCents: inCents - autoCents - flexibleCents };
}
