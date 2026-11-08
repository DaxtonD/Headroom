/**
 * Materialising templates into occurrences (HANDOFF section 6.5).
 *
 * Two rules shape this:
 *
 *  1. **Generating never overwrites an edit.** If an occurrence for a
 *     template's period already exists, it is left exactly as it is. Carol
 *     typing the real power bill, or moving it to a later payday, must survive
 *     the next generation run. That is why the write is an upsert whose update
 *     branch is empty.
 *  2. **Generating twice is safe, even at the same instant.** The whole run
 *     holds a per-household advisory lock and sits in one transaction, and the
 *     unique `(templateId, periodKey)` constraint is the backstop
 *     (section 16.1 rule 8).
 *
 * Paycheques are created before flexible items, because a flexible item hangs
 * off a paycheque and needs its row to exist first.
 */
import {
  computeHorizonEnd,
  generateOccurrences,
  generationWindow,
  type GeneratedOccurrence,
  type PaySchedule,
  type ScheduleSpec,
  type TemplateSpec,
} from "@headroom/core";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { fromPlainDate, todayInZone, toPlainDate } from "./timelineService.js";

/**
 * `scheduleJson` is free-form in the database, so it is validated here before
 * the engine ever sees it. A malformed schedule should be a clear error, not a
 * silently wrong date.
 */
const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("monthly"), day: z.number().int().min(1).max(31) }),
  z.object({ type: z.literal("monthly_last") }),
  z.object({
    type: z.literal("relative_to_pay"),
    payScheduleId: z.string().min(1),
    offsetDays: z.number().int().min(-31).max(31),
  }),
  z
    .object({
      type: z.literal("biweekly"),
      /** Follows someone's paydays... */
      payScheduleId: z.string().min(1).optional(),
      /** ...or has fourteen-day dates of its own. Exactly one of the two. */
      anchorDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "An anchor date must look like 2026-11-06.")
        .optional(),
    })
    .refine(
      (schedule) =>
        (schedule.payScheduleId === undefined) !== (schedule.anchorDate === undefined),
      {
        message:
          "A biweekly item either follows a payday or has its own anchor date - one of the two, not both.",
      },
    ),
  z.object({
    type: z.literal("flexible"),
    frequency: z.enum(["monthly", "per_pay_period"]),
  }),
]);

export interface GenerationResult {
  readonly from: string;
  readonly to: string;
  readonly considered: number;
  readonly created: number;
  /** Already there, so left untouched along with any edits made to them. */
  readonly existing: number;
  readonly skipped: readonly { readonly templateId: string; readonly reason: string }[];
}

/**
 * Bring the household's occurrences up to date with its templates.
 *
 * Idempotent by construction: running it again creates nothing new.
 */
export async function generateForHousehold(
  tx: Prisma.TransactionClient,
  householdId: string,
  now: Date = new Date(),
): Promise<GenerationResult> {
  // One generation run per household at a time. Two runs racing would both
  // succeed thanks to the unique constraint, but one would waste work and log
  // confusing errors.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`headroom:generate:${householdId}`}))`;

  const household = await tx.household.findUniqueOrThrow({
    where: { id: householdId },
    select: { timezone: true, horizonPaychequeCount: true, weekendWithdrawalRule: true },
  });

  const today = todayInZone(household.timezone, now);

  const schedules = await tx.paySchedule.findMany({
    where: { deletedAt: null, user: { householdId, deletedAt: null } },
    select: { id: true, userId: true, anchorDate: true, defaultCents: true },
    orderBy: { anchorDate: "asc" },
  });

  const paySchedules: PaySchedule[] = schedules.map((schedule) => ({
    id: schedule.id,
    ownerId: schedule.userId,
    anchorDate: toPlainDate(schedule.anchorDate),
    defaultCents: schedule.defaultCents,
  }));

  const horizonEnd =
    paySchedules.length > 0
      ? computeHorizonEnd({ today, paySchedules, paychequeCount: household.horizonPaychequeCount })
      : today;

  const window = generationWindow(today, horizonEnd);

  const templateRows = await tx.template.findMany({
    where: { householdId, deletedAt: null, active: true },
    select: {
      id: true,
      name: true,
      kind: true,
      defaultCents: true,
      withdrawal: true,
      scheduleType: true,
      scheduleJson: true,
      ownerUserId: true,
    },
    orderBy: { name: "asc" },
  });

  const templates: TemplateSpec[] = [];
  const skipped: { templateId: string; reason: string }[] = [];

  for (const row of templateRows) {
    const parsed = scheduleSchema.safeParse(row.scheduleJson);
    if (!parsed.success) {
      // A bad schedule stops that one template, not the whole run.
      skipped.push({
        templateId: row.id,
        reason: `schedule is not valid: ${parsed.error.issues[0]?.message ?? "unrecognised shape"}`,
      });
      continue;
    }

    templates.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      defaultCents: row.defaultCents,
      schedule: parsed.data as ScheduleSpec,
      ownerId: row.ownerUserId,
    });
  }

  if (templates.length === 0) {
    return { from: window.from, to: window.to, considered: 0, created: 0, existing: 0, skipped };
  }

  const generated = generateOccurrences({
    templates,
    paySchedules,
    from: window.from,
    to: window.to,
    weekendRule: household.weekendWithdrawalRule,
  });

  // Dated items first: a flexible item needs its anchor paycheque to exist.
  const dated = generated.filter((occurrence) => occurrence.placement === "auto");
  const flexible = generated.filter((occurrence) => occurrence.placement === "flexible");

  let created = 0;
  let existing = 0;

  for (const occurrence of dated) {
    const result = await upsert(tx, householdId, occurrence, null);
    if (result === "created") created += 1;
    else existing += 1;
  }

  // Paycheques now exist, so anchors can be resolved by date.
  const paychequesByDate = new Map<string, string>();
  const paychequeRows = await tx.occurrence.findMany({
    where: { householdId, deletedAt: null, kind: "paycheque", date: { not: null } },
    select: { id: true, date: true },
    orderBy: { date: "asc" },
  });
  for (const row of paychequeRows) {
    if (!row.date) continue;
    const key = toPlainDate(row.date);
    // The first cheque on a day wins, which is what "the first paycheque of
    // that month" means when two people are paid together.
    if (!paychequesByDate.has(key)) paychequesByDate.set(key, row.id);
  }

  for (const occurrence of flexible) {
    const anchorDate = occurrence.anchorPaydayDate;
    const anchorId = anchorDate ? paychequesByDate.get(anchorDate) ?? null : null;

    if (anchorDate && anchorId === null) {
      // No cheque on that day, so there is nothing to hang it from yet. It
      // will be picked up by the next run, once the cheque exists.
      skipped.push({
        templateId: occurrence.templateId,
        reason: `no paycheque on ${anchorDate} to attach ${occurrence.name} to`,
      });
      continue;
    }

    const result = await upsert(tx, householdId, occurrence, anchorId);
    if (result === "created") created += 1;
    else existing += 1;
  }

  return {
    from: window.from,
    to: window.to,
    considered: generated.length,
    created,
    existing,
    skipped,
  };
}

/**
 * Create the occurrence if its (template, period) is not already there.
 *
 * The update branch is deliberately empty: an existing occurrence may have
 * been edited, verified, moved or cleared, and none of that may be undone by
 * a regeneration.
 */
async function upsert(
  tx: Prisma.TransactionClient,
  householdId: string,
  occurrence: GeneratedOccurrence,
  anchorOccurrenceId: string | null,
): Promise<"created" | "existing"> {
  const existing = await tx.occurrence.findFirst({
    where: { templateId: occurrence.templateId, periodKey: occurrence.periodKey },
    select: { id: true },
  });

  if (existing) return "existing";

  try {
    await tx.occurrence.create({
      data: {
        householdId,
        templateId: occurrence.templateId,
        periodKey: occurrence.periodKey,
        name: occurrence.name,
        cents: occurrence.cents,
        kind: occurrence.kind,
        withdrawal: occurrence.placement,
        date: occurrence.date ? fromPlainDate(occurrence.date) : null,
        anchorOccurrenceId,
        sortIndex: occurrence.sortIndex,
        ownerUserId: occurrence.ownerId ?? null,
      },
    });
    return "created";
  } catch (error) {
    // Another run won the race; the unique constraint did its job.
    if (isUniqueViolation(error)) return "existing";
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export { scheduleSchema };
