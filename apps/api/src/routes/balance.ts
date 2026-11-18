/**
 * Updating an account balance (HANDOFF section 6.1 and 9).
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
import { labelKindFor } from "../lib/activityLabels.js";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { logCreation, type PrismaLike } from "../lib/versioning.js";
import { accountMoveOf, loadTimelineContext } from "../lib/timelineService.js";
import { accountDelta } from "@headroom/core";
import { wireCentsNonNegative } from "../lib/wire.js";

const body = z
  .object({
    // Integer cents, as a string. See lib/wire.ts.
    cents: wireCentsNonNegative,
    /**
     * Which account this balance is for. Absent means chequing.
     *
     * Savings and the credit cards go through this same endpoint on purpose:
     * typing in a figure read off a bank or a statement is one act with one
     * set of rules - append-only, server clock, latest `asOf` wins - and a
     * second endpoint would be that logic written twice, with one copy
     * eventually drifting.
     *
     * A card's figure is what it OWES, entered without a minus sign, the same
     * convention a liability already uses. `wireCentsNonNegative` therefore
     * holds for every kind of account.
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
          // `name` is for the log: "updated the Chequing balance" needs it.
          select: { id: true, kind: true, name: true },
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

        /*
         * Savings holds money; it does not have a statement of things that
         * came out of it on their own. Clearing is for an account whose
         * balance is read off a list of movements - chequing, or a card.
         */
        if (account.kind === "savings" && (input.clearedOccurrenceIds ?? []).length > 0) {
          throw new HttpError(
            400,
            "invalid_request",
            "A savings balance has no list of things that cleared out of it.",
          );
        }

        // Nulls on a row mean chequing, so resolving one needs to know which
        // account that is.
        const chequing = await tx.account.findFirst({
          where: { householdId: user.householdId, deletedAt: null, kind: "chequing" },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });

        /*
         * The server clock decides when this balance was true - but a newer
         * snapshot has to win, and that cannot be left to the clock alone.
         *
         * Found in production: one snapshot carried an `asOf` nearly four
         * hours ahead, written while the host's clock was wrong and since
         * corrected. Every screen picks the balance with the latest `asOf`,
         * so that row outranked everything typed afterwards. The household
         * could type the right figure, get a 201 back, and watch the screen
         * go on showing the old one - for as long as it took real time to
         * catch up. A balance that saves and does not appear is the worst
         * shape a bug can take here, because the obvious reading is that the
         * app lost it.
         *
         * So the newest snapshot is newest by construction. A millisecond
         * past the last one is a date in the future only until the clock
         * catches up, and it is the lesser wrong: the alternative is an
         * entry that silently does nothing.
         */
        const now = new Date();
        const latest = await tx.balanceSnapshot.findFirst({
          where: { accountId: account.id },
          orderBy: [{ asOf: "desc" }],
          select: { asOf: true },
        });
        const asOf =
          latest !== null && latest.asOf >= now ? new Date(latest.asOf.getTime() + 1) : now;

        const clearedIds = input.clearedOccurrenceIds ?? [];
        if (clearedIds.length > 0) {
          const claimable = await tx.occurrence.findMany({
            where: {
              id: { in: clearedIds },
              householdId: user.householdId,
              deletedAt: null,
              clearedAt: null,
            },
            // `name` and `kind` are here only for the log: an activity row
            // records what the thing was called at the time rather than
            // reading it back off a row that may since have changed or gone.
            select: {
              id: true,
              version: true,
              name: true,
              kind: true,
              cents: true,
              paidFromAccountId: true,
              transferToAccountId: true,
            },
          });

          /*
           * Only rows that actually move THIS account.
           *
           * Ticking a chequing bill off against a card statement would mark
           * it as gone on the strength of a figure that never contained it,
           * and the money would leave the forecast without ever leaving the
           * bank. The engine already knows which rows move which account, and
           * this is the same rule, asked of one row at a time.
           */
          const movesThisAccount = claimable.filter(
            (occurrence) =>
              accountDelta(accountMoveOf(occurrence, chequing?.id ?? null), account.id) !== 0n,
          );

          if (movesThisAccount.length !== claimable.length) {
            throw new HttpError(
              400,
              "invalid_request",
              `Some of those do not come out of ${account.name}, so they cannot be ticked off against its balance.`,
            );
          }

          // Anything already cleared is left alone rather than cleared twice
          // (section 16.1 rule 6).
          for (const occurrence of movesThisAccount) {
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
                label: occurrence.name,
                labelKind: labelKindFor(occurrence.kind),
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
          // A balance snapshot has no name of its own; the account's is what
          // makes "updated the Chequing balance" possible.
          label: account.name,
          labelKind: "balance",
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
  app.get<{ Querystring: { accountId?: string } }>("/balance/clearable", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const context = await loadTimelineContext(app.db.prisma, user.householdId);

    const wanted = request.query.accountId ?? context.accountId;
    const account = context.accounts.find((entry) => entry.id === wanted) ?? null;
    if (wanted !== null && account === null) {
      throw new HttpError(404, "no_account", "That account does not exist.");
    }

    /*
     * Things dated on or before today are the plausible candidates: anything
     * later has not had a chance to come out yet.
     *
     * A settled row is not among them. It has already been applied to the
     * figure at the top, so there is nothing left for this checklist to do
     * with it, and offering it again is how the same bill comes out twice.
     *
     * This is also what retires the pre-tick. The checklist used to arrive
     * with every paid row already ticked, on the reasoning that somebody who
     * has said "we paid this" means "it is inside the figure I just read" as
     * well - sound, but it meant one Save silently cleared those rows off the
     * ledger. Now a paid row never reaches the checklist, so there is nothing
     * to pre-tick and nothing to sweep away. What is left is the genuine
     * remainder: things that came out without anybody ticking them.
     */
    /*
     * And only things that come out of the account being updated.
     *
     * `deltaCents` is the whole test: it is zero for a row that has settled
     * and zero for a row belonging to another account, which are exactly the
     * two kinds this checklist must not offer. A charge on a card has no
     * business on the chequing checklist and never did - it is on the card's.
     */
    const rows = (account ? context.projections.get(account.id)?.rows : context.timeline.rows) ?? [];

    const candidates = rows.filter(
      (row) =>
        row.effectiveDate !== null &&
        row.effectiveDate <= context.today &&
        row.event.settled !== true &&
        row.deltaCents !== 0n,
    );

    return reply.send({
      today: context.today,
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      accountKind: account?.kind ?? null,
      currentCents: account?.effectiveCents ?? context.balance.effectiveCents,
      candidates: candidates.map((row) => ({
        id: row.event.id,
        name: row.event.name,
        cents: row.event.cents,
        date: row.effectiveDate,
      })),
    });
  });
}
