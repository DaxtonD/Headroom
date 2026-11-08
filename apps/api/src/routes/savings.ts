/**
 * Savings, earmarks and the mortgage payoff.
 *
 * This screen's reason for existing came straight from Dax: the household is
 * actively trying to save as much as possible in order to pay the mortgage off
 * early with annual lump sums. The spreadsheet cannot say what a given lump sum
 * buys, so the decision about how much to save was being made without the one
 * number that would settle it.
 *
 * Three things are kept apart here, because conflating any two of them is how a
 * savings screen starts lying:
 *
 *  1. **The balance** is a fact, typed in off the bank, exactly like the
 *     chequing balance and through the same append-only endpoint.
 *  2. **An earmark** is a label on money already in that account. It moves
 *     nothing. The household has one real savings account, and what they asked
 *     for was to see where the saved money is going.
 *  3. **A transfer** is real money leaving chequing. That belongs on the
 *     ledger, not here, and is an ordinary occurrence.
 *
 * So the balance and the earmarks are both facts, and they can disagree. The
 * disagreement is the useful number, so it is reported rather than clamped.
 *
 * Everything about the mortgage beyond its terms - the payoff date, the
 * interest, what another lump sum would move it to, how much allowance is left
 * this year - is derived on each request by `@headroom/core/mortgage` and never
 * stored, under the same rule as running balances.
 */
import {
  addDays,
  amortize,
  compareDates,
  computeSavings,
  isPaydayOn,
  lumpSumRoom,
  mortgageEarmark,
  daysBetween,
  payoffDelta,
  sumCents,
} from "@headroom/core";
import type { Cents, MortgageTerms, PlainDate, Prepayment as LumpSum } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import { fromPlainDate, toPlainDate, todayInZone } from "../lib/timelineService.js";
import type { Mortgage, Prepayment } from "../generated/prisma/client.js";

const plainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date must look like 2026-11-22.");

/** 0 to 2500 basis points: 0% to 25%, which brackets anything a lender offers. */
const rateBasisPoints = z
  .number()
  .int("A rate in basis points is a whole number: 3.99% is 399.")
  .min(0)
  .max(2500);

const mortgageCreate = z
  .object({
    balanceCents: wireCents.refine((value) => value > 0n, {
      message: "A mortgage balance has to be above zero.",
    }),
    asOf: plainDate,
    rateBasisPoints,
    paymentCents: wireCents.refine((value) => value > 0n, {
      message: "The payment has to be above zero.",
    }),
    /** Which payday the payment follows, and by how many days. */
    payScheduleId: z.string().uuid(),
    offsetDays: z.number().int().min(0).max(13).optional(),
    compounding: z.enum(["simple_division", "semi_annual"]).optional(),
    /** The yearly prepayment allowance. Zero means "not tracked". */
    prepaymentCapCents: wireCents
      .refine((value) => value >= 0n, { message: "An allowance cannot be negative." })
      .optional(),
  })
  .strict();

const mortgagePatch = z
  .object({
    balanceCents: wireCents.optional(),
    asOf: plainDate.optional(),
    rateBasisPoints: rateBasisPoints.optional(),
    paymentCents: wireCents.optional(),
    payScheduleId: z.string().uuid().optional(),
    offsetDays: z.number().int().min(0).max(13).optional(),
    compounding: z.enum(["simple_division", "semi_annual"]).optional(),
    prepaymentCapCents: wireCents.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const prepaymentCreate = z
  .object({
    paidOn: plainDate,
    cents: wireCents.refine((value) => value > 0n, {
      message: "A lump sum has to be above zero.",
    }),
    note: z.string().trim().max(200).optional(),
    /** False for one that is intended but has not been paid yet. */
    paid: z.boolean().optional(),
  })
  .strict();

const prepaymentPatch = z
  .object({
    paidOn: plainDate.optional(),
    cents: wireCents.optional(),
    note: z.string().trim().max(200).nullish(),
    paid: z.boolean().optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const savingsQuery = z.object({
  /** A what-if: what this much, paid now, would do to the payoff date. */
  lumpSumCents: wireCents.optional(),
});

/* -------------------------------------------------------------------------- */
/* Deriving                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The payment schedule the mortgage actually follows.
 *
 * The row stores which payday it follows and by how many days, never its own
 * anchor, so the two can never drift apart - and so the one-day offset that
 * desynchronises third cheques from third mortgage payments stays one fact in
 * one place.
 */
function termsFrom(row: Mortgage, payAnchor: Date): MortgageTerms {
  return {
    balanceCents: row.balanceCents,
    asOf: toPlainDate(row.asOf),
    rateBasisPoints: row.rateBasisPoints,
    paymentCents: row.paymentCents,
    paymentAnchorDate: addDays(toPlainDate(payAnchor), row.offsetDays),
    periodsPerYear: row.periodsPerYear,
    cadenceDays: row.cadenceDays,
    compounding: row.compounding,
  };
}

function toLumpSum(row: Prepayment): LumpSum {
  return {
    id: row.id,
    date: toPlainDate(row.paidOn),
    cents: row.cents,
    ...(row.note === null ? {} : { note: row.note }),
  };
}

/**
 * Refuse terms that cannot be run forward.
 *
 * `amortize` throws on a payment too small to ever clear the balance, and on an
 * `asOf` that is not a payment date for the schedule - which is easy to get
 * wrong, because the payment date is a payday plus the offset, not the payday.
 * Checking at write time means a bad figure is rejected with the reason while
 * the person is still looking at the form, instead of being stored and taking
 * the whole savings screen down on every later read.
 */
function requireWorkableTerms(row: Mortgage, payAnchor: Date): void {
  const terms = termsFrom(row, payAnchor);

  if (row.cadenceDays === 14 && !isPaydayOn(terms.paymentAnchorDate, terms.asOf)) {
    throw new HttpError(
      400,
      "invalid_request",
      `The balance date has to be a payment date. Payments fall every ${String(row.cadenceDays)} days ` +
        `from ${terms.paymentAnchorDate}, which is ${String(row.offsetDays)} day(s) after a payday.`,
    );
  }

  try {
    amortize(terms, []);
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_request",
      error instanceof Error ? error.message : "Those terms do not work out.",
    );
  }
}

interface Projection {
  readonly payoffDate: PlainDate;
  readonly totalInterestCents: string;
  readonly paymentCount: number;
  readonly remainingPaymentCount: number;
  readonly nextPaymentDate: PlainDate | null;
  /**
   * Owing right now, derived rather than stored: what the last payment that has
   * already happened left behind. The stored balance is only true as at its own
   * date, and that date goes stale the moment it is typed.
   */
  readonly balanceTodayCents: string;
}

function project(result: ReturnType<typeof amortize>, today: PlainDate, openingCents: Cents): Projection {
  const upcoming = result.rows.filter((row) => compareDates(row.date, today) > 0);
  const past = result.rows.filter((row) => compareDates(row.date, today) <= 0);

  return {
    payoffDate: result.payoffDate,
    totalInterestCents: result.totalInterestCents.toString(),
    paymentCount: result.paymentCount,
    remainingPaymentCount: upcoming.length,
    nextPaymentDate: upcoming[0]?.date ?? null,
    // Before the first payment in the run, the opening balance still stands.
    balanceTodayCents: (past.length > 0 ? past[past.length - 1]!.balanceCents : openingCents).toString(),
  };
}

interface MortgagePanelInput {
  readonly row: Mortgage;
  readonly payAnchor: Date;
  readonly followsName: string;
  readonly prepayments: readonly Prepayment[];
  readonly today: PlainDate;
  readonly whatIfCents: Cents | null;
  readonly earmarkCents: Cents | null;
}

/**
 * The mortgage panel: the terms as stored, and everything derived from them.
 *
 * Two runs, because the useful question is the difference between them:
 *
 *  - `plan` applies every lump sum on record, including ones only intended.
 *  - `withoutFurther` applies only the ones actually paid, which is the "if we
 *    stop here" line. Dax's own workbook had an intention for next year with no
 *    way to see what dropping it would cost; this is that number.
 *
 * Lump sums dated on or before the balance date are left out of both: they are
 * already inside the balance that was typed in, and applying them again would
 * pay the mortgage off twice.
 */
function mortgagePanel(input: MortgagePanelInput) {
  const { row, today } = input;
  const terms = termsFrom(row, input.payAnchor);
  const asOf = terms.asOf;

  const forward = input.prepayments.filter((item) => compareDates(toPlainDate(item.paidOn), asOf) > 0);
  const planBaseline = forward.map(toLumpSum);
  const paidBaseline = forward.filter((item) => item.paid).map(toLumpSum);

  const base = {
    ...serialiseMortgage(row),
    /** Whose payday it follows, so the screen can say it in words. */
    follows: input.followsName,
    prepayments: input.prepayments.map(serialisePrepayment),
  };

  // The allowance is consumed by lump sums actually PAID in the window. What is
  // merely planned is reported separately: counting an intention against the
  // allowance would understate the room and talk them out of paying it.
  const thisYear = input.prepayments.filter(
    (item) => toPlainDate(item.paidOn).slice(0, 4) === today.slice(0, 4),
  );
  const room = lumpSumRoom({
    today,
    capCents: row.prepaymentCapCents,
    prepayments: thisYear.filter((item) => item.paid).map(toLumpSum),
    period: row.privilegePeriod,
  });
  const plannedThisYear = sumCents(thisYear.filter((item) => !item.paid).map((item) => item.cents));

  let plan: Projection;
  let withoutFurther: Projection;
  try {
    plan = project(amortize(terms, planBaseline), today, row.balanceCents);
    withoutFurther = project(amortize(terms, paidBaseline), today, row.balanceCents);
  } catch (error) {
    // Terms are validated on the way in, so this should be unreachable. If a
    // row from before that validation cannot be run forward, the screen says so
    // and still shows the terms, rather than returning a 500 for the balance
    // and the earmarks too.
    return {
      ...base,
      room: serialiseRoom(room, plannedThisYear),
      plan: null,
      withoutFurther: null,
      plannedBuys: null,
      whatIf: null,
      error: error instanceof Error ? error.message : "Those terms do not work out.",
    };
  }

  /**
   * What a lump sum would buy, on top of the plan already on record.
   *
   * The amount is whatever the screen asked about; failing that, whatever is
   * earmarked for the mortgage, since "we have set this much aside - what does
   * paying it do?" is the question the household actually has.
   */
  const whatIfCents = input.whatIfCents ?? input.earmarkCents;
  const whatIf =
    whatIfCents !== null && whatIfCents > 0n
      ? (() => {
          const delta = payoffDelta(terms, planBaseline, { date: today, cents: whatIfCents });
          return {
            lumpSumCents: whatIfCents.toString(),
            appliedOn: today,
            source: input.whatIfCents === null ? ("earmark" as const) : ("query" as const),
            payoffDate: delta.payoffDate,
            daysEarlier: delta.daysEarlier,
            interestSavedCents: delta.interestSavedCents.toString(),
            paymentsSaved: delta.paymentsSaved,
          };
        })()
      : null;

  return {
    ...base,
    room: serialiseRoom(room, plannedThisYear),
    plan,
    withoutFurther,
    // What the lump sums already on the plan are worth, against stopping now.
    plannedBuys: {
      daysEarlier: daysBetween(plan.payoffDate, withoutFurther.payoffDate),
      interestSavedCents: (
        BigInt(withoutFurther.totalInterestCents) - BigInt(plan.totalInterestCents)
      ).toString(),
      paymentsSaved: withoutFurther.paymentCount - plan.paymentCount,
      lumpSumCents: sumCents(
        forward.filter((item) => !item.paid).map((item) => item.cents),
      ).toString(),
    },
    whatIf,
    error: null,
  };
}

function serialiseRoom(room: ReturnType<typeof lumpSumRoom>, plannedCents: Cents) {
  return {
    capCents: room.capCents.toString(),
    usedCents: room.usedCents.toString(),
    roomCents: room.roomCents.toString(),
    /** On record for this window but not paid yet. */
    plannedCents: plannedCents.toString(),
    isUsedUp: room.isUsedUp,
    isTracked: room.capCents > 0n,
    resetsOn: room.resetsOn,
    period: room.period,
  };
}

/* -------------------------------------------------------------------------- */
/* Serialising                                                                */
/* -------------------------------------------------------------------------- */

function serialiseMortgage(row: Mortgage) {
  return {
    id: row.id,
    balanceCents: row.balanceCents.toString(),
    asOf: toPlainDate(row.asOf),
    rateBasisPoints: row.rateBasisPoints,
    paymentCents: row.paymentCents.toString(),
    payScheduleId: row.payScheduleId,
    offsetDays: row.offsetDays,
    periodsPerYear: row.periodsPerYear,
    cadenceDays: row.cadenceDays,
    compounding: row.compounding,
    prepaymentCapCents: row.prepaymentCapCents.toString(),
    privilegePeriod: row.privilegePeriod,
    version: row.version,
  };
}

function serialisePrepayment(row: Prepayment) {
  return {
    id: row.id,
    paidOn: toPlainDate(row.paidOn),
    cents: row.cents.toString(),
    note: row.note,
    paid: row.paid,
    version: row.version,
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

export async function registerSavingsRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the Savings screen shows. */
  app.get<{ Querystring: { lumpSumCents?: string } }>("/savings", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsedQuery = savingsQuery.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsedQuery.error.issues[0]?.message ?? "Could not read that request.",
      );
    }

    const household = await app.db.prisma.household.findUniqueOrThrow({
      where: { id: user.householdId },
      select: { timezone: true },
    });
    const today = todayInZone(household.timezone);

    const [accounts, goals, mortgageRow] = await Promise.all([
      app.db.prisma.account.findMany({
        where: { householdId: user.householdId, deletedAt: null, kind: "savings" },
        orderBy: { createdAt: "asc" },
      }),
      app.db.prisma.goal.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: [{ sortIndex: "asc" }, { createdAt: "asc" }],
      }),
      app.db.prisma.mortgage.findFirst({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          paySchedule: { select: { anchorDate: true, user: { select: { name: true } } } },
          prepayments: { where: { deletedAt: null }, orderBy: { paidOn: "asc" } },
        },
      }),
    ]);

    // The latest snapshot of each savings account. Every account is listed with
    // its own balance and not only as a total: the household has one, and if a
    // second ever appears, money must not disappear into a sum that cannot be
    // broken down.
    const balances = await Promise.all(
      accounts.map(async (account) => {
        const snapshot = await app.db.prisma.balanceSnapshot.findFirst({
          where: { accountId: account.id },
          orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
          select: {
            cents: true,
            asOf: true,
            enteredBy: { select: { id: true, name: true, initial: true } },
          },
        });

        return {
          id: account.id,
          name: account.name,
          version: account.version,
          // Never entered is a real state, and "0" would be a claim nobody made.
          cents: snapshot?.cents.toString() ?? null,
          asOf: snapshot?.asOf.toISOString() ?? null,
          enteredBy: snapshot?.enteredBy ?? null,
        };
      }),
    );

    const balanceCents = balances.reduce(
      (total, account) => total + (account.cents === null ? 0n : BigInt(account.cents)),
      0n,
    );

    const summary = computeSavings({
      balanceCents,
      earmarks: goals.map((goal) => ({
        id: goal.id,
        name: goal.name,
        setAsideCents: goal.savedCents,
        targetCents: goal.targetCents,
        purpose: goal.purpose,
        sortIndex: goal.sortIndex,
      })),
    });

    // Earmarks come back from the engine in display order, so the version each
    // row needs for an If-Match has to be looked up rather than zipped.
    const versions = new Map(goals.map((goal) => [goal.id, goal.version]));

    return reply.send({
      today,
      accounts: balances,
      hasSavingsAccount: accounts.length > 0,
      balanceCents: summary.balanceCents.toString(),
      earmarkedCents: summary.earmarkedCents.toString(),
      unallocatedCents: summary.unallocatedCents.toString(),
      isOverAllocated: summary.isOverAllocated,
      earmarks: summary.earmarks.map((earmark) => ({
        id: earmark.id,
        name: earmark.name,
        setAsideCents: earmark.setAsideCents.toString(),
        targetCents: earmark.targetCents === null ? null : earmark.targetCents.toString(),
        purpose: earmark.purpose,
        remainingCents: earmark.remainingCents === null ? null : earmark.remainingCents.toString(),
        pct: earmark.percent,
        isMet: earmark.isMet,
        version: versions.get(earmark.id) ?? 1,
      })),
      mortgage:
        mortgageRow === null
          ? null
          : mortgagePanel({
              row: mortgageRow,
              payAnchor: mortgageRow.paySchedule.anchorDate,
              followsName: mortgageRow.paySchedule.user.name,
              prepayments: mortgageRow.prepayments,
              today,
              whatIfCents: parsedQuery.data.lumpSumCents ?? null,
              earmarkCents: mortgageEarmark(summary)?.setAsideCents ?? null,
            }),
    });
  });

  /* ---- The mortgage ---- */

  app.post("/mortgage", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = mortgageCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read those mortgage terms.",
      );
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/mortgage",
      requestHash: hashRequest("POST", "/api/mortgage", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const schedule = await tx.paySchedule.findFirst({
          where: {
            id: input.payScheduleId,
            deletedAt: null,
            user: { householdId: user.householdId, deletedAt: null },
          },
          select: { anchorDate: true },
        });
        if (!schedule) {
          throw new HttpError(
            400,
            "invalid_request",
            "That payday schedule is not in this household.",
          );
        }

        const created = await tx.mortgage.create({
          data: {
            householdId: user.householdId,
            balanceCents: input.balanceCents,
            asOf: fromPlainDate(input.asOf),
            rateBasisPoints: input.rateBasisPoints,
            paymentCents: input.paymentCents,
            payScheduleId: input.payScheduleId,
            ...(input.offsetDays === undefined ? {} : { offsetDays: input.offsetDays }),
            ...(input.compounding === undefined ? {} : { compounding: input.compounding }),
            ...(input.prepaymentCapCents === undefined
              ? {}
              : { prepaymentCapCents: input.prepaymentCapCents }),
            updatedById: user.id,
          },
        });

        // Inside the transaction, so a refusal takes the row with it.
        requireWorkableTerms(created, schedule.anchorDate);

        await logCreation(tx as unknown as PrismaLike, {
          entity: "mortgage",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: {
            balanceCents: created.balanceCents.toString(),
            asOf: toPlainDate(created.asOf),
            paymentCents: created.paymentCents.toString(),
          },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "mortgage",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { mortgage: serialiseMortgage(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/mortgage/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = mortgagePatch.safeParse(request.body ?? {});
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
      path: `/api/mortgage/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/mortgage/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.mortgage.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That mortgage no longer exists.");

        if (typeof changes["payScheduleId"] === "string") {
          const schedule = await tx.paySchedule.findFirst({
            where: {
              id: changes["payScheduleId"],
              deletedAt: null,
              user: { householdId: user.householdId, deletedAt: null },
            },
            select: { id: true },
          });
          if (!schedule) {
            throw new HttpError(
              400,
              "invalid_request",
              "That payday schedule is not in this household.",
            );
          }
        }

        const applied = await applyVersionedChange<Mortgage>({
          tx: tx as unknown as PrismaLike,
          entity: "mortgage",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.mortgage.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.mortgage.update({
              where: { id: existing.id },
              data: {
                ...changes,
                // A plain date is stored as one.
                ...(typeof changes["asOf"] === "string"
                  ? { asOf: fromPlainDate(changes["asOf"]) }
                  : {}),
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: (row) => ({
            version: row.version,
            balanceCents: row.balanceCents.toString(),
            asOf: toPlainDate(row.asOf),
            rateBasisPoints: row.rateBasisPoints,
            paymentCents: row.paymentCents.toString(),
          }),
        });

        // Checked against what the row now says, not against what was sent: a
        // merged change from someone else could make the pair unworkable.
        const schedule = await tx.paySchedule.findUniqueOrThrow({
          where: { id: applied.row.payScheduleId },
          select: { anchorDate: true },
        });
        requireWorkableTerms(applied.row, schedule.anchorDate);

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "mortgage",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { mortgage: serialiseMortgage(applied.row), merged: applied.merged },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * Remove a mortgage.
   *
   * Soft, like everything else. A mortgage entered wrongly can be corrected
   * with a PATCH; this is for one that is gone - paid off, or refinanced into a
   * different set of terms - and it has to exist so the Savings panel and the
   * Year screen can be put right without SQL.
   */
  app.delete<{ Params: { id: string } }>("/mortgage/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "DELETE",
      path: `/api/mortgage/${request.params.id}`,
      requestHash: hashRequest("DELETE", `/api/mortgage/${request.params.id}`, {}),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.mortgage.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That mortgage no longer exists.");

        const applied = await applyVersionedChange<Mortgage>({
          tx: tx as unknown as PrismaLike,
          entity: "mortgage",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "soft_delete",
          changes: { deletedAt: new Date().toISOString() },
          readRow: () => tx.mortgage.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.mortgage.update({
              where: { id: existing.id },
              data: {
                deletedAt: new Date(),
                deletedById: user.id,
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: (row) => ({ version: row.version, balanceCents: row.balanceCents.toString() }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "mortgage",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { ok: true } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /* ---- Lump sums ---- */

  app.post<{ Params: { id: string } }>("/mortgage/:id/prepayments", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = prepaymentCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read that lump sum.",
      );
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);
    const path = `/api/mortgage/${request.params.id}/prepayments`;

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path,
      requestHash: hashRequest("POST", path, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const mortgage = await tx.mortgage.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
          select: { id: true },
        });
        if (!mortgage) throw new HttpError(404, "not_found", "That mortgage no longer exists.");

        const created = await tx.prepayment.create({
          data: {
            mortgageId: mortgage.id,
            paidOn: fromPlainDate(input.paidOn),
            cents: input.cents,
            note: input.note ?? null,
            ...(input.paid === undefined ? {} : { paid: input.paid }),
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "prepayment",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: {
            cents: created.cents.toString(),
            paidOn: toPlainDate(created.paidOn),
            paid: created.paid,
          },
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "prepayment",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { prepayment: serialisePrepayment(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/prepayments/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = prepaymentPatch.safeParse(request.body ?? {});
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
      path: `/api/prepayments/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/prepayments/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.prepayment.findFirst({
          where: {
            id: request.params.id,
            deletedAt: null,
            mortgage: { householdId: user.householdId, deletedAt: null },
          },
        });
        if (!existing) throw new HttpError(404, "not_found", "That lump sum no longer exists.");

        const applied = await applyVersionedChange<Prepayment>({
          tx: tx as unknown as PrismaLike,
          entity: "prepayment",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.prepayment.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.prepayment.update({
              where: { id: existing.id },
              data: {
                ...changes,
                ...(typeof changes["paidOn"] === "string"
                  ? { paidOn: fromPlainDate(changes["paidOn"]) }
                  : {}),
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: (row) => ({
            version: row.version,
            cents: row.cents.toString(),
            paidOn: toPlainDate(row.paidOn),
            paid: row.paid,
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "prepayment",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { prepayment: serialisePrepayment(applied.row), merged: applied.merged },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.delete<{ Params: { id: string } }>("/prepayments/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const baseVersion = requireBaseVersion(request);
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "DELETE",
      path: `/api/prepayments/${request.params.id}`,
      requestHash: hashRequest("DELETE", `/api/prepayments/${request.params.id}`, {}),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.prepayment.findFirst({
          where: {
            id: request.params.id,
            deletedAt: null,
            mortgage: { householdId: user.householdId, deletedAt: null },
          },
        });
        if (!existing) throw new HttpError(404, "not_found", "That lump sum no longer exists.");

        const applied = await applyVersionedChange<Prepayment>({
          tx: tx as unknown as PrismaLike,
          entity: "prepayment",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "soft_delete",
          changes: { deletedAt: new Date().toISOString() },
          readRow: () => tx.prepayment.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.prepayment.update({
              where: { id: existing.id },
              data: {
                deletedAt: new Date(),
                deletedById: user.id,
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: (row) => ({ version: row.version, cents: row.cents.toString() }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "prepayment",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { ok: true } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
