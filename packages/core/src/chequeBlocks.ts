/**
 * What is left of one cheque once the bills it has to cover have come out.
 *
 * ## Why this exists
 *
 * Added on 2026-11-20, after watching how the spreadsheet this app replaces
 * is actually used. The routine is: type the balance at the top, then drag a
 * selection from one paycheque down to the row above the next one, and read
 * the sum off the bottom of the screen. That sum is the number the household
 * runs on, and Headroom did not have it anywhere.
 *
 * It is not the running balance beside those same rows. The running balance
 * carries everything from today forward, so it still contains whatever the
 * previous cheque left behind. Starting the selection at the cheque is what
 * clears that out, and it is the whole point of the gesture: the question is
 * "what did THIS cheque have to cover, and what is left of it". No amount of
 * reading down the running column answers it.
 *
 * It is not the pay-period total either. A window in `payPeriods.ts` is
 * fourteen days anchored on one person's paydays, so with two people paid on
 * alternating weeks every window holds two cheques and its total answers for
 * both at once. A block is one cheque, which is the unit the household counts
 * in.
 *
 * ## The rule
 *
 * Walk a window's entries in the order the bank would apply them. A new block
 * opens at each paycheque that has not already landed, and everything from
 * there until the next one belongs to it.
 *
 * What a row contributes is `deltaCents` - what it did to the account being
 * projected - and never its face amount. That single choice is what keeps the
 * blocks honest without a rule of their own for any of the awkward cases: a
 * charge on a credit card contributes nothing because it moved none of this
 * account's money, and a settled row contributes nothing because the balance
 * the window opens with has already been past it. `timeline.ts` decided both,
 * once, and this agrees with it by construction.
 *
 * It also makes the blocks of a window sum to that window's own `leftCents`
 * exactly, which `payPeriods.test.ts` pins. A subtotal that does not
 * reconcile with the band printed under it is worse than no subtotal at all.
 */
import { compareDates } from "./dates.js";
import type { PlainDate } from "./dates.js";
import type { Cents } from "./money.js";

/**
 * One thing on the ledger, reduced to what a block needs to know.
 *
 * Deliberately without a name: a projected cheque's name lives in the
 * database rather than in the engine, and a block that carried display text
 * would need the engine to know about owners. Callers already hold the names
 * and match them back on `openerId`.
 */
export interface BlockEntry {
  readonly id: string;
  readonly date: PlainDate | null;
  /** What it did to the account being projected. Zero is common and correct. */
  readonly deltaCents: Cents;
  /**
   * Known to be pay arriving: a paycheque row, or a cheque projected from a
   * schedule.
   *
   * Only ever a reason to open a block, never a reason not to. Pay the
   * caller cannot recognise - one person's entered by hand as a deposit - is
   * caught by `paydays` instead, so this flag being wrong in that direction
   * costs nothing.
   *
   * A cheque that has already landed must not open a block. It is history,
   * the opening balance has been past it, and a block opened on one would be
   * a heading over nothing with a leftover of zero beneath it.
   */
  readonly opensBlock: boolean;
}

export interface ChequeBlock {
  /**
   * What opened it.
   *
   * `balance` is the stretch between now and the next cheque, which opens
   * with the money already in the account. `cheque` is the ordinary case.
   * `unopened` is a window whose first rows fall before any cheque of its own
   * and that has no opening balance either - possible only when a bill sorts
   * ahead of the payday the window starts on. It is reported rather than
   * folded away so that every entry belongs to exactly one block and the
   * sums still reconcile.
   */
  readonly kind: "balance" | "cheque" | "unopened";
  /** The entry that opened it; null when the opening balance did. */
  readonly openerId: string | null;
  readonly date: PlainDate | null;
  /** Everything arriving, including the opening balance or the cheque. */
  readonly inCents: Cents;
  /** Everything leaving this account, as a positive magnitude. */
  readonly outCents: Cents;
  /** `in - out`: what the cheque leaves behind. */
  readonly leftCents: Cents;
  readonly entryIds: readonly string[];
}

interface Draft {
  kind: ChequeBlock["kind"];
  openerId: string | null;
  date: PlainDate | null;
  inCents: Cents;
  outCents: Cents;
  entryIds: string[];
}

/**
 * The order the bank would apply things in.
 *
 * Undated entries first: they are anchored to "now", which is where the
 * timeline puts them. Ties keep the order they arrived in, because within a
 * day the engine has already decided it and a re-sort would undo that.
 */
function ordered(entries: readonly BlockEntry[]): BlockEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry.date;
      const right = b.entry.date;
      if (left === right) return a.index - b.index;
      if (left === null) return -1;
      if (right === null) return 1;
      return compareDates(left, right) || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function seal(draft: Draft): ChequeBlock {
  return {
    kind: draft.kind,
    openerId: draft.openerId,
    date: draft.date,
    inCents: draft.inCents,
    outCents: draft.outCents,
    leftCents: draft.inCents - draft.outCents,
    entryIds: draft.entryIds,
  };
}

/**
 * Split a window's entries into one block per cheque.
 *
 * `opening` is the money the window starts with, and only the current partial
 * window has any: every later window starts on a payday, so its first cheque
 * is what opens it. Passing it for a later window would count the balance
 * twice, once here and once in the window it actually belongs to.
 *
 * `paydays` are the days somebody is due to be paid, inside this window. They
 * are what makes the split work on pay the caller could not label: the first
 * money to arrive once a payday has gone by is that payday's cheque, whether
 * it was recorded as a paycheque, as a dated deposit, or as a deposit a day
 * later because that is when the bank actually shows it. Leaving them out
 * falls back to `opensBlock` alone.
 */
export function chequeBlocks(
  entries: readonly BlockEntry[],
  opening: { readonly cents: Cents } | null,
  paydays: readonly PlainDate[] = [],
): ChequeBlock[] {
  const blocks: ChequeBlock[] = [];

  /**
   * Has a payday gone by between the open block and this entry?
   *
   * `openedOn` of null is the start of the window - either nothing has
   * opened yet, or the money already in the account did - so every payday in
   * the list is still ahead of it. An undated entry is anchored to "now",
   * which is before any payday the window holds, so it can never be the
   * first money after one.
   */
  const afterAPayday = (openedOn: PlainDate | null, at: PlainDate | null): boolean => {
    if (at === null) return false;
    return paydays.some(
      (payday) =>
        compareDates(payday, at) <= 0 && (openedOn === null || compareDates(payday, openedOn) > 0),
    );
  };

  let current: Draft | null =
    opening === null
      ? null
      : {
          kind: "balance",
          openerId: null,
          date: null,
          inCents: opening.cents,
          outCents: 0n,
          entryIds: [],
        };

  for (const entry of ordered(entries)) {
    /**
     * Whether this entry is a cheque arriving.
     *
     * Two ways to be one, because there are two ways a household records
     * pay. The flag is the direct answer and covers a paycheque row or a
     * projected cheque. The payday test covers the rest: money arriving once
     * a payday has gone by is that payday's pay, however it was entered.
     *
     * Both need money actually arriving in this account. A cheque already in
     * the bank, or one paid into some other account, moved nothing here, and
     * a block opened on it would head a run of rows with nothing to cover
     * them.
     */
    const opens =
      entry.deltaCents > 0n &&
      (entry.opensBlock || afterAPayday(current?.date ?? null, entry.date));

    /*
     * More pay on a day a block has already opened on joins it instead.
     *
     * Two people paid the same Friday is one cheque-to-cheque stretch, not
     * two, and the spreadsheet's own selection says so: it is dragged from
     * the first row of that day. Without this, the second cheque would cut
     * the block off after a single row and leave the bills it was meant to
     * cover stranded under a heading with no money in it.
     */
    const sameDayAsOpener =
      current !== null && current.date !== null && current.date === entry.date;

    /*
     * A cheque closes the block before it, unless that block is still waiting
     * for something to open it - in which case this cheque is what opens it,
     * and the rows already gathered are the ones that sorted ahead of their
     * own payday. Folding them in beats stranding them in a block of their
     * own whose "left over" would be a negative number with no cheque to
     * explain it.
     */
    if (opens && current !== null && current.kind !== "unopened" && !sameDayAsOpener) {
      blocks.push(seal(current));
      current = null;
    }

    current ??= {
      kind: "unopened",
      openerId: null,
      date: null,
      inCents: 0n,
      outCents: 0n,
      entryIds: [],
    };

    if (opens && current.kind === "unopened") {
      current.kind = "cheque";
      current.openerId = entry.id;
      current.date = entry.date;
    }

    if (entry.deltaCents > 0n) {
      current.inCents += entry.deltaCents;
    } else {
      current.outCents -= entry.deltaCents;
    }
    current.entryIds.push(entry.id);
  }

  if (current !== null) blocks.push(seal(current));

  return blocks;
}
