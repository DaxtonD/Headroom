/**
 * The monthly and yearly budget (HANDOFF section 4.3, 6.6 and 7.4).
 *
 * This is page 2 of Carol's spreadsheet. The totals and the per-line shares
 * are computed by `@headroom/core`, which is golden-tested against the real
 * seed, so nothing here does arithmetic of its own.
 *
 * Two details the brief is specific about:
 *
 *  - "% of Total" is each line's share of **its own section** (fixed or
 *    variable), not of income. A line that is 38% of fixed expenses is not 38%
 *    of what the household earns.
 *  - The yearly income figure is Carol's stated number, which is not exactly
 *    the monthly figure times twelve (section 14 q2). Hers is used as given;
 *    line items are the ones multiplied by twelve.
 */
import { cadenceOfSchedule, computeBudget, monthlyFigureFor } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { scheduleSchema } from "../lib/generateService.js";
import { wireCents } from "../lib/wire.js";
import type { BudgetLine } from "../generated/prisma/client.js";

const createBody = z
  .object({
    name: z.string().trim().min(1, "Give this line a name.").max(120),
    section: z.enum(["fixed", "variable"]),
    monthlyCents: wireCents,
    /** Only where the yearly cost is not twelve times the monthly one. */
    yearlyCentsOverride: wireCents.nullable().optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    section: z.enum(["fixed", "variable"]).optional(),
    monthlyCents: wireCents.optional(),
    yearlyCentsOverride: wireCents.nullable().optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * Income is a household setting rather than a list of lines: Carol states a
 * net monthly and a net yearly figure, and they do not agree exactly.
 */
const incomeBody = z
  .object({
    netMonthlyCents: wireCents,
    netYearlyCents: wireCents,
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

function serialiseLine(row: BudgetLine) {
  return {
    id: row.id,
    name: row.name,
    section: row.section,
    monthlyCents: row.monthlyCents.toString(),
    yearlyCentsOverride: row.yearlyCentsOverride?.toString() ?? null,
    sortIndex: row.sortIndex,
    version: row.version,
  };
}

function snapshotLine(row: BudgetLine): Record<string, unknown> {
  return {
    version: row.version,
    name: row.name,
    section: row.section,
    monthlyCents: row.monthlyCents.toString(),
    yearlyCentsOverride: row.yearlyCentsOverride?.toString() ?? null,
    sortIndex: row.sortIndex,
  };
}

export async function registerBudgetRoutes(app: FastifyInstance): Promise<void> {
  /** The whole Budget screen, computed. */
  app.get("/budget", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const [household, lines, templates] = await Promise.all([
      app.db.prisma.household.findUniqueOrThrow({
        where: { id: user.householdId },
        select: { netMonthlyIncomeCents: true, netYearlyIncomeCents: true, version: true },
      }),
      app.db.prisma.budgetLine.findMany({
        // Income is a household setting, not a line, so only the two expense
        // sections are read here.
        where: {
          householdId: user.householdId,
          deletedAt: null,
          section: { in: ["fixed", "variable"] },
        },
        orderBy: [{ section: "asc" }, { sortIndex: "asc" }, { name: "asc" }],
      }),
      // Recurring bills carry their own section, so an expense entered once in
      // Manage appears on the timeline AND here, with no second figure to keep
      // in step. Archived bills are excluded: they no longer cost anything.
      app.db.prisma.template.findMany({
        where: {
          householdId: user.householdId,
          deletedAt: null,
          active: true,
          section: { in: ["fixed", "variable"] },
          kind: { in: ["bill", "transfer"] },
        },
        select: {
          id: true,
          name: true,
          section: true,
          defaultCents: true,
          scheduleJson: true,
          monthlyBudgetOverrideCents: true,
          version: true,
        },
        orderBy: { name: "asc" },
      }),
    ]);

    /**
     * What each recurring bill costs per month, derived from how often it
     * actually comes out.
     *
     * Biweekly is 26 times a year, so 26/12 of the amount, which is more than
     * twice it. A stated override wins where Carol's sheet says otherwise.
     */
    const fromBills = templates.flatMap((template) => {
      const parsedSchedule = scheduleSchema.safeParse(template.scheduleJson);
      // A bill with an unreadable schedule is left out rather than guessed at.
      if (!parsedSchedule.success) return [];

      const figure = monthlyFigureFor({
        cents: template.defaultCents,
        cadence: cadenceOfSchedule(parsedSchedule.data),
        monthlyOverrideCents: template.monthlyBudgetOverrideCents,
      });

      return [
        {
          templateId: template.id,
          name: template.name,
          section: template.section === "fixed" ? ("fixed" as const) : ("variable" as const),
          monthlyCents: figure.monthlyCents,
          yearlyCents: figure.yearlyCents,
          derivedMonthlyCents: figure.derivedMonthlyCents,
          overridden: figure.overridden,
          version: template.version,
        },
      ];
    });

    const budget = computeBudget({
      income: {
        netMonthlyCents: household.netMonthlyIncomeCents,
        netYearlyCents: household.netYearlyIncomeCents,
      },
      lines: [
        ...fromBills.map((bill) => ({
          name: bill.name,
          section: bill.section,
          monthlyCents: bill.monthlyCents,
          yearlyCentsOverride: bill.yearlyCents,
        })),
        ...lines.map((line) => ({
          id: line.id,
          name: line.name,
          section: line.section === "fixed" ? ("fixed" as const) : ("variable" as const),
          monthlyCents: line.monthlyCents,
          yearlyCentsOverride: line.yearlyCentsOverride ?? undefined,
        })),
      ],
    });

    // Ids are not the engine's concern, so they are matched back on here for
    // the UI to edit by. A line comes from either a recurring bill or a
    // budget-only category, and the UI needs to know which, because the two
    // are edited in different places.
    const categoriesByName = new Map(lines.map((line) => [line.section + "|" + line.name, line]));
    const billsByName = new Map(fromBills.map((bill) => [bill.section + "|" + bill.name, bill]));

    const withIds = (section: "fixed" | "variable") =>
      budget[section].lines.map((line) => {
        const bill = billsByName.get(section + "|" + line.name);
        if (bill) {
          return {
            id: bill.templateId,
            source: "bill" as const,
            name: line.name,
            monthlyCents: line.monthlyCents,
            yearlyCents: line.yearlyCents,
            sharePct: line.sharePct,
            version: bill.version,
            // Reported so the gap between a stated figure and the derived one
            // is visible rather than hidden.
            derivedMonthlyCents: bill.derivedMonthlyCents,
            overridden: bill.overridden,
          };
        }

        const row = categoriesByName.get(section + "|" + line.name);
        return {
          id: row?.id ?? null,
          source: "category" as const,
          name: line.name,
          monthlyCents: line.monthlyCents,
          yearlyCents: line.yearlyCents,
          sharePct: line.sharePct,
          version: row?.version ?? 1,
          derivedMonthlyCents: null,
          overridden: false,
        };
      });

    return reply.send({
      income: {
        netMonthlyCents: budget.income.netMonthlyCents,
        netYearlyCents: budget.income.netYearlyCents,
        householdVersion: household.version,
      },
      fixed: {
        lines: withIds("fixed"),
        monthlyCents: budget.fixed.monthlyCents,
        yearlyCents: budget.fixed.yearlyCents,
      },
      variable: {
        lines: withIds("variable"),
        monthlyCents: budget.variable.monthlyCents,
        yearlyCents: budget.variable.yearlyCents,
      },
      totalMonthlyCents: budget.totalMonthlyCents,
      totalYearlyCents: budget.totalYearlyCents,
      balanceMonthlyCents: budget.balanceMonthlyCents,
      balanceYearlyCents: budget.balanceYearlyCents,
    });
  });

  app.get("/budget-lines", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const lines = await app.db.prisma.budgetLine.findMany({
      where: { householdId: user.householdId, deletedAt: null },
      orderBy: [{ section: "asc" }, { sortIndex: "asc" }, { name: "asc" }],
    });

    return reply.send({ lines: lines.map(serialiseLine) });
  });

  app.post("/budget-lines", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That budget line could not be read.",
      );
    }
    const input = parsed.data;
    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: "/api/budget-lines",
      requestHash: hashRequest("POST", "/api/budget-lines", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.budgetLine.create({
          data: {
            householdId: user.householdId,
            name: input.name,
            section: input.section,
            monthlyCents: input.monthlyCents,
            yearlyCentsOverride: input.yearlyCentsOverride ?? null,
            sortIndex: input.sortIndex ?? 0,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "budget_line",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: snapshotLine(created),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "budget_line",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { line: serialiseLine(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/budget-lines/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = patchBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That change could not be read.",
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
    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "PATCH",
      path: `/api/budget-lines/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/budget-lines/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.budgetLine.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That budget line no longer exists.");

        const applied = await applyVersionedChange<BudgetLine>({
          tx: tx as unknown as PrismaLike,
          entity: "budget_line",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.budgetLine.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.budgetLine.update({
              where: { id: existing.id },
              data: { ...changes, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            }),
          snapshot: snapshotLine,
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "budget_line",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { line: serialiseLine(applied.row), merged: applied.merged },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /** Soft delete: nothing disappears without a trace (section 8). */
  app.delete<{ Params: { id: string } }>("/budget-lines/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const baseVersion = requireBaseVersion(request);
    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "DELETE",
      path: `/api/budget-lines/${request.params.id}`,
      requestHash: hashRequest("DELETE", `/api/budget-lines/${request.params.id}`, {}),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.budgetLine.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That budget line no longer exists.");

        const applied = await applyVersionedChange<BudgetLine>({
          tx: tx as unknown as PrismaLike,
          entity: "budget_line",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "soft_delete",
          changes: { deletedAt: new Date().toISOString() },
          readRow: () => tx.budgetLine.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.budgetLine.update({
              where: { id: existing.id },
              data: {
                deletedAt: new Date(),
                deletedById: user.id,
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: snapshotLine,
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "budget_line",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { ok: true } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /** Carol's stated net income, which the Budget screen treats as editable. */
  app.put("/settings/income", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = incomeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That income could not be read.",
      );
    }

    const baseVersion = requireBaseVersion(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const changes = {
      netMonthlyIncomeCents: parsed.data.netMonthlyCents,
      netYearlyIncomeCents: parsed.data.netYearlyCents,
    };

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "PUT",
      path: "/api/settings/income",
      requestHash: hashRequest("PUT", "/api/settings/income", request.body),
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
            netMonthlyIncomeCents: row.netMonthlyIncomeCents.toString(),
            netYearlyIncomeCents: row.netYearlyIncomeCents.toString(),
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
            income: {
              netMonthlyCents: applied.row.netMonthlyIncomeCents.toString(),
              netYearlyCents: applied.row.netYearlyIncomeCents.toString(),
              householdVersion: applied.row.version,
            },
            merged: applied.merged,
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
