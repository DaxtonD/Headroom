/**
 * Optimistic concurrency, auto-merge and the audit trail
 * (HANDOFF section 16.1 rule 3 and section 16.4).
 *
 * The rule in one paragraph: every mutable row has a `version`, and every
 * change states the version it was based on. Inside one transaction the row is
 * locked, and then:
 *
 *  - the version has not moved        -> apply, bump, log, 200;
 *  - it moved, but only other FIELDS  -> apply on top, bump, log, 200 merged;
 *  - it moved and the SAME field      -> 409, naming who changed it and to what.
 *
 * Two people editing different things about the same bill should both succeed.
 * Two people typing different amounts for the same bill is a decision a human
 * has to make, which is why it is never merged silently (section 16.6).
 */
import type { ActivityAction, Prisma, PrismaClient } from "../generated/prisma/client.js";
import { HttpError } from "./http.js";

/** A Prisma client or an open transaction; both expose the same model API. */
export type PrismaLike = Omit<PrismaClient, "$connect" | "$disconnect" | "$transaction" | "$extends">;

export interface ConflictDetails {
  readonly changedFields: readonly string[];
  readonly changedBy: { readonly id: string; readonly name: string; readonly initial: string };
  readonly changedAt: Date;
}

export class VersionConflictError extends HttpError {
  constructor(
    readonly current: unknown,
    readonly conflict: ConflictDetails,
  ) {
    super(409, "version_conflict", buildConflictMessage(conflict), {
      current,
      changedFields: conflict.changedFields,
      changedBy: conflict.changedBy,
      changedAt: conflict.changedAt.toISOString(),
    });
  }
}

/**
 * The wording the UI shows: "Carol changed this to $140.00 (verified) 2
 * minutes ago" is assembled client-side from the details; this is the fallback
 * sentence and what ends up in logs.
 */
function buildConflictMessage(conflict: ConflictDetails): string {
  const fields = [...conflict.changedFields];
  const list =
    fields.length === 1
      ? describeField(fields[0] as string)
      : `${fields.slice(0, -1).map(describeField).join(", ")} and ${describeField(fields.at(-1) as string)}`;

  return `${conflict.changedBy.name} changed ${list} first. Have a look before saving.`;
}

function describeField(field: string): string {
  switch (field) {
    case "cents":
      return "the amount";
    case "verified":
      return "whether this is verified";
    case "cleared":
      return "whether this has been paid";
    case "anchorOccurrenceId":
      return "which payday this sits under";
    case "sortIndex":
      return "the order";
    case "name":
      return "the name";
    default:
      return field;
  }
}

/**
 * Which physical table a lockable entity lives in, and the column its primary
 * key is in.
 *
 * Most tables are keyed by `id`, but `retirement_settings` is one row per
 * household and is keyed by `householdId`. Assuming `id` everywhere made the
 * lock query fail with `column "id" does not exist` the first time those
 * settings were edited rather than created.
 */
const ENTITY_TABLES: Record<string, { table: string; idColumn: string }> = {
  occurrence: { table: "occurrence", idColumn: "id" },
  household: { table: "household", idColumn: "id" },
  goal: { table: "goal", idColumn: "id" },
  template: { table: "template", idColumn: "id" },
  budget_line: { table: "budget_line", idColumn: "id" },
  asset: { table: "asset", idColumn: "id" },
  reimbursement: { table: "reimbursement", idColumn: "id" },
  retirement_settings: { table: "retirement_settings", idColumn: "householdId" },
  pay_schedule: { table: "pay_schedule", idColumn: "id" },
  account: { table: "account", idColumn: "id" },
  user: { table: "user", idColumn: "id" },
};

/**
 * Lock a row for the rest of the transaction and read its current version.
 *
 * `SELECT ... FOR UPDATE` is the whole point: two requests arriving at the
 * same instant are serialised here, so they cannot both read version 3 and
 * both write version 4.
 */
export async function lockRowVersion(
  tx: PrismaLike,
  entity: string,
  id: string,
): Promise<number | null> {
  const target = ENTITY_TABLES[entity];
  if (!target) throw new Error(`No lockable table registered for entity "${entity}".`);

  // Both the table and the key column come from the map above, never from
  // user input, so interpolating them is safe.
  const rows = await (tx as unknown as PrismaClient).$queryRawUnsafe<{ version: number }[]>(
    `SELECT "version" FROM "${target.table}" WHERE "${target.idColumn}" = $1::uuid FOR UPDATE`,
    id,
  );

  const row = rows[0];
  return row ? Number(row.version) : null;
}

/**
 * Which fields changed between the version the client saw and now.
 *
 * Read from the append-only `activity` log rather than by diffing rows,
 * because only the log knows *which* fields each change touched, and that is
 * what decides merge versus conflict.
 */
export async function fieldsChangedSince(
  tx: PrismaLike,
  entity: string,
  entityId: string,
  baseVersion: number,
): Promise<{ fields: Set<string>; last: { userId: string; at: Date } | null }> {
  const activities = await tx.activity.findMany({
    where: { entity, entityId, versionAfter: { gt: baseVersion } },
    orderBy: { versionAfter: "asc" },
    select: { fields: true, userId: true, at: true },
  });

  const fields = new Set<string>();
  for (const activity of activities) {
    for (const field of activity.fields) fields.add(field);
  }

  const last = activities.at(-1);
  return {
    fields,
    last: last ? { userId: last.userId, at: last.at } : null,
  };
}

export interface ApplyVersionedChangeOptions<TRow> {
  readonly tx: PrismaLike;
  readonly entity: string;
  readonly id: string;
  readonly baseVersion: number;
  readonly userId: string;
  readonly householdId: string;
  readonly action: ActivityAction;
  /** The fields the user actually changed, already validated. */
  readonly changes: Record<string, unknown>;
  /** Read the row as it is now, for before/after logging and the response. */
  readonly readRow: () => Promise<TRow | null>;
  /** Apply `changes` plus the version bump, and return the new row. */
  readonly writeRow: (nextVersion: number) => Promise<TRow>;
  /** Reduce a row to the values worth logging. */
  readonly snapshot: (row: TRow) => Record<string, unknown>;
}

export interface ApplyVersionedChangeResult<TRow> {
  readonly row: TRow;
  /** True when the server combined this change with someone else's. */
  readonly merged: boolean;
}

/**
 * Apply a field-level change under optimistic concurrency, writing the audit
 * trail in the same transaction.
 *
 * Must be called inside a transaction: the row lock is only meaningful there.
 */
export async function applyVersionedChange<TRow extends { version: number }>(
  options: ApplyVersionedChangeOptions<TRow>,
): Promise<ApplyVersionedChangeResult<TRow>> {
  const { tx, entity, id, baseVersion, userId, householdId, action, changes } = options;

  const currentVersion = await lockRowVersion(tx, entity, id);
  if (currentVersion === null) {
    throw new HttpError(404, "not_found", "That item no longer exists.");
  }

  const before = await options.readRow();
  if (!before) {
    throw new HttpError(404, "not_found", "That item no longer exists.");
  }

  let merged = false;

  if (currentVersion !== baseVersion) {
    if (currentVersion < baseVersion) {
      // The client claims to have seen a version that does not exist yet.
      throw new HttpError(
        409,
        "version_ahead",
        `This change says it was based on version ${baseVersion}, but the item is only at version ${currentVersion}. Reload and try again.`,
      );
    }

    const { fields: changedFields, last } = await fieldsChangedSince(tx, entity, id, baseVersion);
    const requested = Object.keys(changes);
    const overlap = requested.filter((field) => changedFields.has(field));

    if (overlap.length > 0) {
      const changer = last
        ? await tx.user.findUnique({
            where: { id: last.userId },
            select: { id: true, name: true, initial: true },
          })
        : null;

      throw new VersionConflictError(options.snapshot(before), {
        changedFields: overlap,
        changedBy: changer ?? { id: last?.userId ?? "unknown", name: "Someone", initial: "?" },
        changedAt: last?.at ?? new Date(),
      });
    }

    // Different fields: both changes stand, and this one applies on top.
    merged = true;
  }

  const nextVersion = currentVersion + 1;
  const after = await options.writeRow(nextVersion);

  const beforeSnapshot = options.snapshot(before);
  const afterSnapshot = options.snapshot(after);

  await tx.activity.create({
    data: {
      householdId,
      userId,
      action,
      entity,
      entityId: id,
      versionAfter: nextVersion,
      fields: Object.keys(changes),
      // Only the fields this change touched, so the log stays readable and
      // "Carol verified the power bill: $131.50 (was $125.00)" is easy to
      // assemble from it.
      beforeJson: asJson(pick(beforeSnapshot, Object.keys(changes))),
      afterJson: asJson(pick(afterSnapshot, Object.keys(changes))),
    },
  });

  return { row: after, merged };
}

/**
 * Hand a plain snapshot object to Prisma's Json column.
 *
 * The snapshot builders only ever produce strings, numbers, booleans and null
 * (cents are already stringified), which is exactly Prisma's InputJsonValue.
 * TypeScript cannot see that through `Record<string, unknown>`, so this states
 * it in one place rather than casting at three call sites.
 */
function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

/** Record the creation of a row, so history starts at the beginning. */
export async function logCreation(
  tx: PrismaLike,
  options: {
    readonly entity: string;
    readonly entityId: string;
    readonly userId: string;
    readonly householdId: string;
    readonly snapshot: Record<string, unknown>;
  },
): Promise<void> {
  await tx.activity.create({
    data: {
      householdId: options.householdId,
      userId: options.userId,
      action: "create",
      entity: options.entity,
      entityId: options.entityId,
      versionAfter: 1,
      fields: Object.keys(options.snapshot),
      beforeJson: undefined,
      afterJson: asJson(options.snapshot),
    },
  });
}
