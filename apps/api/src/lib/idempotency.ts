/**
 * Idempotent mutations (HANDOFF section 16.1 rule 7).
 *
 * A phone on a weak connection retries. A thumb double-taps Save. Neither may
 * clear a bill twice or create a one-off twice.
 *
 * The key is CLAIMED at the start of the transaction, before any work is done,
 * and the response is written into that same row before it commits. The order
 * matters: Postgres blocks a second insert of the same primary key until the
 * first transaction finishes, so two copies of one request arriving together
 * are serialised here rather than racing on into the version check, where the
 * loser would get a spurious 409 against its own twin.
 *
 * Because the claim and the change share a transaction, either both land or
 * neither does. A request that fails - a 409 conflict, say - rolls the claim
 * back too, so the client is free to resolve it and try again.
 */
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { HttpError } from "./http.js";

/** Postgres unique-violation, surfaced by Prisma as P2002. */
const UNIQUE_VIOLATION = "P2002";

export interface IdempotentOutcome {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface RunIdempotentOptions {
  readonly prisma: PrismaClient;
  readonly key: string;
  readonly userId: string;
  readonly method: string;
  readonly path: string;
  readonly requestHash: string;
  readonly ttlHours: number;
  /**
   * The actual work, run inside the same transaction that claimed the key.
   * Whatever it returns is stored and replayed verbatim for a retry.
   */
  readonly work: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome>;
}

export interface IdempotentResult extends IdempotentOutcome {
  /** True when this response came from the store rather than being computed. */
  readonly replayed: boolean;
}

export async function runIdempotent(options: RunIdempotentOptions): Promise<IdempotentResult> {
  const { prisma, key, requestHash } = options;

  // Fast path: a retry that arrives after the original finished.
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (existing) return replayOrReject(existing, requestHash);

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Claim the key FIRST. A concurrent duplicate blocks on this insert
      // until this transaction commits or rolls back.
      await tx.idempotencyKey.create({
        data: {
          key,
          userId: options.userId,
          method: options.method.toUpperCase(),
          path: options.path,
          requestHash,
          // Filled in below, in this same transaction, so a committed row
          // always carries the real response.
          statusCode: 0,
          responseJson: {},
        },
      });

      const result = await options.work(tx);

      await tx.idempotencyKey.update({
        where: { key },
        data: {
          statusCode: result.statusCode,
          responseJson: result.body as Prisma.InputJsonValue,
        },
      });

      return result;
    });

    return { ...outcome, replayed: false };
  } catch (error) {
    // Another copy of this request claimed the key and committed first. Its
    // answer is the answer; this one must not apply the change again.
    if (isUniqueViolation(error)) {
      const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (winner) return replayOrReject(winner, requestHash);
    }
    throw error;
  }
}

interface StoredKey {
  readonly requestHash: string;
  readonly statusCode: number;
  readonly responseJson: unknown;
}

function replayOrReject(stored: StoredKey, requestHash: string): IdempotentResult {
  if (stored.requestHash !== requestHash) {
    // The same key used for a different change is a client bug, and applying
    // it would be guessing which one was meant.
    throw new HttpError(
      422,
      "idempotency_key_reused",
      "That Idempotency-Key has already been used for a different change. Start the save again with a new key.",
    );
  }

  if (stored.statusCode === 0) {
    // Only reachable if a process died between claiming the key and writing
    // the response, which cannot happen inside one transaction. Treated as
    // retryable rather than returning a meaningless 0.
    throw new HttpError(
      409,
      "idempotent_request_incomplete",
      "An earlier attempt at this change did not finish. Try saving again.",
    );
  }

  return {
    statusCode: stored.statusCode,
    body: stored.responseJson,
    replayed: true,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Drop receipts older than the TTL.
 *
 * They only need to outlive a retry, and `IDEMPOTENCY_KEY_TTL_HOURS` says how
 * long that is. Called on a timer by the server.
 */
export async function purgeIdempotencyKeys(prisma: PrismaClient, ttlHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
  const result = await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
