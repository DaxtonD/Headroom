/**
 * Changing a bill, a paycheque or a one-off (HANDOFF section 9 and 16).
 *
 * This is the route the integrity rules exist for. Every request:
 *
 *  - sends only the fields the user actually changed (field-level PATCH, never
 *    a whole object, never a computed value);
 *  - states the version it was based on, or gets a 428;
 *  - carries an Idempotency-Key, so a retry cannot apply it twice;
 *  - runs inside one transaction that locks the row, writes the change, writes
 *    the audit entry and writes the idempotency receipt together.
 *
 * State changes are explicit commands (`verified`, `cleared`, `anchorId`),
 * and repeating one that is already true is a no-op that returns the current
 * state (section 16.1 rule 6).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishChange } from "../lib/changeStream.js";
import { HttpError, hashRequest, requireBaseVersion, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { wireCents } from "../lib/wire.js";
import { applyVersionedChange, logCreation, type PrismaLike } from "../lib/versioning.js";
import { fromPlainDate, toPlainDate } from "../lib/timelineService.js";
import type { ActivityAction, Occurrence } from "../generated/prisma/client.js";

/**
 * Amounts arrive as integer cents in a string. See `lib/wire.ts` - parsing a
 * human-typed decimal is the UI's job, not this route's.
 */
const centsSchema = wireCents;

const plainDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date must look like 2026-11-22.");

/**
 * Only these fields may be changed, and each is optional: the client sends
 * exactly what the user touched.
 */
const patchBody = z
  .object({
    cents: centsSchema.optional(),
    name: z.string().trim().min(1, "Give this a name.").max(120).optional(),
    verified: z.boolean().optional(),
    cleared: z.boolean().optional(),
    // null means "move it to before the first upcoming paycheque".
    anchorOccurrenceId: z.string().uuid().nullable().optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    date: plainDateSchema.optional(),
    // Accepted and ignored here; it is read from the body by requireBaseVersion.
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const createBody = z
  .object({
    name: z.string().trim().min(1, "Give this a name.").max(120),
    cents: centsSchema,
    kind: z.enum(["paycheque", "bill", "deposit", "transfer"]).default("bill"),
    // A one-off is either dated, or hung off a paycheque.
    date: plainDateSchema.optional(),
    anchorOccurrenceId: z.string().uuid().nullable().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    sortIndex: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

/** The shape every occurrence response takes. Cents become strings. */
function serialiseOccurrence(row: Occurrence) {
  return {
    id: row.id,
    name: row.name,
    cents: row.cents.toString(),
    kind: row.kind,
    withdrawal: row.withdrawal,
    date: row.date ? toPlainDate(row.date) : null,
    anchorOccurrenceId: row.anchorOccurrenceId,
    sortIndex: row.sortIndex,
    isOneOff: row.isOneOff,
    verified: row.verifiedAt !== null,
    verifiedById: row.verifiedById,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    cleared: row.clearedAt !== null,
    clearedById: row.clearedById,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    ownerUserId: row.ownerUserId,
    version: row.version,
  };
}

/**
 * What goes in the audit log, and what a 409 returns as `current`.
 *
 * `version` is here so the client can resend "Use mine" against the version
 * that actually won, rather than having to refetch the row first. The audit
 * log is unaffected: it only records the fields a change touched, and
 * `version` is never one of them.
 */
function snapshotOccurrence(row: Occurrence): Record<string, unknown> {
  return {
    version: row.version,
    name: row.name,
    cents: row.cents.toString(),
    date: row.date ? toPlainDate(row.date) : null,
    anchorOccurrenceId: row.anchorOccurrenceId,
    sortIndex: row.sortIndex,
    verified: row.verifiedAt !== null,
    cleared: row.clearedAt !== null,
    ownerUserId: row.ownerUserId,
  };
}

/**
 * Which single action best describes this change, for the history feed.
 * "Carol verified Power" reads better than "Carol updated Power".
 */
function actionFor(changes: Record<string, unknown>): ActivityAction {
  const keys = Object.keys(changes);
  if (keys.length === 1) {
    if ("verified" in changes) return changes["verified"] === true ? "verify" : "unverify";
    if ("cleared" in changes) return changes["cleared"] === true ? "clear" : "unclear";
    if ("anchorOccurrenceId" in changes || "sortIndex" in changes) return "move";
  }
  if (keys.every((key) => key === "anchorOccurrenceId" || key === "sortIndex")) return "move";
  return "update";
}

export async function registerOccurrenceRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { id: string } }>("/occurrences/:id", async (request, reply) => {
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

    // `baseVersion` is routing information, not a change.
    const { baseVersion: _ignored, ...requested } = parsed.data;
    const changes = Object.fromEntries(
      Object.entries(requested).filter(([, value]) => value !== undefined),
    );

    if (Object.keys(changes).length === 0) {
      throw new HttpError(
        400,
        "nothing_to_change",
        "That request did not change anything. Send only the fields the user edited.",
      );
    }

    const baseVersion = requireBaseVersion(request);
    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "PATCH",
      path: `/api/occurrences/${request.params.id}`,
      requestHash: hashRequest("PATCH", `/api/occurrences/${request.params.id}`, request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.occurrence.findFirst({
          where: { id: request.params.id, householdId: user.householdId, deletedAt: null },
        });
        if (!existing) throw new HttpError(404, "not_found", "That item no longer exists.");

        // A command that is already true is a no-op (section 16.1 rule 6):
        // clearing an already-cleared bill must not clear it twice.
        const effective = dropNoOps(changes, existing);
        if (Object.keys(effective).length === 0) {
          return {
            statusCode: 200,
            body: {
              occurrence: serialiseOccurrence(existing),
              merged: false,
              noop: true,
            },
          };
        }

        const applied = await applyVersionedChange<Occurrence>({
          tx: tx as unknown as PrismaLike,
          entity: "occurrence",
          id: existing.id,
          baseVersion,
          userId: user.id,
          householdId: user.householdId,
          action: actionFor(effective),
          changes: effective,
          readRow: () => tx.occurrence.findUnique({ where: { id: existing.id } }),
          writeRow: (nextVersion) =>
            tx.occurrence.update({
              where: { id: existing.id },
              data: {
                ...toPrismaData(effective, user.id),
                version: nextVersion,
                updatedById: user.id,
                updatedAt: new Date(),
              },
            }),
          snapshot: snapshotOccurrence,
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "occurrence",
          id: applied.row.id,
          version: applied.row.version,
          by: user.id,
        });

        return {
          statusCode: 200,
          body: {
            occurrence: serialiseOccurrence(applied.row),
            // True when the server combined this with someone else's change to
            // other fields, so the UI can say so quietly.
            merged: applied.merged,
            noop: false,
          },
        };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/occurrences", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That one-off could not be read.",
      );
    }
    const input = parsed.data;

    // The database enforces this too; failing here gives a better message.
    const dated = input.date !== undefined;
    const anchored = input.anchorOccurrenceId !== undefined;
    if (dated && anchored) {
      throw new HttpError(
        400,
        "invalid_request",
        "A one-off is either on a date or attached to a payday, not both.",
      );
    }

    const idempotencyKey = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key: idempotencyKey,
      userId: user.id,
      method: "POST",
      path: "/api/occurrences",
      requestHash: hashRequest("POST", "/api/occurrences", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        if (input.anchorOccurrenceId) {
          const anchor = await tx.occurrence.findFirst({
            where: {
              id: input.anchorOccurrenceId,
              householdId: user.householdId,
              kind: "paycheque",
              deletedAt: null,
            },
            select: { id: true },
          });
          if (!anchor) {
            throw new HttpError(400, "invalid_anchor", "That payday is not one we can attach this to.");
          }
        }

        const created = await tx.occurrence.create({
          data: {
            householdId: user.householdId,
            name: input.name,
            cents: input.cents,
            kind: input.kind,
            // Dated items are placed by date; everything else hangs off a
            // payday, with no anchor meaning "now".
            withdrawal: dated ? "auto" : "flexible",
            date: dated ? fromPlainDate(input.date as string) : null,
            anchorOccurrenceId: input.anchorOccurrenceId ?? null,
            sortIndex: input.sortIndex ?? 0,
            isOneOff: true,
            ownerUserId: input.ownerUserId ?? null,
            createdById: user.id,
            updatedById: user.id,
          },
        });

        await logCreation(tx as unknown as PrismaLike, {
          entity: "occurrence",
          entityId: created.id,
          userId: user.id,
          householdId: user.householdId,
          snapshot: snapshotOccurrence(created),
        });

        await publishChange(tx, {
          householdId: user.householdId,
          entity: "occurrence",
          id: created.id,
          version: created.version,
          by: user.id,
        });

        return { statusCode: 201, body: { occurrence: serialiseOccurrence(created) } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /** Per-item history, which the Upcoming screen shows when a row is expanded. */
  app.get<{ Params: { id: string } }>("/occurrences/:id/history", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const occurrence = await app.db.prisma.occurrence.findFirst({
      where: { id: request.params.id, householdId: user.householdId },
      select: { id: true },
    });
    if (!occurrence) throw new HttpError(404, "not_found", "That item no longer exists.");

    const entries = await app.db.prisma.activity.findMany({
      where: { entity: "occurrence", entityId: request.params.id },
      orderBy: { versionAfter: "desc" },
      take: 50,
      select: {
        id: true,
        at: true,
        action: true,
        versionAfter: true,
        fields: true,
        beforeJson: true,
        afterJson: true,
        user: { select: { id: true, name: true, initial: true } },
      },
    });

    return reply.send({
      history: entries.map((entry) => ({
        id: entry.id,
        at: entry.at.toISOString(),
        action: entry.action,
        versionAfter: entry.versionAfter,
        fields: entry.fields,
        before: entry.beforeJson,
        after: entry.afterJson,
        by: entry.user,
      })),
    });
  });
}

/**
 * Remove parts of the request that ask for what is already true.
 *
 * Without this, verifying an already-verified bill would bump the version and
 * write a history entry saying nothing happened.
 */
function dropNoOps(
  changes: Record<string, unknown>,
  current: Occurrence,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(changes)) {
    switch (field) {
      case "verified":
        if (value !== (current.verifiedAt !== null)) result[field] = value;
        break;
      case "cleared":
        if (value !== (current.clearedAt !== null)) result[field] = value;
        break;
      case "cents":
        if (value !== current.cents) result[field] = value;
        break;
      case "name":
        if (value !== current.name) result[field] = value;
        break;
      case "sortIndex":
        if (value !== current.sortIndex) result[field] = value;
        break;
      case "anchorOccurrenceId":
        if ((value ?? null) !== current.anchorOccurrenceId) result[field] = value;
        break;
      case "ownerUserId":
        if ((value ?? null) !== current.ownerUserId) result[field] = value;
        break;
      case "date": {
        const next = value as string;
        if (!current.date || toPlainDate(current.date) !== next) result[field] = value;
        break;
      }
      default:
        result[field] = value;
    }
  }

  return result;
}

/**
 * Translate the API's field names into database columns.
 *
 * `verified` and `cleared` are booleans to the client but a who-and-when pair
 * in the database, because "Carol verified this" has to be answerable.
 */
function toPrismaData(changes: Record<string, unknown>, userId: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  // The server clock is authoritative for these timestamps.
  const now = new Date();

  for (const [field, value] of Object.entries(changes)) {
    switch (field) {
      case "verified":
        if (value === true) {
          data["verifiedAt"] = now;
          data["verifiedById"] = userId;
        } else {
          data["verifiedAt"] = null;
          data["verifiedById"] = null;
        }
        break;
      case "cleared":
        if (value === true) {
          data["clearedAt"] = now;
          data["clearedById"] = userId;
        } else {
          data["clearedAt"] = null;
          data["clearedById"] = null;
        }
        break;
      case "date":
        data["date"] = fromPlainDate(value as string);
        break;
      default:
        data[field] = value;
    }
  }

  return data;
}
