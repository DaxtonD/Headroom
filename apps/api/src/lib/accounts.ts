/**
 * Checking where a row says its money moves.
 *
 * Both ends are plain foreign keys, so the database will happily accept the id
 * of an account belonging to somebody else's household. Nothing else in
 * Headroom lets one household's row point at another's, and the rule is
 * enforced here rather than in each route so there is one place to read it.
 *
 * A null source means chequing. That is not resolved here: the id stays null in
 * the database, because what counts as "the chequing account" is decided when a
 * figure is derived, not when a row is written.
 */
import { HttpError } from "./http.js";

/** The two ends, as a row holds them. */
export interface AccountRouting {
  readonly paidFromAccountId: string | null;
  readonly transferToAccountId: string | null;
}

/** Just enough of a Prisma client or transaction to look accounts up. */
interface AccountReader {
  readonly account: {
    findMany(args: {
      where: { id: { in: string[] }; householdId: string; deletedAt: null };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
}

/**
 * The routing a change leaves behind.
 *
 * A PATCH may set one end and say nothing about the other, and both ends
 * together decide whether the result makes sense - so the check needs the pair
 * as it will be, not the half that arrived.
 */
export function routingAfter(
  current: AccountRouting,
  changes: Readonly<Record<string, unknown>>,
): AccountRouting {
  return {
    paidFromAccountId:
      "paidFromAccountId" in changes
        ? ((changes["paidFromAccountId"] as string | null) ?? null)
        : current.paidFromAccountId,
    transferToAccountId:
      "transferToAccountId" in changes
        ? ((changes["transferToAccountId"] as string | null) ?? null)
        : current.transferToAccountId,
  };
}

/**
 * Refuse routing that does not describe a real move within this household.
 *
 * Two ways it can fail, and both are a 400 rather than a 404: the client sent
 * something that cannot be honoured, and saying which account is missing would
 * confirm the existence of rows in another household.
 */
export async function requireValidRouting(
  tx: AccountReader,
  householdId: string,
  routing: AccountRouting,
): Promise<void> {
  const { paidFromAccountId, transferToAccountId } = routing;

  /*
   * Money that leaves an account and arrives in the same one has not moved,
   * and every figure derived from it would net to zero - a payment that
   * silently does nothing. Refusing it is kinder than recording it.
   */
  if (
    paidFromAccountId !== null &&
    transferToAccountId !== null &&
    paidFromAccountId === transferToAccountId
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Money cannot move from an account into itself. Pick a different destination, or leave it out.",
    );
  }

  const ids = [paidFromAccountId, transferToAccountId].filter(
    (id): id is string => id !== null,
  );
  if (ids.length === 0) return;

  const unique = [...new Set(ids)];
  const found = await tx.account.findMany({
    where: { id: { in: unique }, householdId, deletedAt: null },
    select: { id: true },
  });

  if (found.length !== unique.length) {
    throw new HttpError(
      400,
      "invalid_request",
      "That account does not exist, so nothing can be paid from it.",
    );
  }
}
