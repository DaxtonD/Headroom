/**
 * Where purchases come from, for now.
 *
 * Asked for on 2026-11-22, to replace a conversation the household was having
 * by hand. When chequing runs low, one of them tells the other in the morning
 * that necessary purchases go on the Visa until payday.
 *
 * ## What this is, and what it is not
 *
 * It is not a note pinned to the screen. The message was never the part that
 * failed - what failed was somebody forgetting and recording a purchase
 * against chequing anyway, at which point the ledger is wrong in the
 * direction that matters: chequing looks emptier than it is and the card
 * looks healthier. So the posture's real job is to be the **default source
 * account** on a new one-off. The banner is a consequence of it.
 *
 * ## Why it is in the engine
 *
 * Only one rule lives here, and it is the one that would otherwise be written
 * twice: **whether the posture is still in force**. The API needs it to decide
 * what to send, and the screen needs it to decide what to show, and if those
 * two disagreed the household would be told to use a card by a banner that
 * the one-off form had already stopped believing.
 *
 * It is also derived rather than stored, like every other figure in this app.
 * A boolean column saying "active" would be a second source of truth that
 * goes stale at midnight with nothing to notice.
 */
import { compareDates } from "./dates.js";
import type { PlainDate } from "./dates.js";

/**
 * The stored facts, exactly as the household row holds them.
 *
 * `accountId` null is the ordinary state - purchases come out of chequing -
 * and is the reason this whole type is nullable nowhere else: absent and
 * "chequing" are the same thing, so there is no third state to represent.
 */
export interface SpendFromFacts {
  readonly accountId: string | null;
  /** The last day it applies, inclusive. */
  readonly until: PlainDate | null;
}

/**
 * Is it still in force today?
 *
 * Inclusive of `until`: a posture set "until Friday" is in force on Friday.
 * That is how somebody says it out loud, and the alternative - quietly
 * dropping it the morning of the day they named - is the kind of
 * off-by-one-day that would only ever be noticed as money in the wrong place.
 *
 * A posture with no end date is **not** in force. That looks strict, and it
 * is deliberate: the route always sets an end when it sets an account, so a
 * row with one and not the other is damage rather than a choice, and the safe
 * reading of damage is the ordinary state. Treating it as open-ended would
 * put the household on card spending for ever because of a half-written row.
 */
export function spendFromIsActive(facts: SpendFromFacts, today: PlainDate): boolean {
  if (facts.accountId === null || facts.until === null) return false;
  return compareDates(today, facts.until) <= 0;
}
