/**
 * Templates and generation (HANDOFF section 6.5 and 9).
 *
 * A template is the recurring fact: "the mortgage comes out the day after each
 * of Dax's paydays, usually $987.65". The occurrences it produces are separate
 * rows, and editing one of those never edits the template - that is a
 * deliberate, separate choice ("change for all future").
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import {
  generateForHousehold,
  regenerateQuietly,
  scheduleSchema,
} from "../lib/generateService.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { wireCents } from "../lib/wire.js";
import type { Template } from "../generated/prisma/client.js";

/**
 * One parser for amounts, shared with every other route.
 *
 * This file used to define its own, which meant two places decided what an
 * amount on the wire looks like. That is the seam the $186-becomes-$18,600 bug
 * came through, so there is deliberately only one now.
 */
const centsSchema = wireCents;

const createBody = z
  .object({
    name: z.string().trim().min(1, "Give this a name.").max(120),
    kind: z.enum(["paycheque", "bill", "deposit", "transfer"]),
    /** A magnitude; the direction comes from `kind`. */
    defaultCents: centsSchema,
    withdrawal: z.enum(["auto", "flexible"]),
    schedule: scheduleSchema,
    ownerUserId: z.string().uuid().nullable().optional(),
    section: z.enum(["income", "fixed", "variable"]).nullable().optional(),
    /** Overrides the monthly figure Headroom would derive from the cadence. */
    monthlyBudgetOverrideCents: centsSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    defaultCents: centsSchema.optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    section: z.enum(["income", "fixed", "variable"]).nullable().optional(),
    monthlyBudgetOverrideCents: centsSchema.nullable().optional(),
    /** False archives it: generation stops, history stays. */
    active: z.boolean().optional(),
    schedule: scheduleSchema.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

function serialiseTemplate(row: Template) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    defaultCents: row.defaultCents.toString(),
    withdrawal: row.withdrawal,
    scheduleType: row.scheduleType,
    schedule: row.scheduleJson,
    ownerUserId: row.ownerUserId,
    section: row.section,
    monthlyBudgetOverrideCents: row.monthlyBudgetOverrideCents?.toString() ?? null,
    active: row.active,
    version: row.version,
  };
}

function snapshotTemplate(row: Template): Record<string, unknown> {
  return {
    version: row.version,
    name: row.name,
    defaultCents: row.defaultCents.toString(),
    ownerUserId: row.ownerUserId,
    section: row.section,
    monthlyBudgetOverrideCents: row.monthlyBudgetOverrideCents?.toString() ?? null,
    active: row.active,
    schedule: JSON.stringify(row.scheduleJson),
  };
}

/** The engine's schedule type, mapped onto the database's enum. */
function scheduleTypeFor(schedule: z.infer<typeof scheduleSchema>) {
  switch (schedule.type) {
    case "monthly":
      return "monthly" as const;
    case "monthly_last":
      return "monthly_last" as const;
    case "relative_to_pay":
      return "relative_to_pay" as const;
    case "biweekly":
      return "biweekly" as const;
    case "flexible":
      return "flexible" as const;
    default: {
      const exhaustive: never = schedule;
      throw new Error(`Unknown schedule: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/templates", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    // Archived templates are included: the Manage screen lists them under
    // "Archived" so a bill that was paid off can be brought back.
    const templates = await app.db.prisma.template.findMany({
      where: { householdId: user.householdId, deletedAt: null },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });

    return reply.send({ templates: templates.map(serialiseTemplate) });
  });

  app.post("/templates", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That template could not be read.",
      );
    }
    const input = parsed.data;

    // The database CHECK enforces this too; the message here is friendlier.
    if (input.withdrawal === "auto" && input.schedule.type === "flexible") {
      throw new HttpError(
        400,
        "invalid_request",
        "A flexible schedule produces undated items, so it cannot be an automatic withdrawal.",
      );
    }
    if (input.withdrawal === "flexible" && input.schedule.type !== "flexible") {
      throw new HttpError(
        400,
        "invalid_request",
        "A dated schedule produces dated items, so it cannot be flexible.",
      );
    }

    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: "/api/templates",
      requestHash: hashRequest("POST", "/api/templates", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const created = await tx.template.create({
          data: {
            householdId: user.householdId,
            name: input.name,
            kind: input.kind,
            defaultCents: input.defaultCents,
            withdrawal: input.withdrawal,
            scheduleType: scheduleTypeFor(input.schedule),
            scheduleJson: input.schedule,
            ownerUserId: input.ownerUserId ?? null,
            section: input.section ?? null,
            monthlyBudgetOverrideCents: input.monthlyBudgetOverrideCents ?? null,
            active: input.active ?? true,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "template",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: snapshotTemplate(created),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "template",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { template: serialiseTemplate(created) } };
      },
    });


    // Automatic, because a button for this was a step that could be forgotten
    // and whose absence looked like a bug: an expense was added and the ledger
    // did not show it. Runs after the write has committed, so it cannot undo
    // it.
    await regenerateQuietly(app.db.prisma, user.householdId, app.log);
    return reply.status(result.statusCode).send(result.body);
  });

  app.patch<{ Params: { id: string } }>("/templates/:id", async (request, reply) => {
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
      path: `/api/templates/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/templates/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.template.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That template no longer exists.");

        const applied = await applyVersionedChange<Template>({
          tx: tx as unknown as PrismaLike,
          entity: "template",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: "update",
          changes,
          readRow: () => tx.template.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) => {
            const data: Record<string, unknown> = { ...changes };
            if ("schedule" in changes) {
              const schedule = changes["schedule"] as z.infer<typeof scheduleSchema>;
              data["scheduleJson"] = schedule;
              data["scheduleType"] = scheduleTypeFor(schedule);
              delete data["schedule"];
            }

            return tx.template.update({
              where: { id: existing.id },
              data: {
                ...data,
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            });
          },
          snapshot: snapshotTemplate,
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "template",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: { template: serialiseTemplate(applied.row), merged: applied.merged },
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
   * Bring occurrences up to date with the templates.
   *
   * Safe to call as often as you like: it creates only what is missing and
   * never touches an occurrence that already exists, so no edit, verification
   * or move is ever undone.
   */
  app.post("/templates/generate", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: "/api/templates/generate",
      requestHash: hashRequest("POST", "/api/templates/generate", request.body ?? {}),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const generation = await generateForHousehold(tx, user.householdId);

        if (generation.created > 0) {
          await publishChange(tx, {
            householdId: user.householdId,
            entity: "occurrence",
            id: user.householdId,
            version: 1,
            by: user.id,
          });
        }

        return { statusCode: 200, body: { generation } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
