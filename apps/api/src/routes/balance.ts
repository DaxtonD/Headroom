/**
 * Updating the chequing balance (HANDOFF section 6.1 and 9).
 *
 * Two taps on Home: type the amount, save. Optionally tick off anything that
 * cleared since the last update, which is the checklist the brief asks for.
 *
 * Balance snapshots are append-only (section 16.1 rule 5): a correction is a
 * NEW snapshot, and the latest `as_of` wins. The database enforces that with a
 * trigger, so a bug here cannot rewrite history.
 *
 * The snapshot and the bills that cleared with it are one transaction
 * (section 16.1 rule 8), so the balance can never be recorded without the
 * clearings it was counted against.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { logCreation, type PrismaLike } from "../lib/versioning.js";
import { loadTimelineContext } from "../lib/timelineService.js";
import { wireCentsNonNegative } from "../lib/wire.js";

const body = z
  .object({
    // Integer cents, as a string. See lib/wire.ts.
    cents: wireCentsNonNegative,
    /**
     * Which account this balance is for. Absent means chequing.
     *
     * Savings goes through this same endpoint on purpose: typing in a balance
     * read off the bank is one act with one set of rules - append-only, server
     * clock, latest `asOf` wins - and a second endpoint would be that logic
     * written twice, with one copy eventually drifting.
     */
    accountId: z.string().uuid().optional(),
    /** Anything the user ticked as having cleared since the last update. */
    clearedOccurrenceIds: z.array(z.string().uuid()).max(200).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export async function registerBalanceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/balance", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That balance could not be read.",
      );
    }
    const input = parsed.data;

    // No If-Match here: a snapshot is a new row, not an edit of an old one, so
    // there is no version to conflict with. Two people typing the balance at
    // once simply produces two snapshots, and the later `as_of` wins.
    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: "/api/balance",
      requestHash: hashRequest("POST", "/api/balance", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const account = await tx.account.findFirst({
          where: input.accountId
            ? { id: input.accountId, householdId: user.householdId, deletedAt: null }
            : // No id means the one the home screen is about.
              { householdId: user.householdId, deletedAt: null, kind: "chequing" },
          orderBy: { createdAt: "asc" },
          select: { id: true, kind: true },
        });
        if (!account) {
          throw new HttpError(
            409,
            "no_account",
            input.accountId
              ? "That account does not exist."
              : "There is no chequing account to record a balance against yet.",
          );
        }

        // Clearing a bill means it left the chequing account. Accepting the
        // list against savings would mark bills as paid on the strength of a
        // savings balance, so it is refused rather than quietly ignored.
        if (account.kind !== "chequing" && (input.clearedOccurrenceIds ?? []).length > 0) {
          throw new HttpError(
            400,
            "invalid_request",
            "Bills clear out of chequing, so they cannot be ticked off against another account.",
          );
        }

        // The server clock decides when this balance was true.
        const asOf = new Date();

        const clearedIds = input.clearedOccurrenceIds ?? [];
        if (clearedIds.length > 0) {
          const claimable = await tx.occurrence.findMany({
            where: {
              id: { in: clearedIds },
              householdId: user.householdId,
              deletedAt: null,
              clearedAt: null,
            },
            select: { id: true, version: true },
          });

          // Anything already cleared is left alone rather than cleared twice
          // (section 16.1 rule 6).
          for (const occurrence of claimable) {
            await tx.occurrence.update({
              where: { id: occurrence.id },
              data: {
                clearedAt: asOf,
                clearedById: user.id,
                version: { increment: 1 },
                updatedById: user.id,
                updatedAt: asOf,
              },
            });

            await tx.activity.create({
              data: {
                householdId: user.householdId,
                userId: user.id,
                action: "clear",
                entity: "occurrence",
                entityId: occurrence.id,
                versionAfter: occurrence.version + 1,
                fields: ["cleared"],
                beforeJson: { cleared: false },
                afterJson: { cleared: true },
              },
            });
          }
        }

        const snapshot = await tx.balanceSnapshot.create({
          data: {
            accountId: account.id,
            cents: input.cents,
            asOf,
            enteredById: user.id,
            note: input.note ?? null,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "balance_snapshot",
          entityId: snapshot.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: { cents: snapshot.cents.toString(), asOf: asOf.toISOString() },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "balance_snapshot",
          id: snapshot.id,
          version: 1,
          by: user.id,
        });

        return {
          statusCode: 201,
          body: {
            snapshot: {
              id: snapshot.id,
              accountId: account.id,
              cents: snapshot.cents.toString(),
              asOf: asOf.toISOString(),
              enteredById: user.id,
            },
            clearedCount: clearedIds.length,
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * The checklist shown when updating the balance: "Did any of these clear
   * since the last update?" (section 6.1).
   */
  app.get("/balance/clearable", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const context = await loadTimelineContext(app.db.prisma, user.householdId);

    // Things dated on or before today are the plausible candidates: anything
    // later has not had a chance to come out yet.
    const candidates = context.timeline.rows.filter(
      (row) => row.effectiveDate !== null && row.effectiveDate <= context.today,
    );

    // Anything already ticked as dealt with is almost certainly inside the
    // figure about to be read off the bank, so the sheet can tick it for them.
    const ticked = await app.db.prisma.occurrence.findMany({
      where: { id: { in: candidates.map((row) => row.event.id) }, paidAt: { not: null } },
      select: { id: true },
    });
    const paid = new Set(ticked.map((row) => row.id));

    return reply.send({
      today: context.today,
      currentCents: context.balance.effectiveCents,
      candidates: candidates.map((row) => ({
        id: row.event.id,
        name: row.event.name,
        cents: row.event.cents,
        date: row.effectiveDate,
        paid: paid.has(row.event.id),
      })),
    });
  });
}
