/**
 * What the room to save is actually for.
 *
 * Asked for on 2026-11-22: "a blanket 'room to save' doesn't cover all
 * scenarios. Our household is really trying to save to make lump-sum payments
 * to the mortgage and for vacations, but that doesn't mean every spare dollar
 * is to be allocated to savings."
 *
 * ## The distinction the whole module rests on
 *
 * **What can safely leave is arithmetic. Where it should go is policy.** Those
 * are two computations and jamming them into one number is why the figure felt
 * wrong: `roomToSaveFrom` answers the first - the most that could leave
 * chequing without something later going short - and it was being shown in the
 * one place and the one type size that make it read as an answer to the
 * second.
 *
 * So the constraint is not touched. This sits above it and says what the
 * household has decided to do with it, from figures they set: an intent per
 * payday, per goal. The remainder is named **unallocated**, and that name is
 * the point - it is the part that answers "not every spare dollar is for
 * savings".
 *
 * ## A goal with no intent is never allocated to
 *
 * Null is not zero. It is a pot with no plan, which is the normal state for a
 * trip - the household's own words, recorded on 2026-11-08, were that trips
 * "never have a set date or set cost; we simply save for it and book a good
 * deal when it comes about". Automatically earmarking for such a goal would
 * invent a policy nobody stated, and would make "unallocated" always zero,
 * which is the exact reading being complained about.
 */
import type { Cents } from "./money.js";

export interface RoomGoal {
  readonly id: string;
  readonly name: string;
  /**
   * What the household means to put in each payday, or null for a pot with no
   * plan. Never negative.
   */
  readonly perPaydayIntentCents: Cents | null;
  /** Lower comes first when the room will not stretch to every intent. */
  readonly sortIndex?: number;
}

export interface RoomLine {
  readonly goalId: string;
  readonly name: string;
  /** What the household said they would put in. */
  readonly intentCents: Cents;
  /** What the room actually stretches to, which may be less or nothing. */
  readonly allocatedCents: Cents;
  /** True when the room did not cover this goal's intent in full. */
  readonly isShort: boolean;
}

export interface RoomAllocation {
  /** The constraint this was divided up: what could safely leave. */
  readonly availableCents: Cents;
  /** Every stated intent added together. */
  readonly intendedCents: Cents;
  readonly lines: readonly RoomLine[];
  /**
   * What is left once every intent is met, as a positive magnitude.
   *
   * The figure that answers the complaint. It is not "money you have failed
   * to allocate" - it is the part of the room that the household has not
   * committed, and it is theirs to leave where it is.
   */
  readonly unallocatedCents: Cents;
  /**
   * How much of the stated intent the room does not reach, as a positive
   * magnitude. Zero when it covers everything.
   */
  readonly shortCents: Cents;
}

/**
 * Divide the room across the household's stated intents, in their order.
 *
 * In `sortIndex` order rather than proportionally, and that is a deliberate
 * choice about what a household does when money is short: they fund the first
 * thing fully and the last thing not at all, rather than underfunding
 * everything by a quarter. A proportional split would also produce a remainder
 * to round, and a rounding rule on money is something to avoid needing.
 *
 * A negative room - the period is already short - allocates nothing and
 * reports the whole intent as unmet. It is not clamped to zero, because
 * "nothing fits" and "this period is already underwater" are different pieces
 * of news and the caller has the real figure either way.
 */
export function allocateRoom(options: {
  readonly availableCents: Cents;
  readonly goals: readonly RoomGoal[];
}): RoomAllocation {
  const planned = [...options.goals]
    .filter((goal) => goal.perPaydayIntentCents !== null && goal.perPaydayIntentCents > 0n)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));

  let remaining = options.availableCents > 0n ? options.availableCents : 0n;
  let intended = 0n;

  const lines: RoomLine[] = planned.map((goal) => {
    const intent = goal.perPaydayIntentCents as Cents;
    intended += intent;

    const allocated = remaining >= intent ? intent : remaining;
    remaining -= allocated;

    return {
      goalId: goal.id,
      name: goal.name,
      intentCents: intent,
      allocatedCents: allocated,
      isShort: allocated < intent,
    };
  });

  return {
    availableCents: options.availableCents,
    intendedCents: intended,
    lines,
    unallocatedCents: remaining,
    shortCents: intended - lines.reduce((sum, line) => sum + line.allocatedCents, 0n),
  };
}
