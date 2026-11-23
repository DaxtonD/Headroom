/**
 * "Move Hydro to Dec 9 and it clears."
 *
 * Asked for on 2026-11-22, from what the household already does by hand: when
 * chequing runs low, one of them pushes a variable bill into a later pay
 * period and tells the other in the morning.
 *
 * ## What this contributes, and what it deliberately does not
 *
 * It contributes the **arithmetic**: which bill, moved to which payday, clears
 * the shortfall without breaking a later one. That is the part a person cannot
 * do in their head, because moving a bill lowers every balance after it and
 * the window it lands in has its own withdrawals to cover.
 *
 * It does **not** decide whether that bill can wait. A flexible item in this
 * model has no real due date - its date is "the day you plan to pay it", not a
 * day anybody is owed - so nothing here knows that hydro is due on the 18th.
 * The household does. So a suggestion is "here is what would clear it", never
 * "do this", and applying it is always a person's tap.
 *
 * That is a correction to an earlier plan, recorded because it changed the
 * shape of the feature: this was going to wait on an optional "not after" date
 * being added to flexible items. It does not need one. The only thing such a
 * date would buy is the app refusing a suggestion the person would have
 * refused anyway, and the cost was a schema change and a field on a form.
 *
 * ## The move it simulates is the move that will be made
 *
 * One edit, both fields: the row is anchored to a later paycheque and any date
 * it had is dropped, because a flexible row is placed one way or the other and
 * the engine refuses one that has both. That is exactly what the API's patch
 * route does, and simulating half of it would produce a suggestion that reads
 * as true and is not - either a row the engine will not accept, or one left
 * where it already was.
 *
 * ## Every suggestion is verified, not estimated
 *
 * Each candidate move is applied to the events and the **whole timeline is run
 * again**. A suggestion survives only if coverage then passes everywhere -
 * which is one check rather than two, because coverage already looks at every
 * automatic withdrawal to the horizon. Nothing is offered on the strength of
 * "this is about the right size".
 *
 * The engine is pure and a timeline is a single pass over a sorted list, so a
 * few dozen re-runs costs nothing worth measuring.
 */
import { compareDates } from "./dates.js";
import type { PlainDate } from "./dates.js";
import { computeTimeline } from "./timeline.js";
import type { Cents } from "./money.js";
import type { TimelineInput, TimelineRow } from "./types.js";

export interface MoveSuggestion {
  /** The row to move. */
  readonly eventId: string;
  readonly name: string;
  /** Where it would end up: the date of the paycheque it hangs off. */
  readonly toDate: PlainDate;
  /** The paycheque to hang it off, which is the edit a screen makes. */
  readonly toAnchorId: string;
  /** The withdrawal that stops being short. */
  readonly clearsEventId: string;
  readonly clearsName: string;
  /** How much this row is, as a positive magnitude. */
  readonly cents: Cents;
  /** The lowest the account would reach afterwards, to the horizon. */
  readonly lowestAfterCents: Cents;
}

export interface SuggestMovesOptions {
  readonly events: readonly TimelineInput[];
  readonly startBalanceCents: Cents;
  readonly cushionCents?: Cents;
  readonly accountId?: string | null;
  /** How many to return. Three is enough to choose from and not a list. */
  readonly limit?: number;
}

/**
 * The row as it would be after the move, exactly as the API would write it.
 *
 * **Both fields, and that is the whole subtlety.** A flexible row is placed
 * one way or the other - by a date it was given, or immediately after the
 * paycheque it hangs off - and the engine refuses a row that has both. So
 * anchoring one that had a date has to drop the date, which is precisely what
 * `toPrismaData` in `apps/api/src/routes/occurrences.ts` does on the
 * `anchorOccurrenceId` branch.
 *
 * Simulating only half of that edit would be the difference between a
 * suggestion that is true and one that reads as true: setting the anchor and
 * keeping the date leaves a row the engine will not accept, and setting the
 * date alone leaves it where it already was.
 */
function withMove(
  events: readonly TimelineInput[],
  row: TimelineRow,
  payday: TimelineInput,
): TimelineInput[] {
  return events.map((event) =>
    event.id === row.event.id ? { ...event, anchorId: payday.id, date: undefined } : event,
  );
}

/**
 * Moves that would clear the first uncovered withdrawal.
 *
 * Empty when nothing is short, which is the common case and is why this is
 * cheap to ask for on every load: the first timeline run answers it.
 */
export function suggestMoves(options: SuggestMovesOptions): readonly MoveSuggestion[] {
  const { events, startBalanceCents, cushionCents = 0n, accountId = null, limit = 3 } = options;

  const run = (list: readonly TimelineInput[]) =>
    computeTimeline({ events: list, startBalanceCents, cushionCents, accountId });

  const base = run(events);
  const short = base.coverage.firstShortfall;
  if (!short) return [];

  /*
   * Where a row can be moved TO: the dated paycheques, in order.
   *
   * Only ones the timeline actually holds, so every target is inside the
   * horizon - a move to a payday beyond it could not be verified, and an
   * unverified suggestion is the thing this module exists not to make.
   */
  const paydays = events
    .filter((event): event is TimelineInput & { date: PlainDate } =>
      event.kind === "paycheque" && event.date !== undefined && event.date !== null,
    )
    .sort((a, b) => compareDates(a.date, b.date));

  /*
   * Rows worth trying.
   *
   *  - flexible, because the bank has already chosen an automatic one's date
   *    and there is nothing to move;
   *  - unsettled, because settled money has gone;
   *  - actually draining THIS account, which a charge on a card does not,
   *    however flexible it is;
   *  - at or before the shortfall, since moving something that falls after it
   *    cannot put money back before it.
   */
  const candidates = base.rows.filter(
    (row) =>
      row.event.placement === "flexible" &&
      row.event.settled !== true &&
      row.deltaCents < 0n &&
      row.effectiveDate !== null &&
      (short.date === null || compareDates(row.effectiveDate, short.date) <= 0),
  );

  const found: MoveSuggestion[] = [];

  for (const row of candidates) {
    for (const payday of paydays) {
      // Later than where it is now, or it is not a move.
      if (compareDates(payday.date, row.effectiveDate as PlainDate) <= 0) continue;

      const after = run(withMove(events, row, payday));

      /*
       * One check, not two. Coverage passes only when every automatic
       * withdrawal to the horizon has its money - so this is simultaneously
       * "it clears the one that was short" and "it breaks nothing later",
       * which is the pair of questions a person cannot answer by looking.
       */
      if (!after.coverage.allCovered) continue;

      found.push({
        eventId: row.event.id,
        name: row.event.name,
        toDate: payday.date,
        toAnchorId: payday.id,
        clearsEventId: short.eventId,
        clearsName: short.name,
        cents: -row.deltaCents,
        lowestAfterCents: after.lowest.cents,
      });

      // The earliest payday that works. Moving a bill further than it needs
      // to go is a worse answer offered beside the better one.
      break;
    }
  }

  /*
   * Soonest first, then smallest.
   *
   * Both halves are "least disruption": a bill that only has to wait until
   * next week is a smaller ask than one pushed a month, and among moves to
   * the same day the small one is the easier yes. The id is the tiebreak, so
   * the list is identical on every render.
   */
  return found
    .sort(
      (a, b) =>
        compareDates(a.toDate, b.toDate) ||
        (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0) ||
        a.eventId.localeCompare(b.eventId),
    )
    .slice(0, limit);
}
