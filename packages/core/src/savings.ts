/**
 * One savings account, several earmarks.
 *
 * The household has exactly one real savings account. What they want to see is
 * not a second budget but where the money already saved is *going*: some of it
 * is a trip, some of it is the next mortgage lump sum, and the split is a
 * label rather than a transfer.
 *
 * So there are two separate operations, and conflating them is the mistake
 * this module exists to prevent:
 *
 *  1. A **transfer** moves money from chequing into savings. Real money. It
 *     belongs on the ledger, where it lowers what is left to spend. That is an
 *     ordinary occurrence and is handled by the timeline, not here.
 *  2. An **earmark** labels money that is already in savings. It moves
 *     nothing, changes no balance, and can be re-split at any time.
 *
 * ## Why the balance is not the sum of the earmarks
 *
 * The account balance is a fact, typed in from the bank like the chequing
 * balance. The earmarks are also facts - amounts a person decided to set
 * aside. Neither is derived from the other, so they can disagree, and the
 * useful number is exactly that disagreement: {@link SavingsSummary.unallocatedCents}.
 *
 * A spreadsheet will not tell you that you have earmarked more than you have.
 * This does, rather than quietly clamping a bar to 100% and losing the fact.
 */
import type { Cents } from "./money.js";
import { percentShareOneDecimal, sumCents } from "./money.js";

/**
 * What a pot of savings is for.
 *
 * `mortgage_lump_sum` is named so the savings screen can find the pot that
 * feeds the payoff projection without a household setting pointing at a UUID.
 */
export type EarmarkPurpose = "general" | "mortgage_lump_sum";

export interface Earmark {
  readonly id: string;
  readonly name: string;
  /** Money set aside for this, as a positive magnitude. */
  readonly setAsideCents: Cents;
  /**
   * What it is being saved towards, when there is a figure.
   *
   * Null is the normal case for a trip: Dax's words were that trips "never
   * have a set date or set cost - we simply save for it and book a good deal
   * when it comes about". An app that demands a target makes someone invent
   * one, and then reports progress against a number nobody believes.
   */
  readonly targetCents: Cents | null;
  readonly purpose?: EarmarkPurpose;
  readonly sortIndex?: number;
}

export interface EarmarkProgress {
  readonly id: string;
  readonly name: string;
  readonly setAsideCents: Cents;
  readonly targetCents: Cents | null;
  readonly purpose: EarmarkPurpose;
  /** Still to go. Null when there is no target, never negative. */
  readonly remainingCents: Cents | null;
  /** Progress to one decimal place. Null when there is no target. */
  readonly percent: number | null;
  /** True when the target has been reached or passed. */
  readonly isMet: boolean;
}

export interface SavingsSummary {
  /** The real account balance, as typed in from the bank. */
  readonly balanceCents: Cents;
  /** Every earmark added up. */
  readonly earmarkedCents: Cents;
  /**
   * Balance minus earmarks. Negative means more has been promised than exists,
   * which is surfaced rather than hidden.
   */
  readonly unallocatedCents: Cents;
  readonly isOverAllocated: boolean;
  readonly earmarks: readonly EarmarkProgress[];
}

/** One earmark's progress, with a target treated as optional throughout. */
export function earmarkProgress(earmark: Earmark): EarmarkProgress {
  if (earmark.setAsideCents < 0n) {
    throw new RangeError(
      `"${earmark.name}" has a negative amount set aside. An earmark is a positive magnitude.`,
    );
  }
  if (earmark.targetCents !== null && earmark.targetCents < 0n) {
    throw new RangeError(`"${earmark.name}" has a negative target.`);
  }

  // A target of zero is a real state - a pot deliberately paused for the year,
  // the way the mortgage lump sum is paused while a trip takes the flow - so it
  // is "met" rather than a division to guard against.
  if (earmark.targetCents === null) {
    return {
      id: earmark.id,
      name: earmark.name,
      setAsideCents: earmark.setAsideCents,
      targetCents: null,
      purpose: earmark.purpose ?? "general",
      remainingCents: null,
      percent: null,
      isMet: false,
    };
  }

  const remaining = earmark.targetCents - earmark.setAsideCents;

  return {
    id: earmark.id,
    name: earmark.name,
    setAsideCents: earmark.setAsideCents,
    targetCents: earmark.targetCents,
    purpose: earmark.purpose ?? "general",
    remainingCents: remaining > 0n ? remaining : 0n,
    percent:
      earmark.targetCents === 0n
        ? 100
        : percentShareOneDecimal(earmark.setAsideCents, earmark.targetCents),
    isMet: remaining <= 0n,
  };
}

/**
 * Reconcile the real balance against what has been earmarked.
 *
 * Earmarks keep the order they were given, after any explicit `sortIndex`, so
 * the screen can be arranged without the engine deciding what matters.
 */
export function computeSavings(options: {
  readonly balanceCents: Cents;
  readonly earmarks: readonly Earmark[];
}): SavingsSummary {
  const ordered = [...options.earmarks].sort(
    (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0),
  );

  const earmarked = sumCents(ordered.map((earmark) => earmark.setAsideCents));
  const unallocated = options.balanceCents - earmarked;

  return {
    balanceCents: options.balanceCents,
    earmarkedCents: earmarked,
    unallocatedCents: unallocated,
    isOverAllocated: unallocated < 0n,
    earmarks: ordered.map(earmarkProgress),
  };
}

/** The pot that feeds the mortgage payoff projection, if there is one. */
export function mortgageEarmark(summary: SavingsSummary): EarmarkProgress | null {
  return summary.earmarks.find((earmark) => earmark.purpose === "mortgage_lump_sum") ?? null;
}
