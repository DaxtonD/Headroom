/**
 * Setting the household up: paydays, the chequing account, and the settings
 * that change how everything is worked out.
 *
 * These had no API at all before, which meant pay schedules could only be
 * inserted with SQL — and almost everything depends on them: the horizon, the
 * two-week pay periods, where a flexible bill anchors, and any bill that comes
 * out "the day after Dax's payday". Without this the app cannot be set up.
 */
import { isPlainDate } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import { fromPlainDate, toPlainDate } from "../lib/timelineService.js";
import type { Account, PaySchedule } from "../generated/prisma/client.js";

const plainDate = z
  .string()
  .refine((value) => isPlainDate(value), { message: "A date must be a real date, like 2026-11-12." });

const payScheduleCreate = z
  .object({
    userId: z.string().uuid(),
    /** Any real payday; every other one is 14 days from it. */
    anchorDate: plainDate,
    defaultCents: wireCents.refine((value) => value > 0n, {
      message: "A paycheque has to be more than nothing.",
    }),
  })
  .strict();

const paySchedulePatch = z
  .object({
    anchorDate: plainDate.optional(),
    defaultCents: wireCents.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const householdPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** How much must remain after an automatic withdrawal to count as covered. */
    cushionCents: wireCents.refine((value) => value >= 0n, {
      message: "A cushion cannot be negative.",
    }).optional(),
    /** "Through the day before the Nth upcoming paycheque." */
    horizonPaychequeCount: z.number().int().min(1).max(52).optional(),
    weekendWithdrawalRule: z.enum(["as_scheduled", "friday_before", "next_business_day"]).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const accountCreate = z.object({ name: z.string().trim().min(1).max(60) }).strict();

const accountPatch = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

function serialiseSchedule(row: PaySchedule & { user?: { id: string; name: string; initial: string } }) {
  return {
    id: row.id,
    userId: row.userId,
    user: row.user ?? null,
    cadence: row.cadence,
    anchorDate: toPlainDate(row.anchorDate),
    defaultCents: row.defaultCents.toString(),
    version: row.version,
  };
}

function serialiseAccount(row: Account) {
  return { id: row.id, name: row.name, version: row.version };
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the Manage screen needs in order to show the setup state. */
  app.get("/setup", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const [household, schedules, accounts, members] = await Promise.all([
      app.db.prisma.household.findUniqueOrThrow({
        where: { id: user.householdId },
        select: {
          id: true,
          name: true,
          timezone: true,
          currency: true,
          cushionCents: true,
          horizonPaychequeCount: true,
          weekendWithdrawalRule: true,
          netMonthlyIncomeCents: true,
          netYearlyIncomeCents: true,
          version: true,
        },
      }),
      app.db.prisma.paySchedule.findMany({
        where: { deletedAt: null, user: { householdId: user.householdId, deletedAt: null } },
        include: { user: { select: { id: true, name: true, initial: true } } },
        orderBy: { anchorDate: "asc" },
      }),
      app.db.prisma.account.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
      app.db.prisma.user.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        select: { id: true, name: true, initial: true, colorFg: true, colorBg: true },
        orderBy: { name: "asc" },
      }),
    ]);

    // What still has to be filled in before the app can work properly. The
    // Manage screen shows this as a checklist rather than leaving someone to
    // wonder why their pay periods look wrong.
    const missing: string[] = [];
    if (accounts.length === 0) missing.push("account");
    if (schedules.length === 0) missing.push("pay_schedule");
    if (household.netMonthlyIncomeCents === 0n) missing.push("income");

    return reply.send({
      household: {
        ...household,
        cushionCents: household.cushionCents,
        netMonthlyIncomeCents: household.netMonthlyIncomeCents,
        netYearlyIncomeCents: household.netYearlyIncomeCents,
      },
      members,
      paySchedules: schedules.map(serialiseSchedule),
      accounts: accounts.map(serialiseAccount),
      missing,
    });
  });

  /* ---- Paydays ---- */

  app.post("/pay-schedules", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = payScheduleCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read that pay schedule.",
      );
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/pay-schedules",
      requestHash: hashRequest("POST", "/api/pay-schedules", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const member = await tx.user.findFirst({
          where: { id: input.userId, householdId: user.householdId, deletedAt: null },
          select: { id: true },
        });
        if (!member) {
          throw new HttpError(400, "invalid_request", "That person is not in this household.");
        }

        // One schedule per person: two would make "every 14 days from an
        // anchor" ambiguous, and every pay period would double-count them.
        const already = await tx.paySchedule.findFirst({
          where: { userId: input.userId, deletedAt: null },
          select: { id: true },
        });
        if (already) {
          throw new HttpError(
            409,
            "already_exists",
            "That person already has a pay schedule. Edit it instead of adding another.",
          );
        }

        const created = await tx.paySchedule.create({
          data: {
            userId: input.userId,
            anchorDate: fromPlainDate(input.anchorDate),
            defaultCents: input.defaultCents,
            updatedById: user.id,
          },
          include: { user: { select: { id: true, name: true, initial: true } } },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "pay_schedule",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: {
            anchorDate: toPlainDate(created.anchorDate),
            defaultCents: created.defaultCents.toString(),
          },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "pay_schedule",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { paySchedule: serialiseSchedule(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/pay-schedules/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = paySchedulePatch.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read that change.",
      );
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
      path: `/api/pay-schedules/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/pay-schedules/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.paySchedule.findFirst({
          where: {
            id: request.params.id,
            deletedAt: null,
            user: { householdId: user.householdId, deletedAt: null },
          },
        });
        if (!existing) throw new HttpError(404, "not_found", "That pay schedule no longer exists.");

        const applied = await applyVersionedChange<PaySchedule>({
          tx: tx as unknown as PrismaLike,
          entity: "pay_schedule",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.paySchedule.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) => {
            const data: Record<string, unknown> = { ...changes };
            if ("anchorDate" in changes) {
              data["anchorDate"] = fromPlainDate(changes["anchorDate"] as string);
            }
            return tx.paySchedule.update({
              where: { id: existing.id },
              data: { ...data, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            });
          },
          snapshot: (row) => ({
            version: row.version,
            anchorDate: toPlainDate(row.anchorDate),
            defaultCents: row.defaultCents.toString(),
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "pay_schedule",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { paySchedule: serialiseSchedule(applied.row), merged: applied.merged },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- The chequing account ---- */

  app.post("/accounts", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = accountCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that.");
    }
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/accounts",
      requestHash: hashRequest("POST", "/api/accounts", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.account.create({
          data: {
            householdId: user.householdId,
            name: parsed.data.name,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "account",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: { name: created.name },
        });

        return { statusCode: 201, body: { account: serialiseAccount(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /** Rename the account, since its name is the label on the Home screen. */
  app.patch<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = accountPatch.safeParse(request.body ?? {});
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
      path: `/api/accounts/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/accounts/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.account.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That account no longer exists.");

        const applied = await applyVersionedChange<Account>({
          tx: tx as unknown as PrismaLike,
          entity: "account",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.account.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.account.update({
              where: { id: existing.id },
              data: { ...changes, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            }),
          snapshot: (row) => ({ version: row.version, name: row.name }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "account",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { account: serialiseAccount(applied.row), merged: applied.merged },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- Household settings ---- */

  /**
   * The cushion, the horizon and the weekend rule.
   *
   * All three change what every derived figure comes out as, which is why they
   * are versioned like any other edit: two people changing the cushion at once
   * should not silently pick one.
   */
  app.patch("/settings/household", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = householdPatch.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read those settings.",
      );
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
      path: "/api/settings/household",
      requestHash: hashRequest("PATCH", "/api/settings/household", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const applied = await applyVersionedChange({
          tx: tx as unknown as PrismaLike,
          entity: "household",
          id: user.householdId,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.household.findUnique({ where: { id: user.householdId } }),
          writeRow: (nextVersion) =>
            tx.household.update({
              where: { id: user.householdId },
              data: { ...changes, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            }),
          snapshot: (row) => ({
            version: row.version,
            name: row.name,
            cushionCents: row.cushionCents.toString(),
            horizonPaychequeCount: row.horizonPaychequeCount,
            weekendWithdrawalRule: row.weekendWithdrawalRule,
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "household",
          id: user.householdId,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: {
            household: {
              name: applied.row.name,
              cushionCents: applied.row.cushionCents.toString(),
              horizonPaychequeCount: applied.row.horizonPaychequeCount,
              weekendWithdrawalRule: applied.row.weekendWithdrawalRule,
              version: applied.row.version,
            },
            merged: applied.merged,
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
