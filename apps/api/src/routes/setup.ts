/**
 * Setting the household up: paydays, the chequing account, and the settings
 * that change how everything is worked out.
 *
 * These had no API at all before, which meant pay schedules could only be
 * inserted with SQL — and almost everything depends on them: the horizon, the
 * two-week pay periods, where a flexible bill anchors, and any bill that comes
 * out "the day after a payday". Without this the app cannot be set up.
 */
import { addDays, compareDates, firstPaydayOnOrAfter, isPlainDate } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import {
  paydaysWithNoIncomeArriving,
  regenerateQuietly,
  restorePaycheque,
  syncPaychequeDefault,
} from "../lib/generateService.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { forgetImageIfUnused, requireOwnImage } from "../lib/images.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import { fromPlainDate, todayInZone, toPlainDate } from "../lib/timelineService.js";
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
    /**
     * Where purchases come from, for now. Null lifts it.
     *
     * The other two fields are only read when this one is present: an end
     * date or a note on its own would describe a posture that is not in
     * force, and the route rejects that rather than storing it.
     */
    spendFromAccountId: z.string().uuid().nullable().optional(),
    /**
     * The last day it applies, inclusive. Absent means the next payday, which
     * the server works out - a posture nobody turns off becomes permanently
     * on, and asking somebody to pick a date is a decision they do not have
     * to make.
     */
    spendFromUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, "That is not a date.")
      .optional(),
    /** Why, in their words. Never shown with an amount. */
    spendFromNote: z.string().trim().max(140).nullable().optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const accountCreate = z
  .object({
    name: z.string().trim().min(1).max(60),
    /**
     * Defaults to chequing, which is what a household's first account is.
     *
     * A credit card is an account like any other here. What makes it one is
     * that its balance is money owed rather than held, which the kind says
     * and nothing else in this row needs to know.
     */
    kind: z.enum(["chequing", "savings", "credit_card"]).optional(),
    /** The picture beside the name, uploaded to `/api/images` first. */
    imageId: z.string().uuid().nullable().optional(),
  })
  .strict();

const accountPatch = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    /** The picture beside the name, uploaded to `/api/images` first. */
    imageId: z.string().uuid().nullable().optional(),
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
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    imageId: row.imageId,
    version: row.version,
  };
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the Manage screen needs in order to show the setup state. */
  app.get("/setup", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const [household, schedules, accounts, members, withoutIncome] = await Promise.all([
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
      // Which paydays have nothing arriving on the ledger around them - not
      // "which have a paycheque template", which is a different and much
      // narrower question. See the note on the function.
      paydaysWithNoIncomeArriving(app.db.prisma, user.householdId),
    ]);

    // What still has to be filled in before the app can work properly. The
    // Manage screen shows this as a checklist rather than leaving someone to
    // wonder why their pay periods look wrong.
    const missing: string[] = [];
    // A savings account alone is not a set-up household: the timeline needs
    // somewhere to read the balance that can be spent.
    if (!accounts.some((account) => account.kind === "chequing")) missing.push("account");
    if (schedules.length === 0) missing.push("pay_schedule");
    if (household.netMonthlyIncomeCents === 0n) missing.push("income");
    /**
     * A payday with nothing arriving on the ledger around it.
     *
     * A pay schedule gives the DATES everything hangs off, and an amount used
     * for the pay-period totals - but nothing on the timeline. Without a row
     * for the money the ledger is pure outgoings: a balance that only falls,
     * and every automatic withdrawal reported as uncovered.
     *
     * Asked per payday, not as "is there any income at all". It used to be
     * the latter, and a single unrelated deposit - a child benefit - was
     * enough to answer yes while neither person's pay was on the ledger. It
     * is also not asked as "does a paycheque template exist", which was the
     * other extreme and the one that did real damage: a household who had
     * entered their pay by hand got told it was not on the ledger while they
     * were looking at it, and the button offered here then put a second copy
     * of it there.
     */
    const paydaysWithoutPay = schedules
      .filter((schedule) => withoutIncome.has(schedule.id))
      .map((schedule) => ({
        scheduleId: schedule.id,
        // Named, because "a payday has no paycheque" left someone looking at
        // two entries under Money coming in with no idea which was wrong.
        person: schedule.user?.name ?? "Someone",
      }));

    if (paydaysWithoutPay.length > 0) {
      missing.push("income_on_ledger");
    }

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
      /** Which paydays are not putting money on the ledger, and whose. */
      paydaysWithoutPay,
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


    // Automatic, because a button for this was a step that could be forgotten
    // and whose absence looked like a bug: an expense was added and the ledger
    // did not show it. Runs after the write has committed, so it cannot undo
    // it.
    await regenerateQuietly(app.db.prisma, user.householdId, app.log);
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

        // A raise is entered here, on the payday, which is the only place the
        // amount is visible. The paycheque template that actually puts money
        // on the ledger has to follow it.
        if ("defaultCents" in changes) {
          const synced = await syncPaychequeDefault(
            tx,
            user.householdId,
            applied.row.id,
            applied.row.defaultCents,
            user.id,
          );
          if (synced) {
            await publishChange(tx, {
              householdId: user.householdId,
              entity: "template",
              id: synced.id,
              version: synced.version,
              by: user.id,
            });
          }
        }

        return {
          statusCode: 200,
          body: { paySchedule: serialiseSchedule(applied.row), merged: applied.merged },
        };
      },
    });


    // Automatic, because a button for this was a step that could be forgotten
    // and whose absence looked like a bug: an expense was added and the ledger
    // did not show it. Runs after the write has committed, so it cannot undo
    // it.
    await regenerateQuietly(app.db.prisma, user.householdId, app.log);
    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * Put this payday's pay back on the ledger.
   *
   * The resolution for the one checklist item that had none. Archiving a
   * paycheque is a decision generation deliberately will not reverse, and the
   * only "Add money coming in" button makes a `deposit` - which sits in the
   * same list looking like income while anchoring no flexible bills and
   * claiming no payday, so the checklist went on complaining whatever was
   * entered. This is the explicit opposite of archiving.
   */
  app.post<{ Params: { id: string } }>("/pay-schedules/:id/paycheque", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: `/api/pay-schedules/${request.params.id}/paycheque`,
      requestHash: hashRequest(
        "POST",
        `/api/pay-schedules/${request.params.id}/paycheque`,
        request.body ?? {},
      ),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const schedule = await tx.paySchedule.findFirst({
          where: {
            id: request.params.id,
            deletedAt: null,
            user: { householdId: user.householdId, deletedAt: null },
          },
          select: { id: true },
        });
        if (!schedule) throw new HttpError(404, "not_found", "That payday no longer exists.");

        const template = await restorePaycheque(tx, user.householdId, schedule.id, user.id);

        // Already fine, which is the honest answer to asking twice rather than
        // an error (section 16.1 rule 6).
        if (!template) {
          return { statusCode: 200, body: { restored: false, template: null } };
        }

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "template",
          id: template.id,
          version: template.version,
          by: user.id,
        });

        return { statusCode: 200, body: { restored: true, template } };
      },
    });

    // The cheques themselves, now that something wants them again.
    await regenerateQuietly(app.db.prisma, user.householdId, app.log);
    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- Accounts: chequing, savings, and the cards ---- */

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
        await requireOwnImage(tx, user.householdId, parsed.data.imageId);

        const created = await tx.account.create({
          data: {
            householdId: user.householdId,
            name: parsed.data.name,
            imageId: parsed.data.imageId ?? null,
            // Absent means chequing, so an existing client keeps working.
            ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
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

        await requireOwnImage(tx, user.householdId, changes["imageId"] as string | null | undefined);

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

        /*
         * The picture it used to have, if nothing points at it any more. A
         * re-crop is a new row by design, so without this the table grows by
         * one every time somebody adjusts a picture - and the database is also
         * the backup, so that growth is paid for twice.
         */
        if ("imageId" in changes && existing.imageId !== applied.row.imageId) {
          await forgetImageIfUnused(tx, existing.imageId);
        }

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
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(requested).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length === 0) {
      throw new HttpError(400, "nothing_to_change", "That request did not change anything.");
    }

    /*
     * The integrity headers before any of the work below.
     *
     * They are two cheap reads of two headers, and the posture validation
     * underneath them hits the database three times. Doing that first meant a
     * request with no `If-Match` was answered by whichever validation
     * happened to fail - so the client was told its account was wrong when
     * the actual problem was a missing header, and a rejected request did
     * lookups for nothing.
     */
    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    /*
     * ---- Where purchases come from, for now ----
     *
     * Settled here rather than trusted from the client, because the other
     * four columns are consequences of the one field the client sends. A body
     * that could set `spendFromSetById` itself would let one of them put the
     * other's name on it.
     */
    let spendFromLabel: string | null = null;
    if ("spendFromAccountId" in changes) {
      const wanted = changes["spendFromAccountId"];

      if (wanted === null) {
        /*
         * Lifting it clears the whole posture. Leaving the end date and the
         * note behind would describe something that is not in force, and
         * `spendFromIsActive` would be the only thing standing between that
         * and a banner.
         */
        changes["spendFromUntil"] = null;
        changes["spendFromNote"] = null;
        changes["spendFromSetById"] = null;
        changes["spendFromSetAt"] = null;
      } else {
        /*
         * The account has to be one of this household's. Scoped by
         * `householdId` in the WHERE rather than fetched and then checked, so
         * another household's id simply does not match - the shape every
         * other read in here uses.
         */
        const account = await app.db.prisma.account.findFirst({
          where: { id: String(wanted), householdId: user.householdId, deletedAt: null },
          select: { id: true, name: true, kind: true },
        });
        if (!account) {
          throw new HttpError(404, "not_found", "That account is not one of yours.");
        }
        if (account.kind === "chequing") {
          /*
           * Chequing is not a posture, it is the ordinary state, and null
           * already says it. Two spellings of one thing would mean a banner
           * announcing business as usual.
           */
          throw new HttpError(
            400,
            "invalid_request",
            "Purchases already come out of chequing. Clear this instead of setting it to chequing.",
          );
        }
        spendFromLabel = account.name;

        /*
         * The end date. Absent means the next payday - a date the server
         * already knows, and a decision the household should not have to
         * make. Anchored on whichever schedule pays soonest rather than one
         * person's: "until payday" means the next money arriving, whoever
         * earns it.
         */
        if (changes["spendFromUntil"] === undefined) {
          const schedules = await app.db.prisma.paySchedule.findMany({
            where: { user: { householdId: user.householdId }, deletedAt: null },
            select: { anchorDate: true },
          });
          const row = await app.db.prisma.household.findUnique({
            where: { id: user.householdId },
            select: { timezone: true },
          });
          const today = todayInZone(row?.timezone ?? "America/Regina");
          const paydays = schedules
            .map((schedule) => firstPaydayOnOrAfter(toPlainDate(schedule.anchorDate), today))
            .sort(compareDates);

          /*
           * No pay schedules at all: a fortnight. It has to end somewhere,
           * and an end that is only approximate is far better than one that
           * never comes - which is the failure this default prevents.
           */
          changes["spendFromUntil"] = paydays[0] ?? addDays(today, 14);
        }

        changes["spendFromSetById"] = user.id;
        changes["spendFromSetAt"] = new Date();
      }
    } else if ("spendFromUntil" in changes || "spendFromNote" in changes) {
      // An end date or a note with no account describes a posture that is not
      // in force. Storing it would leave the row half-written, which
      // `spendFromIsActive` is deliberately strict about.
      throw new HttpError(400, "invalid_request", "Say which account purchases come from as well.");
    }

    /*
     * Dates go in as dates. `spendFromUntil` is a `@db.Date`, and handing the
     * driver a bare string lands it at midnight UTC - which in
     * America/Regina is the evening before.
     */
    if (typeof changes["spendFromUntil"] === "string") {
      changes["spendFromUntil"] = fromPlainDate(changes["spendFromUntil"]);
    }

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
          /*
           * The account's name, so the activity row and the notification can
           * say "put purchases on the Visa" rather than "on a card". The row
           * holds only an id, and `packages/core/src/activity.ts` reads this.
           * Null for every other household change, which has no subject worth
           * naming beyond the household itself.
           */
          label: spendFromLabel,
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
            // In the 409 body as well, so a conflict over this field can show
            // what the other person set rather than only that they set it.
            spendFromAccountId: row.spendFromAccountId,
            spendFromUntil: row.spendFromUntil === null ? null : toPlainDate(row.spendFromUntil),
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
              spendFromAccountId: applied.row.spendFromAccountId,
              spendFromUntil:
                applied.row.spendFromUntil === null
                  ? null
                  : toPlainDate(applied.row.spendFromUntil),
              spendFromNote: applied.row.spendFromNote,
              version: applied.row.version,
            },
            merged: applied.merged,
          },
        };
      },
    });


    // Automatic, because a button for this was a step that could be forgotten
    // and whose absence looked like a bug: an expense was added and the ledger
    // did not show it. Runs after the write has committed, so it cannot undo
    // it.
    await regenerateQuietly(app.db.prisma, user.householdId, app.log);
    return reply.status(result.statusCode).send(result.body);
  });
}
