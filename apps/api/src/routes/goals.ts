/**
 * Goals, work reimbursements and banked hours
 * (HANDOFF section 4.4, 6.6 and 7.5).
 *
 * The trip fund, the work purchases put on the Visa and tracked until they are
 * paid back, and banked hours — which are hours only, with no dollar
 * conversion (section 14 q11), and are therefore the one quantity in Headroom
 * that is not money.
 */
import { computeGoals, computeReimbursements, sumBankedHours } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import { fromPlainDate, toPlainDate } from "../lib/timelineService.js";
import type { Goal, Reimbursement } from "../generated/prisma/client.js";

const plainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date must look like 2026-11-22.");

/** Hours, to two decimals. Never money, so never cents. */
const hoursSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, "Hours look like 7.5 or 7.50.");

const goalCreate = z
  .object({
    name: z.string().trim().min(1, "Give this goal a name.").max(120),
    targetCents: wireCents.refine((value) => value > 0n, { message: "A goal needs a target above zero." }),
    savedCents: wireCents.refine((value) => value >= 0n, { message: "Saved cannot be negative." }).optional(),
  })
  .strict();

const goalPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    targetCents: wireCents.optional(),
    savedCents: wireCents.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const reimbursementCreate = z
  .object({
    purchase: z.string().trim().min(1, "What was bought?").max(160),
    cents: wireCents.refine((value) => value > 0n, { message: "An expense has to be above zero." }),
    boughtOn: plainDate,
  })
  .strict();

const reimbursementPatch = z
  .object({
    purchase: z.string().trim().min(1).max(160).optional(),
    cents: wireCents.optional(),
    /** Explicit commands: submitted to the employer, then paid back. */
    submitted: z.boolean().optional(),
    paid: z.boolean().optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const bankedHoursCreate = z
  .object({
    userId: z.string().uuid(),
    hours: hoursSchema,
    note: z.string().trim().max(200).optional(),
  })
  .strict();

function serialiseGoal(row: Goal) {
  return {
    id: row.id,
    name: row.name,
    targetCents: row.targetCents.toString(),
    savedCents: row.savedCents.toString(),
    version: row.version,
  };
}

function serialiseReimbursement(row: Reimbursement) {
  return {
    id: row.id,
    purchase: row.purchase,
    cents: row.cents.toString(),
    boughtOn: toPlainDate(row.boughtOn),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    status: row.paidAt ? "paid" : row.submittedAt ? "submitted" : "bought",
    version: row.version,
  };
}

export async function registerGoalRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the Goals screen shows, computed. */
  app.get("/goals-overview", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const [goals, reimbursements, hours, members] = await Promise.all([
      app.db.prisma.goal.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
      app.db.prisma.reimbursement.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: { boughtOn: "desc" },
      }),
      app.db.prisma.bankedHoursEntry.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        select: { id: true, userId: true, hours: true, note: true, createdAt: true, version: true },
        orderBy: { createdAt: "desc" },
      }),
      app.db.prisma.user.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        select: { id: true, name: true, initial: true },
      }),
    ]);

    const computedGoals = computeGoals(
      goals.map((goal) => ({
        name: goal.name,
        targetCents: goal.targetCents,
        savedCents: goal.savedCents,
      })),
    );

    const summary = computeReimbursements(
      reimbursements.map((item) => ({
        purchase: item.purchase,
        cents: item.cents,
        submittedAt: item.submittedAt?.toISOString() ?? null,
        paidAt: item.paidAt?.toISOString() ?? null,
      })),
    );

    // Hours are summed per person as well as overall, since whose hours they
    // are was an open question and the answer is "tracked per user".
    const entries = hours.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      hours: entry.hours.toString(),
      note: entry.note,
      version: entry.version,
    }));

    const perPerson = members.map((member) => ({
      ...member,
      hours: sumBankedHours(entries.filter((entry) => entry.userId === member.id)),
    }));

    return reply.send({
      goals: goals.map((goal, index) => ({
        ...serialiseGoal(goal),
        remainingCents: computedGoals[index]?.remainingCents.toString() ?? "0",
        pct: computedGoals[index]?.pct ?? 0,
      })),
      reimbursements: {
        items: reimbursements.map(serialiseReimbursement),
        boughtCents: summary.boughtCents,
        submittedCents: summary.submittedCents,
        paidCents: summary.paidCents,
        outstandingCents: summary.outstandingCents,
        totalCents: summary.totalCents,
      },
      bankedHours: {
        entries,
        perPerson,
        total: sumBankedHours(entries),
      },
    });
  });

  /* ---- Goals ---- */

  app.post("/goals", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = goalCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that goal.");
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/goals",
      requestHash: hashRequest("POST", "/api/goals", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.goal.create({
          data: {
            householdId: user.householdId,
            name: input.name,
            targetCents: input.targetCents,
            savedCents: input.savedCents ?? 0n,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "goal",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: {
            name: created.name,
            targetCents: created.targetCents.toString(),
            savedCents: created.savedCents.toString(),
          },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "goal",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { goal: serialiseGoal(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/goals/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = goalPatch.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that change.");
    }

    const { baseVersion: _ignored, ...requested } = parsed.data;
    const changes = Object.fromEntries(
      Object.entries(requested).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length === 0) {
      throw new HttpError(400, "nothing_to_change", "That request did not change anything.");
    }

    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "PATCH",
      path: `/api/goals/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/goals/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.goal.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That goal no longer exists.");

        const applied = await applyVersionedChange<Goal>({
          tx: tx as unknown as PrismaLike,
          entity: "goal",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.goal.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.goal.update({
              where: { id: existing.id },
              data: { ...changes, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            }),
          snapshot: (row) => ({
            version: row.version,
            name: row.name,
            targetCents: row.targetCents.toString(),
            savedCents: row.savedCents.toString(),
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "goal",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { goal: serialiseGoal(applied.row), merged: applied.merged } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * Remove a goal.
   *
   * Soft, like every other removal here: a goal that was reached and cleared
   * away is still part of the history that explains where the money went, so
   * the row stays and only stops counting.
   */
  app.delete<{ Params: { id: string } }>("/goals/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "DELETE",
      path: `/api/goals/${request.params.id}`,
      requestHash: hashRequest("DELETE", `/api/goals/${request.params.id}`, {}),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.goal.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That goal no longer exists.");

        const applied = await applyVersionedChange<Goal>({
          tx: tx as unknown as PrismaLike,
          entity: "goal",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "soft_delete",
          changes: { deletedAt: new Date().toISOString() },
          readRow: () => tx.goal.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.goal.update({
              where: { id: existing.id },
              data: {
                deletedAt: new Date(),
                deletedById: user.id,
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: (row) => ({
            version: row.version,
            name: row.name,
            targetCents: row.targetCents.toString(),
            savedCents: row.savedCents.toString(),
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "goal",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { ok: true } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- Reimbursements ---- */

  app.post("/reimbursements", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = reimbursementCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that expense.");
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/reimbursements",
      requestHash: hashRequest("POST", "/api/reimbursements", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.reimbursement.create({
          data: {
            householdId: user.householdId,
            purchase: input.purchase,
            cents: input.cents,
            boughtOn: fromPlainDate(input.boughtOn),
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "reimbursement",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: { purchase: created.purchase, cents: created.cents.toString() },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "reimbursement",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { reimbursement: serialiseReimbursement(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/reimbursements/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = reimbursementPatch.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that change.");
    }

    const { baseVersion: _ignored, ...requested } = parsed.data;
    const requestedChanges = Object.fromEntries(
      Object.entries(requested).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(requestedChanges).length === 0) {
      throw new HttpError(400, "nothing_to_change", "That request did not change anything.");
    }

    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "PATCH",
      path: `/api/reimbursements/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/reimbursements/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.reimbursement.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That expense no longer exists.");

        // Already-true commands are no-ops, as everywhere else.
        const changes: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(requestedChanges)) {
          if (field === "submitted") {
            if (value !== (existing.submittedAt !== null)) changes["submitted"] = value;
          } else if (field === "paid") {
            if (value !== (existing.paidAt !== null)) changes["paid"] = value;
          } else if (field === "cents") {
            if (value !== existing.cents) changes["cents"] = value;
          } else if (field === "purchase") {
            if (value !== existing.purchase) changes["purchase"] = value;
          }
        }

        if (Object.keys(changes).length === 0) {
          return {
            statusCode: 200,
            body: { reimbursement: serialiseReimbursement(existing), merged: false, noop: true },
          };
        }

        const now = new Date();

        const applied = await applyVersionedChange<Reimbursement>({
          tx: tx as unknown as PrismaLike,
          entity: "reimbursement",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.reimbursement.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) => {
            const data: Record<string, unknown> = {};
            if ("purchase" in changes) data["purchase"] = changes["purchase"];
            if ("cents" in changes) data["cents"] = changes["cents"];
            if ("submitted" in changes) data["submittedAt"] = changes["submitted"] ? now : null;
            if ("paid" in changes) data["paidAt"] = changes["paid"] ? now : null;

            return tx.reimbursement.update({
              where: { id: existing.id },
              data: { ...data, version: nextVersion, updatedById: user.id, updatedAt: now },
            });
          },
          snapshot: (row) => ({
            version: row.version,
            purchase: row.purchase,
            cents: row.cents.toString(),
            submitted: row.submittedAt !== null,
            paid: row.paidAt !== null,
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "reimbursement",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: {
            reimbursement: serialiseReimbursement(applied.row),
            merged: applied.merged,
            noop: false,
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- Banked hours ---- */

  app.post("/banked-hours", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = bankedHoursCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read those hours.");
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/banked-hours",
      requestHash: hashRequest("POST", "/api/banked-hours", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const member = await tx.user.findFirst({
          where: { id: input.userId, householdId: user.householdId, deletedAt: null },
          select: { id: true },
        });
        if (!member) throw new HttpError(400, "invalid_request", "That person is not in this household.");

        const created = await tx.bankedHoursEntry.create({
          data: {
            householdId: user.householdId,
            userId: input.userId,
            hours: input.hours,
            note: input.note ?? null,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "banked_hours_entry",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: { hours: created.hours.toString(), userId: created.userId },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "banked_hours_entry",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return {
          statusCode: 201,
          body: {
            entry: {
              id: created.id,
              userId: created.userId,
              hours: created.hours.toString(),
              note: created.note,
              version: created.version,
            },
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
