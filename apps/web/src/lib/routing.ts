/**
 * Where money comes from and where it goes, as the pickers need it.
 *
 * Three screens ask the same two questions - the ledger row, the one-off sheet
 * and the expense form in Manage - and before this file they each answered
 * them inline. One of them answered wrongly: the one-off sheet offered "Into
 * savings" and then sent no destination at all, so the money left chequing and
 * arrived nowhere. The chequing balance fell and savings never moved.
 *
 * That is the whole reason this is a module with tests rather than a filter
 * expression repeated three times. The engine has exactly one place that
 * decides a sign (`accountDelta` in `packages/core`); the screens that feed it
 * should have exactly one place that decides an account.
 *
 * ## The two ends
 *
 * `paidFromAccountId` is the source and `transferToAccountId` the destination,
 * and the API spells "chequing" as a null source. A form cannot hold null in a
 * `<select>`, so every one of them uses `""` and converts on the way out -
 * which is what `CHEQUING` is for, so that conversion is named rather than
 * being a bare empty string in three files.
 */

/** The least an account has to be for these questions to be answerable. */
export interface RoutableAccount {
  readonly id: string;
  readonly name: string;
  readonly kind: "chequing" | "savings" | "credit_card";
}

/**
 * What a `<select>` holds when the answer is chequing.
 *
 * The API's null, which an option's value cannot be. Converted at the edge, in
 * one direction only: `accountIdOf` on the way out.
 */
export const CHEQUING = "";

/**
 * What a DESTINATION `<select>` holds when this is a cost, not a transfer.
 *
 * The same empty string as `CHEQUING`, and the same null on the way out, but it
 * is not the same statement: a source of "" is chequing, while a destination of
 * "" is nowhere - the money was spent rather than moved. Two names for one
 * value, each honest where it is used, because "Chequing" as the empty label on
 * a destination picker would be a lie about what the row does.
 */
export const NOWHERE = "";

/** A picked value as the API wants it: null for chequing, else the id. */
export function accountIdOf(picked: string): string | null {
  return picked === CHEQUING ? null : picked;
}

/** A stored value as a `<select>` wants it: `""` for chequing, else the id. */
export function pickedFrom(stored: string | null | undefined): string {
  return stored ?? CHEQUING;
}

/**
 * Which accounts money can come OUT of, besides chequing.
 *
 * Chequing is left out because it is the empty option and the default, and a
 * list that offered it twice would be a list with a wrong answer in it.
 *
 * Savings belongs here as much as the cards do: the household asked to be able
 * to pay something straight out of savings, and that leaving the chequing
 * forecast untouched is the same fact as a card charge doing so.
 */
export function sourceOptions<T extends RoutableAccount>(
  accounts: readonly T[],
  destination: string = CHEQUING,
): readonly T[] {
  return accounts.filter(
    (account) => account.kind !== "chequing" && account.id !== destination,
  );
}

/**
 * Which accounts money can be a payment INTO.
 *
 * The same list, for a reason worth stating: a payment toward a card and a
 * transfer into savings are one thing to the engine - money leaving one
 * account and arriving in another, one tick moving two balances.
 *
 * Chequing is not among them. Two reasons, and the second is the serious one:
 *
 *  - nothing on this ledger is a payment into the account the ledger is about;
 *  - a null source already means chequing, so chequing as the destination of a
 *    row with no source is money moving from an account into itself. That nets
 *    to zero and `requireValidRouting` cannot catch it, because it compares
 *    null against an id and they are not equal. Not offering it is how that
 *    stays unreachable.
 */
export function destinationOptions<T extends RoutableAccount>(
  accounts: readonly T[],
  source: string = CHEQUING,
): readonly T[] {
  return accounts.filter(
    (account) => account.kind !== "chequing" && account.id !== source,
  );
}

/**
 * Whether a destination has to be picked before this can be saved.
 *
 * The answer to the bug. "Into savings" with nothing chosen is not a transfer
 * with a sensible default - there is no sensible default, because the money
 * has to land somewhere nameable - so the form refuses it rather than saving
 * a row that quietly loses money.
 */
export function needsDestination(
  wanted: boolean,
  picked: string,
  available: readonly RoutableAccount[],
): boolean {
  return wanted && available.length > 0 && picked === CHEQUING;
}

/**
 * The budget section a template should carry, given where it pays.
 *
 * A payment toward a credit card must not have one. The charges on the card
 * each carry their own section and are already counted; count the payment too
 * and every card expense is budgeted twice - once as the spending and once as
 * the settling.
 *
 * A transfer into SAVINGS keeps its section, deliberately. The household
 * treats what it puts aside each month as a real commitment, and that is their
 * call rather than a consequence of this rule. `routes/budget.ts` draws the
 * same line in the same place, by account kind.
 */
export function sectionForDestination(
  section: "income" | "fixed" | "variable",
  destination: RoutableAccount | null,
): "income" | "fixed" | "variable" | null {
  return destination?.kind === "credit_card" ? null : section;
}

/** The account behind a picked value, or null for chequing or an unknown id. */
export function accountFor<T extends RoutableAccount>(
  accounts: readonly T[],
  picked: string,
): T | null {
  if (picked === CHEQUING) return null;
  return accounts.find((account) => account.id === picked) ?? null;
}
