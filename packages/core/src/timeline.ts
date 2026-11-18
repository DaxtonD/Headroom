/**
 * The timeline: "the way the bank sees it" (HANDOFF section 6.2 and 6.3).
 *
 * This is the heart of Headroom. Everything the household checks all day comes
 * out of here: the running balance on every line, the lowest point before the
 * next payday, what is safe to spend, and whether every automatic withdrawal
 * is covered.
 *
 * None of it is ever stored. Facts go in the database; these numbers are
 * derived on demand (section 16.1 rule 5).
 */
import { compareDates } from "./dates.js";
import type { PlainDate } from "./dates.js";
import { minCents, sumCents, type Cents } from "./money.js";
import type {
  AccountMove,
  Coverage,
  LowestPoint,
  Shortfall,
  TimelineBreakdown,
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

/**
 * How much one move changes one account's balance. The only place in Headroom
 * that decides the sign of anything between accounts.
 *
 * Ordinary double entry: the amount leaves the source and arrives in the
 * destination. `cents` is signed as the ledger stores it - a bill is negative
 * - so the source gets `cents` and the destination gets its negation.
 *
 *   A charge on a card:      from card,     no destination,  cents -9500
 *     the card's balance falls by 9500 and chequing is untouched.
 *   A payment toward a card: from chequing, to the card,     cents -40000
 *     chequing falls by 40000 and the card rises by 40000.
 *
 * A credit card is projected as an ordinary signed balance where owing money
 * is a negative one. That is what lets a single engine run every account: the
 * flip to "owed" happens once, at the edge, for display. No sign convention is
 * special-cased in here.
 *
 * `settled` is deliberately ignored. The API applies this same rule to rows
 * that have already settled, in order to add them to the typed-in figure they
 * came after, and the timeline zeroes them separately. Two callers, two
 * intentions, one set of signs.
 *
 * There is no default source. An absent one is null, which matches a
 * projection of null - the single-account case every caller used before this
 * existed - and matches nothing else. The alternative, "absent means whichever
 * account is being projected", reads every ordinary chequing bill as money
 * leaving the card while the card is the one being projected, and is wrong by
 * the entire chequing ledger. {@link computeTimeline} refuses that input
 * rather than defaulting it.
 */
export function accountDelta(move: AccountMove, accountId: string | null): Cents {
  const from = move.fromAccountId ?? null;
  const to = move.toAccountId ?? null;

  let delta = 0n;
  if (from === accountId) delta += move.cents;
  // An absent destination is not this account. The money was spent rather
  // than moved, and `null === null` must not read as "arrives here".
  if (to !== null && to === accountId) delta -= move.cents;
  return delta;
}

/** Whether this row moves the projected account at all, whatever the amount. */
function touchesAccount(event: TimelineInput, accountId: string | null): boolean {
  const from = event.fromAccountId ?? null;
  const to = event.toAccountId ?? null;
  return from === accountId || (to !== null && to === accountId);
}

function isAutoWithdrawal(event: TimelineInput, deltaCents: Cents): boolean {
  // Coverage is about money leaving on a date the bank has already chosen.
  // Paycheques and automatic deposits are dated too, but they bring money in,
  // so there is nothing to cover.
  //
  // A settled withdrawal has already gone. Asking whether the account can
  // cover it is asking about the past, and answering "no" would raise a
  // shortfall over money that left days ago without incident. A charge on
  // another account has the same nothing to cover here, for a different
  // reason - and both arrive as a delta of zero.
  return event.placement === "auto" && deltaCents < 0n;
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
 * snapshot plus anything cleared since (section 6.1). Cleared items must
 * already be gone from `events`; they have left the timeline.
 */
export function computeTimeline(options: TimelineOptions): TimelineResult {
  const cushionCents = options.cushionCents ?? 0n;
  const accountId = options.accountId ?? null;

  /*
   * Name an account to project and every row has to say where it comes from.
   *
   * Silence cannot mean "this account", because the same events are run once
   * per account: a chequing bill would read as leaving whichever card was
   * being projected at the time. The household's money is not worth a
   * convenient default, so this is an error rather than a guess.
   */
  if (accountId !== null) {
    const homeless = options.events.find((event) => (event.fromAccountId ?? null) === null);
    if (homeless) {
      throw new Error(
        `"${homeless.name}" (${homeless.id}) has no source account, and this timeline projects one account in particular. Every row needs to say which account its money leaves.`,
      );
    }
  }

  const ordered = orderTimeline(options.events);

  const paychequeDates = new Map<string, PlainDate>();
  for (const event of ordered) {
    if (event.kind === "paycheque" && event.date) paychequeDates.set(event.id, event.date);
  }

  const rows: TimelineRow[] = [];
  let running = options.startBalanceCents;

  for (const event of ordered) {
    /*
     * Two kinds of row move nothing here, and both are still shown.
     *
     * A settled row is history: the balance this timeline opens with has
     * already been past it, and adding it again would take the same bill out
     * twice. A row belonging to another account never moves this one at all -
     * a charge on a credit card is the case that matters, and it is exactly
     * why the chequing forecast stopped falling for money that never left
     * chequing.
     *
     * Either way the row is pushed, so it is still ordered and still on
     * screen, and `runningCents` carries straight through it - which is what
     * makes a column of them read as "nothing moved here" rather than as a
     * gap. A bill that vanishes the moment it is dealt with is a bill nobody
     * can check.
     */
    const deltaCents = event.settled === true ? 0n : accountDelta(event, accountId);
    running += deltaCents;
    rows.push({
      event,
      deltaCents,
      runningCents: running,
      effectiveDate: effectiveDateOf(event, paychequeDates),
      requiresCoverage: isAutoWithdrawal(event, deltaCents),
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

  /*
   * An amount nobody has confirmed yet is still a guess, and the UI says so.
   *
   * A settled bill is not a guess about the future whatever its amount says:
   * the money is gone and the figure at the top already reflects it. Nor is a
   * bill on another account a guess about THIS one - each account counts its
   * own, so an unverified card charge is reported against the card.
   *
   * Membership is tested rather than the delta, because a bill of exactly zero
   * on this account is the very thing worth flagging: an amount nobody has
   * filled in yet.
   */
  const estimatesCount = ordered.filter(
    (event) =>
      event.kind === "bill" &&
      event.verified !== true &&
      event.settled !== true &&
      touchesAccount(event, accountId),
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
 * Break a computed timeline into the parts that explain its headline figures.
 *
 * For an info button: "where did that number come from?" is a fair question
 * about a figure nobody can check by hand, and the honest answer is the same
 * arithmetic the app did. So this decomposes what `computeTimeline` already
 * produced rather than computing anything again - the explanation and the
 * figure cannot drift apart, because there is only one set of rows behind
 * both.
 *
 * `outCents` is a positive magnitude, because an explanation reads better as
 * "less $3,000.00 going out" than as "plus minus three thousand".
 */
export function summariseTimeline(result: TimelineResult): TimelineBreakdown {
  let inCents = 0n;
  let inCount = 0;
  let outCents = 0n;
  let outCount = 0;

  for (const row of result.rows) {
    // The row's effect on THIS account, not its face value. Otherwise the
    // explanation adds up a card charge the headline figure never counted,
    // and `endCents` stops matching the last running balance - which is the
    // one thing an explain panel must never do.
    const cents = row.deltaCents;
    if (cents > 0n) {
      inCents += cents;
      inCount += 1;
    } else if (cents < 0n) {
      outCents -= cents;
      outCount += 1;
    }
  }

  const lowestAfterName =
    result.lowest.afterEventId === null
      ? null
      : (result.rows.find((row) => row.event.id === result.lowest.afterEventId)?.event.name ??
        null);

  return {
    startBalanceCents: result.startBalanceCents,
    inCents,
    inCount,
    outCents,
    outCount,
    endCents: result.startBalanceCents + inCents - outCents,
    lowestAfterName,
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
