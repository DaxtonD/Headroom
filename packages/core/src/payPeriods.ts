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
  /**
   * Keep adding windows until one reaches this date.
   *
   * The windows have to cover the whole timeline or rows fall off the end of
   * the last one and are counted by nothing. Three windows happen to outrun
   * the default horizon, but the horizon is an editable household setting:
   * raise it and a dated row beyond the last window would vanish from the
   * ledger while still lowering every balance on it. Passing the horizon here
   * removes that dependence on a coincidence.
   */
  coverThrough?: PlainDate,
): WindowSpec[] {
  const nextPayday = firstPaydayOnOrAfter(anchorSchedule.anchorDate, today);
  const windows: WindowSpec[] = [];

  if (compareDates(nextPayday, today) > 0) {
    windows.push({ start: today, end: addDays(nextPayday, -1), isCurrentPartial: true });
  }

  const covers = (): boolean => {
    if (coverThrough === undefined) return true;
    const last = windows[windows.length - 1];
    return last !== undefined && compareDates(last.end, coverThrough) >= 0;
  };

  let start = nextPayday;
  // A ceiling as well, so a horizon set absurdly far out cannot run away.
  const MAX_WINDOWS = 60;
  while ((windows.length < periodCount || !covers()) && windows.length < MAX_WINDOWS) {
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

  const windows = payPeriodWindows(today, anchorSchedule, periodCount, options.coverThrough);

  // Which scheduled paydays already have a cheque, so they are not counted
  // twice. Matched by schedule when the data says which schedule a cheque came
  // from, and by date otherwise.
  const placedByScheduleAndDate = new Set<string>();
  const unclaimedByDate = new Map<PlainDate, number>();

  const note = (scheduleId: string | null | undefined, date: PlainDate): void => {
    if (scheduleId) {
      placedByScheduleAndDate.add(`${scheduleId}|${date}`);
    } else {
      unclaimedByDate.set(date, (unclaimedByDate.get(date) ?? 0) + 1);
    }
  };

  for (const row of timeline.rows) {
    if (row.event.kind !== "paycheque" || !row.effectiveDate) continue;
    note(row.event.payScheduleId, row.effectiveDate);
  }

  /*
   * A cheque that has already been received counts as placed too.
   *
   * It is not on the timeline - clearing it folded the money into the balance
   * and took the row off (section 6.1) - but it exists, it has arrived, and
   * projecting a second one for the same payday counts the same pay twice.
   */
  for (const received of options.receivedPaycheques ?? []) {
    note(received.scheduleId, received.date);
  }

  /** Paydays the household has turned the pay off for: nothing is coming. */
  const silenced = new Set(options.paydaysWithoutPay ?? []);

  const claimUnplacedPaycheque = (schedule: PaySchedule, payday: PlainDate): boolean => {
    if (placedByScheduleAndDate.has(`${schedule.id}|${payday}`)) return true;

    const unclaimed = unclaimedByDate.get(payday) ?? 0;
    if (unclaimed > 0) {
      unclaimedByDate.set(payday, unclaimed - 1);
      return true;
    }
    return false;
  };

  /**
   * Which window a row belongs to.
   *
   * The first window absorbs anything earlier than itself, and that is not a
   * nicety. The timeline deliberately keeps a dated item that is past and has
   * not cleared - the money has not moved yet, so it is still coming - and it
   * keeps undated items anchored to "now". Neither has a date inside any
   * window, so both used to belong to no window at all: left out of the rows
   * AND out of the totals, while still being subtracted from the running
   * balance and from safe-to-spend. A bill overdue by a week vanished from the
   * pay plan while still lowering every figure on it.
   *
   * Attributing them to the first window is also the truthful answer: an
   * overdue bill comes out of the money in hand, which is what the first
   * window holds.
   */
  const firstWindow = windows[0];
  const belongsTo = (row: TimelineRow, window: WindowSpec): boolean => {
    const isFirst = firstWindow !== undefined && window === firstWindow;

    if (row.effectiveDate === null) return isFirst;
    if (isFirst && compareDates(row.effectiveDate, window.start) < 0) return true;
    return withinWindow(row.effectiveDate, window.start, window.end);
  };

  return windows.map((window) => {
    const rows = timeline.rows.filter((row) => belongsTo(row, window));

    const roomToSaveCents = roomToSaveFrom(timeline, window, cushionCents);

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

    // Cheques due in this window that are not written down anywhere yet.
    const projectedPaychequeIds: string[] = [];
    for (const schedule of paySchedules) {
      if (silenced.has(schedule.id)) continue;
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
      roomToSaveCents,
      /**
       * The rows this window counted, by id.
       *
       * Published so a caller grouping rows for display uses the same decision
       * the totals were computed from. The API used to re-derive membership
       * from the dates, which is the same rule written twice - and the two
       * disagreed the moment this one was corrected.
       */
      rowIds: rows.map((row) => row.event.id),
    } satisfies PayPeriod;
  });
}

/**
 * The lowest the balance gets from `start` onwards, minus the cushion.
 *
 * Moving money out of chequing lowers every balance after it, so the most that
 * can safely leave during a period is the floor of the whole remaining
 * timeline, not just the floor inside that period. This deliberately looks
 * past the window's own end.
 *
 * Note the contrast with {@link lowestInWindow}, which stops at the window
 * edge because it is answering a different question: "how tight does this
 * fortnight get", not "what can leave without breaking something later".
 */
function roomToSaveFrom(
  timeline: PayPeriodOptions["timeline"],
  window: WindowSpec,
  cushionCents: Cents,
): Cents {
  const rows = timeline.rows;

  // The first row this window or a later one owns. A row anchored to "now" has
  // no date and belongs to the current partial window, so for any window after
  // that one it is already in the past.
  let startIndex = rows.findIndex((row) =>
    row.effectiveDate === null
      ? window.isCurrentPartial
      : compareDates(row.effectiveDate, window.start) >= 0,
  );
  if (startIndex === -1) startIndex = rows.length;

  // Nothing ahead: the balance carried into the window is all the room there
  // is, because no later event can lower it.
  if (startIndex >= rows.length) {
    const entering =
      startIndex === 0
        ? timeline.startBalanceCents
        : (rows[startIndex - 1] as TimelineRow).runningCents;
    return entering - cushionCents;
  }

  let floor = (rows[startIndex] as TimelineRow).runningCents;
  for (let index = startIndex + 1; index < rows.length; index += 1) {
    const running = (rows[index] as TimelineRow).runningCents;
    if (running < floor) floor = running;
  }

  // The current window is the only one that starts right now, so it is the
  // only one bounded by what is in the account today. A later window is
  // bounded by its own events instead: by the time anyone acts inside it, its
  // paycheque has already landed, and holding it to today's balance would
  // understate the room enough to make the figure useless.
  if (window.isCurrentPartial && timeline.startBalanceCents < floor) {
    floor = timeline.startBalanceCents;
  }

  return floor - cushionCents;
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
