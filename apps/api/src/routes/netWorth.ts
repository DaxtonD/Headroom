/**
 * Net worth and the retirement outlook (HANDOFF section 4.5, 6.6 and 7.6).
 *
 * The arithmetic is `@headroom/core`'s and is golden-tested against the real
 * seed, including the parts an adviser would do differently: the growth rate
 * applied once rather than compounded, the mortgage payment redirected for a
 * fixed number of years, and a flat division for the drawdown.
 *
 * Every retirement input is an editable setting, never a constant
 * (section 4.5), and `compoundYearly` is offered as an alternative that is off
 * by default (section 14 q3).
 */
import { computeNetWorth, computeRetirement } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import { fromPlainDate, toPlainDate } from "../lib/timelineService.js";
import type { Asset } from "../generated/prisma/client.js";

const plainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date must look like 2026-11-22.");

/** Assets and liabilities are both stored as positive magnitudes. */
const positiveCents = wireCents.refine((value) => value >= 0n, {
  message: "Enter the amount without a minus sign; whether it is owned or owed is the 'kind'.",
});

const assetCreate = z
  .object({
    kind: z.enum(["asset", "liability"]),
    name: z.string().trim().min(1, "Give this a name.").max(120),
    cents: positiveCents,
    asOf: plainDate.optional(),
    note: z.string().trim().max(200).optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const assetPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cents: positiveCents.optional(),
    asOf: plainDate.nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const retirementBody = z
  .object({
    rrspCurrentPlusContribCents: positiveCents,
    mortgageMonthlyCents: positiveCents,
    redirectYears: z.number().int().min(0).max(60),
    flatGrowthPct: z.number().int().min(-100).max(1000),
    compoundYearly: z.boolean().optional(),
    drawdownYears: z.number().int().min(1).max(60),
    govPensionAnnualCents: positiveCents,
    retirementExpensesAnnualCents: positiveCents,
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

function serialiseAsset(row: Asset) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    cents: row.cents.toString(),
    asOf: row.asOf ? toPlainDate(row.asOf) : null,
    note: row.note,
    sortIndex: row.sortIndex,
    version: row.version,
  };
}

function snapshotAsset(row: Asset): Record<string, unknown> {
  return {
    version: row.version,
    name: row.name,
    cents: row.cents.toString(),
    asOf: row.asOf ? toPlainDate(row.asOf) : null,
    note: row.note,
    sortIndex: row.sortIndex,
  };
}

export async function registerNetWorthRoutes(app: FastifyInstance): Promise<void> {
  /** The whole Net worth screen, computed. */
  app.get("/net-worth", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const [assets, settings] = await Promise.all([
      app.db.prisma.asset.findMany({
        where: { householdId: user.householdId, deletedAt: null },
        orderBy: [{ kind: "asc" }, { sortIndex: "asc" }, { name: "asc" }],
      }),
      app.db.prisma.retirementSettings.findUnique({ where: { householdId: user.householdId } }),
    ]);

    const owned = assets.filter((row) => row.kind === "asset");
    const owed = assets.filter((row) => row.kind === "liability");

    const netWorth = computeNetWorth({
      assets: owned.map((row) => ({ name: row.name, cents: row.cents })),
      liabilities: owed.map((row) => ({ name: row.name, cents: row.cents })),
    });

    const retirement = settings
      ? computeRetirement({
          inputs: {
            rrspCurrentPlusContribCents: settings.rrspCurrentPlusContribCents,
            mortgageMonthlyCents: settings.mortgageMonthlyCents,
            redirectYears: settings.redirectYears,
            flatGrowthPct: settings.flatGrowthPct,
            compoundYearly: settings.compoundYearly,
            drawdownYears: settings.drawdownYears,
            govPensionAnnualCents: settings.govPensionAnnualCents,
            retirementExpensesAnnualCents: settings.retirementExpensesAnnualCents,
          },
          netWorthCents: netWorth.netWorthCents,
        })
      : null;

    return reply.send({
      assets: owned.map(serialiseAsset),
      liabilities: owed.map(serialiseAsset),
      assetsCents: netWorth.assetsCents,
      liabilitiesCents: netWorth.liabilitiesCents,
      netWorthCents: netWorth.netWorthCents,

      retirement: retirement
        ? {
            inputs: {
              rrspCurrentPlusContribCents: settings?.rrspCurrentPlusContribCents,
              mortgageMonthlyCents: settings?.mortgageMonthlyCents,
              redirectYears: settings?.redirectYears,
              flatGrowthPct: settings?.flatGrowthPct,
              compoundYearly: settings?.compoundYearly,
              drawdownYears: settings?.drawdownYears,
              govPensionAnnualCents: settings?.govPensionAnnualCents,
              retirementExpensesAnnualCents: settings?.retirementExpensesAnnualCents,
              version: settings?.version ?? 1,
            },
            mortgageRedirectCents: retirement.mortgageRedirectCents,
            baseBeforeGrowthCents: retirement.baseBeforeGrowthCents,
            growthCents: retirement.growthCents,
            rrspAt65Cents: retirement.rrspAt65Cents,
            annualDrawCents: retirement.annualDrawCents,
            extraPerYearCents: retirement.extraPerYearCents,
            extraPerMonthCents: retirement.extraPerMonthCents,
            totalForRetirementCents: retirement.totalForRetirementCents,
          }
        : null,
    });
  });

  app.post("/assets", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = assetCreate.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Could not read that entry.");
    }
    const input = parsed.data;
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/assets",
      requestHash: hashRequest("POST", "/api/assets", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.asset.create({
          data: {
            householdId: user.householdId,
            kind: input.kind,
            name: input.name,
            cents: input.cents,
            asOf: input.asOf ? fromPlainDate(input.asOf) : null,
            note: input.note ?? null,
            sortIndex: input.sortIndex ?? 0,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "asset",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: snapshotAsset(created),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "asset",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { asset: serialiseAsset(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/assets/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = assetPatch.safeParse(request.body ?? {});
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
      path: `/api/assets/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/assets/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.asset.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That entry no longer exists.");

        const applied = await applyVersionedChange<Asset>({
          tx: tx as unknown as PrismaLike,
          entity: "asset",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.asset.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) => {
            const data: Record<string, unknown> = { ...changes };
            if ("asOf" in changes) {
              data["asOf"] = changes["asOf"] ? fromPlainDate(changes["asOf"] as string) : null;
            }
            return tx.asset.update({
              where: { id: existing.id },
              data: { ...data, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            });
          },
          snapshot: snapshotAsset,
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "asset",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { asset: serialiseAsset(applied.row), merged: applied.merged } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * The retirement assumptions.
   *
   * A PUT rather than a PATCH: these are read and edited as one set on the
   * "Edit assumptions" screen, and a half-applied set of assumptions would
   * produce a number that corresponds to nothing.
   */
  app.put("/settings/retirement", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = retirementBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read those assumptions.",
      );
    }

    const { baseVersion: _ignored, ...input } = parsed.data;
    const key = requireIdempotencyKey(request);

    const existing = await app.db.prisma.retirementSettings.findUnique({
      where: { householdId: user.householdId },
    });

    // There is nothing to conflict with until the settings exist, so the
    // version requirement applies from the first edit onwards.
    const baseVersion = existing ? requireBaseVersion(request) : 1;

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "PUT",
      path: "/api/settings/retirement",
      requestHash: hashRequest("PUT", "/api/settings/retirement", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const current = await tx.retirementSettings.findUnique({
          where: { householdId: user.householdId },
        });

        if (!current) {
          const created = await tx.retirementSettings.create({
            data: {
              householdId: user.householdId,
              ...input,
              compoundYearly: input.compoundYearly ?? false,
              updatedById: user.id,
            },
          });

          await logCreation(tx as unknown as PrismaLike, {
            entity: "retirement_settings",
            entityId: user.householdId,
            userId: user.id,
            householdId: user.householdId,
            snapshot: { created: true },
          });

          await publishChange(tx, {
            householdId: user.householdId,
            entity: "retirement_settings",
            id: user.householdId,
            version: created.version,
            by: user.id,
          });

          return { statusCode: 201, body: { version: created.version } };
        }

        const changes: Record<string, unknown> = {
          ...input,
          compoundYearly: input.compoundYearly ?? false,
        };

        const applied = await applyVersionedChange({
          tx: tx as unknown as PrismaLike,
          entity: "retirement_settings",
          id: user.householdId,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.retirementSettings.findUnique({ where: { householdId: user.householdId } }),
          writeRow: (nextVersion) =>
            tx.retirementSettings.update({
              where: { householdId: user.householdId },
              data: { ...changes, version: nextVersion, updatedById: user.id, updatedAt: new Date() },
            }),
          snapshot: (row) => ({
            version: row.version,
            rrspCurrentPlusContribCents: row.rrspCurrentPlusContribCents.toString(),
            mortgageMonthlyCents: row.mortgageMonthlyCents.toString(),
            redirectYears: row.redirectYears,
            flatGrowthPct: row.flatGrowthPct,
            compoundYearly: row.compoundYearly,
            drawdownYears: row.drawdownYears,
            govPensionAnnualCents: row.govPensionAnnualCents.toString(),
            retirementExpensesAnnualCents: row.retirementExpensesAnnualCents.toString(),
          }),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "retirement_settings",
          id: user.householdId,
          version: applied.row.version,
          by: user.id,
        });

        return { statusCode: 200, body: { version: applied.row.version, merged: applied.merged } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
