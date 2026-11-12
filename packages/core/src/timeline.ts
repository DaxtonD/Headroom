/**
 * The timeline: "the way the bank sees it" (HANDOFF section 6.2 and 6.3).
 *
 * This is the heart of Headroom. Everything Carol checks all day comes out of
 * here: the running balance on every line, the lowest point before the next
 * payday, what is safe to spend, and whether every automatic withdrawal is
 * covered.
 *
 * None of it is ever stored. Facts go in the database; these numbers are
 * derived on demand (section 16.1 rule 5).
 */
import { compareDates } from "./dates.js";
import type { PlainDate } from "./dates.js";
import { minCents, sumCents, type Cents } from "./money.js";
import type {
  Coverage,
  LowestPoint,
  Shortfall,
  TimelineInput,
  TimelineOptions,
  TimelineResult,
  TimelineRow,
} from "./types.js";

/**
 * Sort rank within a single day, from HANDOFF section 6.2:
 * a paycheque lands first, then the flexible items hanging off it, then the
 * other dated items.
 */
const RANK_PAYCHEQUE = 0;
const RANK_FLEXIBLE = 1;
const RANK_OTHER_DATED = 2;

/**
 * A date that sorts before every real one, for flexible items anchored to
 * "now". They sit before the first upcoming paycheque.
 */
const BEFORE_EVERYTHING = "0000-00-00";

function isAutoWithdrawal(event: TimelineInput): boolean {
  // Coverage is about money leaving on a date the bank has already chosen.
  // Paycheques and automatic deposits are dated too, but they bring money in,
  // so there is nothing to cover. A settled item has already left, so there is
  // nothing to cover either.
  return event.placement === "auto" && event.cents < 0n && event.settled !== true;
}

/**
 * Order the events the way the bank would apply them.
 *
 * 1. Dated items by date.
 * 2. A flexible item with a date of its own by that date - the day the
 *    household plans to pay it.
 * 3. A flexible item without one immediately after its anchor paycheque, in
 *    user order. An item anchored to "now" comes before everything.
 * 4. On the same day: paycheque, then flexible items, then other dated items.
 *
 * This differs from the spreadsheet's row order in one place (a bill the sheet
 * lists under an earlier cheque but which the bank takes on its own date), and
 * the end totals are identical either way.
 */
export function orderTimeline(events: readonly TimelineInput[]): TimelineInput[] {
  const paychequeDates = new Map<string, PlainDate>();
  for (const event of events) {
    if (event.kind === "paycheque" && event.date) {
      paychequeDates.set(event.id, event.date);
    }
  }

  interface Keyed {
    readonly event: TimelineInput;
    readonly sortDate: string;
    readonly rank: number;
    readonly sortIndex: number;
    readonly position: number;
  }

  const keyed: Keyed[] = events.map((event, position) => {
    if (event.placement === "auto") {
      if (!event.date) {
        throw new Error(
          `"${event.name}" (${event.id}) is placed by date but has no date. An automatic withdrawal must have one.`,
        );
      }
      return {
        event,
        sortDate: event.date,
        rank: event.kind === "paycheque" ? RANK_PAYCHEQUE : RANK_OTHER_DATED,
        sortIndex: event.sortIndex ?? 0,
        position,
      };
    }

    /*
     * A flexible item may have a date: "monthly, but I choose when to pay it"
     * with a day chosen. It still ranks as flexible, so it sits under the
     * cheque it shares a day with and is never counted as something the bank
     * will take whether or not the money is there.
     */
    if (event.date) {
      if (event.anchorId) {
        throw new Error(
          `"${event.name}" (${event.id}) has both a date and an anchor paycheque. A flexible item is placed one way or the other.`,
        );
      }
      return {
        event,
        sortDate: event.date,
        rank: RANK_FLEXIBLE,
        sortIndex: event.sortIndex ?? 0,
        position,
      };
    }

    const anchorId = event.anchorId ?? null;
    if (anchorId === null) {
      return { event, sortDate: BEFORE_EVERYTHING, rank: RANK_FLEXIBLE, sortIndex: event.sortIndex ?? 0, position };
    }

    const anchorDate = paychequeDates.get(anchorId);
    if (anchorDate === undefined) {
      throw new Error(
        `"${event.name}" (${event.id}) is anchored to "${anchorId}", which is not a paycheque in this timeline.`,
      );
    }

    return { event, sortDate: anchorDate, rank: RANK_FLEXIBLE, sortIndex: event.sortIndex ?? 0, position };
  });

  keyed.sort((a, b) => {
    const byDate = compareDates(a.sortDate, b.sortDate);
    if (byDate !== 0) return byDate;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
    // Stable: equal keys keep the order they arrived in.
    return a.position - b.position;
  });

  return keyed.map((entry) => entry.event);
}

/**
 * The date a row effectively sits on.
 *
 * A flexible item with a planned date sits on it. One without borrows its
 * anchor paycheque's date, because that is when the bank would see it.
 */
function effectiveDateOf(
  event: TimelineInput,
  paychequeDates: ReadonlyMap<string, PlainDate>,
): PlainDate | null {
  if (event.date) return event.date;
  if (event.placement === "auto") return null;
  const anchorId = event.anchorId ?? null;
  if (anchorId === null) return null;
  return paychequeDates.get(anchorId) ?? null;
}

/**
 * Build the timeline and everything derived from it.
 *
 * `startBalanceCents` is the **effective** current balance: the latest
 * snapshot plus anything cleared since (section 6.1).
 *
 * An item the balance already accounts for may still be passed in, marked
 * `settled`: it is shown and ordered like any other row and counted in
 * nothing, because a ledger that hides what has been paid is no use to the
 * person reading it.
 */
export function computeTimeline(options: TimelineOptions): TimelineResult {
  const cushionCents = options.cushionCents ?? 0n;
  const ordered = orderTimeline(options.events);

  const paychequeDates = new Map<string, PlainDate>();
  for (const event of ordered) {
    if (event.kind === "paycheque" && event.date) paychequeDates.set(event.id, event.date);
  }

  const rows: TimelineRow[] = [];
  let running = options.startBalanceCents;

  for (const event of ordered) {
    // A settled row is history: the balance this timeline starts from already
    // includes it, so adding it here would subtract the same bill twice.
    if (event.settled !== true) running += event.cents;
    rows.push({
      event,
      runningCents: running,
      effectiveDate: effectiveDateOf(event, paychequeDates),
      requiresCoverage: isAutoWithdrawal(event),
    });
  }

  // ---- Lowest point -------------------------------------------------------
  // The starting balance counts: if the account is at its lowest right now,
  // that is the answer, and there is no event to blame it on.
  let lowest: LowestPoint = { cents: options.startBalanceCents, afterEventId: null, date: null };
  for (const row of rows) {
    if (row.runningCents < lowest.cents) {
      lowest = {
        cents: row.runningCents,
        afterEventId: row.event.id,
        date: row.effectiveDate,
      };
    }
  }

  // ---- Coverage -----------------------------------------------------------
  // Spending now lowers every later balance, so what is safe to spend is the
  // lowest point over the whole horizon, less the cushion (section 6.3).
  const autoRows = rows.filter((row) => row.requiresCoverage);
  let firstShortfall: Shortfall | null = null;

  for (const row of autoRows) {
    if (row.runningCents < cushionCents) {
      firstShortfall = {
        eventId: row.event.id,
        name: row.event.name,
        date: row.effectiveDate,
        shortCents: cushionCents - row.runningCents,
        runningCents: row.runningCents,
      };
      break;
    }
  }

  const coverage: Coverage = {
    autoWithdrawalCount: autoRows.length,
    allCovered: firstShortfall === null,
    firstShortfall,
  };

  // An amount nobody has confirmed yet is still a guess, and the UI says so.
  const estimatesCount = ordered.filter(
    (event) => event.kind === "bill" && event.verified !== true && event.settled !== true,
  ).length;

  const lastRow = rows.at(-1);

  return {
    rows,
    startBalanceCents: options.startBalanceCents,
    leftThisCycleCents: lastRow ? lastRow.runningCents : options.startBalanceCents,
    lowest,
    safeToSpendNowCents: lowest.cents - cushionCents,
    coverage,
    estimatesCount,
  };
}

/**
 * The effective current balance (section 6.1): the balance the user typed in,
 * plus every occurrence cleared after that snapshot was taken.
 *
 * Entering a new snapshot resets this, which is why the snapshot's own time is
 * the cut-off.
 */
export function effectiveBalance(
  snapshotCents: Cents,
  clearedSinceSnapshot: readonly Cents[],
): Cents {
  return snapshotCents + sumCents(clearedSinceSnapshot);
}

/**
 * The lowest balance between two rows of the timeline, inclusive. Used for the
 * "lowest balance inside this window" figure on the Pay plan screen.
 */
export function lowestWithin(
  rows: readonly TimelineRow[],
  openingCents: Cents,
): { cents: Cents; date: PlainDate | null; afterEventId: string | null } {
  let cents = openingCents;
  let date: PlainDate | null = null;
  let afterEventId: string | null = null;

  for (const row of rows) {
    if (row.runningCents < cents) {
      cents = row.runningCents;
      date = row.effectiveDate;
      afterEventId = row.event.id;
    }
  }

  return { cents, date, afterEventId };
}

/** Convenience: the smallest of a set of balances. */
export function lowestOf(values: readonly Cents[]): Cents {
  if (values.length === 0) throw new RangeError("No balances to compare.");
  return values.reduce((low, value) => minCents(low, value), values[0] as Cents);
}
