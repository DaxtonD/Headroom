/**
 * Materialising templates into occurrences (HANDOFF section 6.5).
 *
 * Three rules shape this:
 *
 *  1. **Generating never overwrites what a person did.** An amount typed in, a
 *     verification, a move, a renaming: none of it is ever undone by a later
 *     run. `customisedAt`, `verifiedAt` and `clearedAt` are what "a person did
 *     this" means, and a row carrying any of the three is left alone for good.
 *  2. **Everything else follows its template.** A row nobody has touched is
 *     pure derivation - the template's name, amount, owner and dates - so when
 *     the template changes, it changes with it, and when the template no
 *     longer calls for it, it goes. Without this, correcting a bill under
 *     Manage reached nothing: every row for the whole visible horizon had
 *     already been generated, so the ledger went on showing the old figure and
 *     the old date and the edit looked like it had been thrown away.
 *  3. **Generating twice is safe, even at the same instant.** The whole run
 *     holds a per-household advisory lock and sits in one transaction, and the
 *     unique `(templateId, periodKey)` constraint is the backstop
 *     (section 16.1 rule 8). A second run finds everything already right and
 *     writes nothing at all.
 *
 * The past is read and never written to: only rows that still lie ahead are
 * reconciled. Last month's power bill says what it said.
 *
 * Dated items are settled before flexible ones, because a flexible item hangs
 * off a paycheque and needs its row to exist, on its final date, first.
 */
import {
  addDays,
  compareDates,
  computeHorizonEnd,
  daysBetween,
  generateOccurrences,
  generationWindow,
  nextPaydays,
  type GeneratedOccurrence,
  type PaySchedule,
  type PlainDate,
  type ScheduleSpec,
  type TemplateSpec,
} from "@headroom/core";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
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
  z
    .object({
      type: z.literal("flexible"),
      frequency: z.enum(["monthly", "per_pay_period"]),
      /**
       * The day of the month the household plans to pay it. Optional: without
       * it the item is undated and hangs off a paycheque.
       */
      day: z.number().int().min(1).max(31).optional(),
    })
    .refine((schedule) => schedule.day === undefined || schedule.frequency === "monthly", {
      message: "Only a monthly item can have a day of the month; every payday has no such day.",
    }),
]);

export interface GenerationResult {
  readonly from: string;
  readonly to: string;
  readonly considered: number;
  readonly created: number;
  /** Already there and already right, so not written to at all. */
  readonly existing: number;
  /**
   * Already there, and brought into line with a template that has since been
   * edited. Only rows nobody had made their own.
   */
  readonly updated: number;
  /**
   * Taken off the ledger because the template no longer calls for them - it
   * was archived, or its dates moved. Only rows nobody had made their own,
   * and only ones still in the future.
   */
  readonly removed: number;
  /**
   * Paycheque templates created for paydays that had none. Normally zero;
   * non-zero on the run that heals a household set up before paydays brought
   * their cheque with them.
   */
  readonly paychequeTemplatesCreated: number;
  readonly skipped: readonly { readonly templateId: string; readonly reason: string }[];
}

/** An occurrence as reconciliation reads it. */
interface ExistingOccurrence {
  readonly id: string;
  readonly templateId: string | null;
  readonly periodKey: string | null;
  readonly name: string;
  readonly cents: bigint;
  readonly withdrawal: "auto" | "flexible";
  readonly date: Date | null;
  readonly anchorOccurrenceId: string | null;
  readonly sortIndex: number;
  readonly ownerUserId: string | null;
  readonly version: number;
  readonly customisedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly paidAt: Date | null;
  readonly clearedAt: Date | null;
}

/**
 * Bring the household's occurrences up to date with its templates.
 *
 * Idempotent by construction: a second run finds everything already right and
 * writes nothing.
 */
/**
 * Bring the occurrences up to date after a change, without being able to undo
 * that change.
 *
 * Deliberately its own transaction, run after the caller's has committed. Two
 * reasons:
 *
 *  - A failure here must not roll back the edit the person actually made. One
 *    template with an unreadable schedule would otherwise block every later
 *    edit in the household.
 *  - An error inside a Postgres transaction aborts it, so a `try/catch` around
 *    generation *inside* the caller's transaction could not recover anyway.
 *
 * Failures are logged and swallowed. The ledger is then merely stale, which
 * the next write or the explicit endpoint puts right - rather than the app
 * refusing to save anything.
 */
export async function regenerateQuietly(
  prisma: PrismaClient,
  householdId: string,
  log: { warn: (object: unknown, message?: string) => void },
): Promise<GenerationResult | null> {
  try {
    return await prisma.$transaction((tx) => generateForHousehold(tx, householdId));
  } catch (error) {
    log.warn(
      { err: error, householdId },
      "could not bring upcoming items up to date after a change; the ledger may be stale",
    );
    return null;
  }
}

/**
 * A payday is not just a date. It is money arriving.
 *
 * Headroom stores the two separately: a `pay_schedule` says when someone is
 * paid, and a `paycheque` template is what actually puts a row on the ledger.
 * Everything downstream reads the second one - the running balance, the
 * lowest point, safe-to-spend, coverage, and the anchor a flexible bill hangs
 * from.
 *
 * So a household that entered its paydays and its bills, and nothing else,
 * got a ledger of pure outgoings: a balance that only ever fell, every
 * automatic withdrawal reported as uncovered, and a safe-to-spend figure
 * thousands of dollars negative. Every number on the screen was a correct
 * reading of the data, and all of them were wrong about the household. Worse,
 * the pay-period totals DID count the pay (they project unplaced cheques from
 * the schedule), so the same screen showed "$4,647.43 in" above a running
 * balance that never rose.
 *
 * The screen already promised the right behaviour - "Paycheques come from the
 * paydays below" - so this makes the promise true rather than changing it.
 *
 * Binding the template to the schedule by id, instead of copying its anchor
 * date, keeps the dates in one place: correct a payday and the cheques follow.
 *
 * Idempotent, and deliberately unfiltered by `active` and `deletedAt`:
 * archiving or removing a paycheque is a decision, and a household that has
 * made it must not have the template reappear on the next write.
 */
export async function ensurePaychequeTemplates(
  tx: Prisma.TransactionClient,
  householdId: string,
): Promise<string[]> {
  const schedules = await tx.paySchedule.findMany({
    where: { deletedAt: null, user: { householdId, deletedAt: null } },
    select: {
      id: true,
      userId: true,
      anchorDate: true,
      defaultCents: true,
      user: { select: { name: true } },
    },
    orderBy: { anchorDate: "asc" },
  });
  if (schedules.length === 0) return [];

  const paycheques = await tx.template.findMany({
    where: { householdId, kind: "paycheque", scheduleType: "biweekly" },
    select: { ownerUserId: true, scheduleJson: true },
  });

  /**
   * Which paydays already have a cheque, and which are too unclear to touch.
   *
   * Creating a second cheque for a payday that already has one would double
   * the household's income - a far worse failure than leaving a payday
   * without one, which at least shows up as a balance that never rises. So
   * every way a template might already be someone's pay counts as a claim,
   * and anything ambiguous blocks creation instead of guessing.
   */
  const claimed = new Set<string>();
  const blocked = new Set<string>();
  const byOwner = new Map(schedules.map((schedule) => [schedule.userId, schedule.id]));
  const unattributed: Date[] = [];

  for (const template of paycheques) {
    const parsed = scheduleSchema.safeParse(template.scheduleJson);
    if (!parsed.success || parsed.data.type !== "biweekly") continue;

    // 1. It names the payday it follows. Everything this function creates.
    if (parsed.data.payScheduleId !== undefined) {
      claimed.add(parsed.data.payScheduleId);
      continue;
    }

    // 2. It is somebody's, and a person has at most one payday.
    const owned = template.ownerUserId === null ? undefined : byOwner.get(template.ownerUserId);
    if (owned !== undefined) {
      claimed.add(owned);
      continue;
    }

    // 3. Nobody's, with fortnightly dates of its own. The old setup advice
    //    produced exactly this: "add your pay under Money coming in", with no
    //    owner and an anchor copied from the payday.
    if (parsed.data.anchorDate !== undefined) {
      unattributed.push(new Date(`${parsed.data.anchorDate}T00:00:00.000Z`));
    }
  }

  const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;
  for (const anchor of unattributed) {
    // Two fortnightly series are the same series exactly when their anchors
    // are a whole number of fortnights apart.
    const aligned = schedules.filter(
      (schedule) => (anchor.getTime() - schedule.anchorDate.getTime()) % FORTNIGHT_MS === 0,
    );

    if (aligned.length === 1) {
      // Unmistakably that payday's cheque, entered by hand.
      claimed.add((aligned[0] as { id: string }).id);
    } else if (aligned.length > 1) {
      // Two people paid on the same day, and no way to tell whose this is.
      for (const schedule of aligned) blocked.add(schedule.id);
    }
    // Aligned with none: some other fortnightly income. Blocks nothing.
  }

  const created: string[] = [];
  for (const schedule of schedules) {
    if (claimed.has(schedule.id) || blocked.has(schedule.id)) continue;
    const template = await createPaycheque(tx, householdId, schedule);
    created.push(template.id);
  }

  return created;
}

/**
 * One paycheque template, bound to the payday it follows.
 *
 * Shared by automatic generation and by the explicit "put the pay back"
 * request, so the two cannot drift into producing different rows.
 */
async function createPaycheque(
  tx: Prisma.TransactionClient,
  householdId: string,
  schedule: {
    id: string;
    userId: string;
    defaultCents: bigint;
    user: { name: string };
  },
): Promise<{ id: string; version: number; name: string }> {
  return await tx.template.create({
    data: {
      householdId,
      kind: "paycheque",
      name: paychequeNameFor(schedule.user.name),
      defaultCents: schedule.defaultCents,
      ownerUserId: schedule.userId,
      // A paycheque lands on a date the employer chose, like any other dated
      // item. It is not something that can be moved to a later cheque.
      withdrawal: "auto",
      scheduleType: "biweekly",
      scheduleJson: { type: "biweekly", payScheduleId: schedule.id },
      section: "income",
    },
    select: { id: true, version: true, name: true },
  });
}

/**
 * Keep the pay amount in one place.
 *
 * The amount lives on the pay schedule, because that is where it is entered
 * and where anyone would go to change it after a raise. The bound template
 * carries a copy, since that is what generation reads - so correcting the
 * schedule has to carry through, or future cheques would quietly keep the old
 * figure while the pay-period totals showed the new one.
 *
 * Only the template DEFAULT moves. Cheques already on the ledger keep what
 * they say: one of them may have been edited for overtime or banked hours,
 * and none of them may be rewritten by a change made later.
 *
 * Returns the template it touched, so the caller can announce the change.
 */
export async function syncPaychequeDefault(
  tx: Prisma.TransactionClient,
  householdId: string,
  payScheduleId: string,
  defaultCents: bigint,
  userId: string,
): Promise<{ id: string; version: number } | null> {
  const candidates = await tx.template.findMany({
    where: {
      householdId,
      kind: "paycheque",
      scheduleType: "biweekly",
      deletedAt: null,
    },
    select: { id: true, version: true, defaultCents: true, scheduleJson: true },
  });

  for (const candidate of candidates) {
    const parsed = scheduleSchema.safeParse(candidate.scheduleJson);
    if (!parsed.success || parsed.data.type !== "biweekly") continue;
    if (parsed.data.payScheduleId !== payScheduleId) continue;
    if (candidate.defaultCents === defaultCents) return null;

    return await tx.template.update({
      where: { id: candidate.id },
      data: {
        defaultCents,
        version: candidate.version + 1,
        updatedById: userId,
        updatedAt: new Date(),
      },
      select: { id: true, version: true },
    });
  }

  return null;
}

/** "Alex's pay", and "Chris' pay" for a name already ending in s. */
function paychequeNameFor(owner: string): string {
  const name = owner.trim();
  if (name.length === 0) return "Pay";
  return `${name}${name.endsWith("s") || name.endsWith("S") ? "'" : "'s"} pay`;
}

/**
 * Bring every household up to date.
 *
 * Generation otherwise only runs after a write, and two things need it when
 * nobody is writing:
 *
 *  - **Time passes.** The horizon is "through the day before the Nth upcoming
 *    paycheque", so it rolls forward every day. A household that changed
 *    nothing for a fortnight would watch its ledger run out rather than
 *    extend, and the figures would quietly describe a shorter and shorter
 *    stretch of the future.
 *  - **An upgrade adds something that should exist.** Paydays now bring their
 *    paycheque; a household set up before that needs the templates created
 *    without having to go and edit something first, which it would have no
 *    reason to think would help.
 *
 * Each household is its own transaction so one bad schedule cannot stop the
 * rest, and failures are logged rather than thrown: a sweep is maintenance,
 * and it must never take the server down.
 */
export async function generateForAllHouseholds(
  prisma: PrismaClient,
  log: {
    info: (object: unknown, message?: string) => void;
    warn: (object: unknown, message?: string) => void;
  },
  now: Date = new Date(),
): Promise<{
  households: number;
  created: number;
  updated: number;
  removed: number;
  paychequeTemplatesCreated: number;
}> {
  const households = await prisma.household.findMany({ select: { id: true } });

  let created = 0;
  let updated = 0;
  let removed = 0;
  let paychequeTemplatesCreated = 0;

  for (const household of households) {
    try {
      const result = await prisma.$transaction((tx) =>
        generateForHousehold(tx, household.id, now),
      );
      created += result.created;
      updated += result.updated;
      removed += result.removed;
      paychequeTemplatesCreated += result.paychequeTemplatesCreated;
    } catch (error) {
      log.warn(
        { err: error, householdId: household.id },
        "could not bring a household up to date during the periodic sweep",
      );
    }
  }

  if (created > 0 || updated > 0 || removed > 0 || paychequeTemplatesCreated > 0) {
    log.info(
      { households: households.length, created, updated, removed, paychequeTemplatesCreated },
      "periodic generation sweep brought upcoming items up to date",
    );
  }

  return { households: households.length, created, updated, removed, paychequeTemplatesCreated };
}

export async function generateForHousehold(
  tx: Prisma.TransactionClient,
  householdId: string,
  now: Date = new Date(),
): Promise<GenerationResult> {
  // One generation run per household at a time. Two runs racing would both
  // succeed thanks to the unique constraint, but one would waste work and log
  // confusing errors.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`headroom:generate:${householdId}`}))`;

  // Before anything else, because the cheques these create are what the rest
  // of the run anchors flexible items to.
  const paychequeTemplatesCreated = (await ensurePaychequeTemplates(tx, householdId)).length;

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

  /**
   * Archived templates are loaded too, and want nothing.
   *
   * Reconciliation needs to know the difference between "this row's template
   * no longer calls for it" and "this row's template was not looked at", and
   * only a template that was loaded can say the first. Without the archived
   * ones, turning a bill off would leave its untouched future rows on the
   * ledger for the whole horizon.
   */
  const templateRows = await tx.template.findMany({
    where: { householdId, deletedAt: null },
    select: {
      id: true,
      name: true,
      kind: true,
      defaultCents: true,
      withdrawal: true,
      scheduleType: true,
      scheduleJson: true,
      ownerUserId: true,
      active: true,
    },
    orderBy: { name: "asc" },
  });

  const templates: TemplateSpec[] = [];
  const skipped: { templateId: string; reason: string }[] = [];

  /**
   * The templates whose occurrences this run is entitled to change.
   *
   * An archived one belongs here: it wants nothing, and saying so is the
   * point. An active one whose schedule cannot be read does not: we have no
   * idea what it wants, and removing its rows on that basis would delete a
   * real bill because of a typo in a JSON column.
   */
  const reconcilable = new Set<string>();

  for (const row of templateRows) {
    const parsed = scheduleSchema.safeParse(row.scheduleJson);

    if (!row.active) {
      reconcilable.add(row.id);
      continue;
    }

    if (!parsed.success) {
      // A bad schedule stops that one template, not the whole run.
      skipped.push({
        templateId: row.id,
        reason: `schedule is not valid: ${parsed.error.issues[0]?.message ?? "unrecognised shape"}`,
      });
      continue;
    }

    reconcilable.add(row.id);
    templates.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      defaultCents: row.defaultCents,
      schedule: parsed.data as ScheduleSpec,
      ownerId: row.ownerUserId,
    });
  }

  const generated =
    templates.length === 0
      ? []
      : generateOccurrences({
          templates,
          paySchedules,
          from: window.from,
          to: window.to,
          weekendRule: household.weekendWithdrawalRule,
        });

  /** Everything the templates call for, by the key the database is unique on. */
  const wanted = new Map<string, GeneratedOccurrence>();
  for (const occurrence of generated) {
    wanted.set(occurrenceKey(occurrence.templateId, occurrence.periodKey), occurrence);
  }

  // Every occurrence the household has, because an anchor may be a one-off
  // paycheque and the dates of rows this run is not touching are still needed
  // to work out where a flexible row effectively sits.
  const presentRows = await tx.occurrence.findMany({
    where: { householdId, deletedAt: null },
    select: {
      id: true,
      templateId: true,
      periodKey: true,
      name: true,
      cents: true,
      kind: true,
      withdrawal: true,
      date: true,
      anchorOccurrenceId: true,
      sortIndex: true,
      ownerUserId: true,
      version: true,
      customisedAt: true,
      verifiedAt: true,
      paidAt: true,
      clearedAt: true,
    },
  });

  const dateById = new Map<string, PlainDate | null>();
  for (const row of presentRows) dateById.set(row.id, row.date ? toPlainDate(row.date) : null);

  const byKey = new Map<string, ExistingOccurrence>();
  for (const row of presentRows) {
    if (row.templateId === null || row.periodKey === null) continue;
    byKey.set(occurrenceKey(row.templateId, row.periodKey), row);
  }

  /**
   * Where a row effectively sits, which decides whether it is still the
   * future.
   *
   * A flexible row with neither a date nor an anchor means "now", so it counts
   * as current: `null` here is deliberately treated as in scope by the caller.
   */
  const effectiveDateOf = (row: ExistingOccurrence): PlainDate | null => {
    if (row.date) return toPlainDate(row.date);
    if (row.anchorOccurrenceId === null) return null;
    return dateById.get(row.anchorOccurrenceId) ?? null;
  };

  /** The past is history. Generation reads it and never writes to it. */
  const stillAhead = (row: ExistingOccurrence): boolean => {
    const date = effectiveDateOf(row);
    return date === null || compareDates(date, window.from) >= 0;
  };

  let created = 0;
  let existing = 0;
  let updated = 0;
  let removed = 0;

  const reconcile = async (
    occurrence: GeneratedOccurrence,
    anchorOccurrenceId: string | null,
  ): Promise<void> => {
    const row = byKey.get(occurrenceKey(occurrence.templateId, occurrence.periodKey));

    if (!row) {
      const result = await create(tx, householdId, occurrence, anchorOccurrenceId);
      if (result === "created") created += 1;
      else existing += 1;
      return;
    }

    if (isSomebodysOwn(row)) {
      // The whole point of the rule: an amount typed in, a verification or a
      // move is never undone by a later edit to the template.
      existing += 1;
      return;
    }

    const date = occurrence.date ? fromPlainDate(occurrence.date) : null;
    const ownerUserId = occurrence.ownerId ?? null;

    const same =
      row.name === occurrence.name &&
      row.cents === occurrence.cents &&
      row.withdrawal === occurrence.placement &&
      samePlainDate(row.date, occurrence.date) &&
      row.anchorOccurrenceId === anchorOccurrenceId &&
      row.sortIndex === occurrence.sortIndex &&
      row.ownerUserId === ownerUserId;

    if (same) {
      existing += 1;
      return;
    }

    await tx.occurrence.update({
      where: { id: row.id },
      data: {
        name: occurrence.name,
        cents: occurrence.cents,
        withdrawal: occurrence.placement,
        date,
        anchorOccurrenceId,
        sortIndex: occurrence.sortIndex,
        ownerUserId,
        version: row.version + 1,
        updatedAt: new Date(),
      },
    });
    updated += 1;
  };

  /*
   * Dated items first, flexible ones after.
   *
   * A flexible item that hangs off a paycheque needs that paycheque's row to
   * exist and to be on its final date before it can be anchored, and the
   * removals in between mean a cheque the pay schedule no longer calls for is
   * gone by the time anything is hung from it.
   */
  const placedByDate = generated.filter((occurrence) => occurrence.date !== undefined);
  const placedByAnchor = generated.filter((occurrence) => occurrence.date === undefined);

  for (const occurrence of placedByDate) await reconcile(occurrence, null);

  // ---- What the templates no longer call for -------------------------------
  const doomed = presentRows.filter(
    (row) =>
      row.templateId !== null &&
      row.periodKey !== null &&
      reconcilable.has(row.templateId) &&
      !wanted.has(occurrenceKey(row.templateId, row.periodKey)) &&
      !isSomebodysOwn(row) &&
      stillAhead(row),
  );

  if (doomed.length > 0) {
    const doomedIds = new Set(doomed.map((row) => row.id));

    /*
     * A paycheque row about to go may be holding somebody's flexible bill.
     *
     * The foreign key nulls the anchor on delete, which would silently move
     * that bill to "now" - in front of every cheque, dragging the lowest point
     * of the whole ledger down with it. So the ones that are staying are moved
     * to the nearest cheque that is still there, on or before the date they
     * were hanging from.
     */
    const orphans = presentRows.filter(
      (row) =>
        row.anchorOccurrenceId !== null &&
        doomedIds.has(row.anchorOccurrenceId) &&
        !doomedIds.has(row.id),
    );

    await tx.occurrence.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } });
    removed += doomed.length;
    for (const row of doomed) byKey.delete(occurrenceKey(row.templateId as string, row.periodKey as string));

    if (orphans.length > 0) {
      const remaining = await tx.occurrence.findMany({
        where: { householdId, deletedAt: null, kind: "paycheque", date: { not: null } },
        select: { id: true, date: true },
        orderBy: { date: "asc" },
      });

      for (const orphan of orphans) {
        const lostOn = dateById.get(orphan.anchorOccurrenceId as string) ?? null;
        if (lostOn === null) continue;

        /*
         * The nearest cheque that is still there, in either direction.
         *
         * Not "the last one on or before": correcting a payday by a day moves
         * the whole series forward, so there is often nothing before the date
         * that was lost, and insisting on one would leave the bill at "now" -
         * in front of every cheque on the ledger. One day late beats that by
         * a long way. A tie goes to the earlier cheque, because paying a bill
         * out of money that has arrived is the safer of the two readings.
         */
        let replacement: string | null = null;
        let closest = Number.POSITIVE_INFINITY;

        for (const cheque of remaining) {
          if (!cheque.date) continue;
          const away = Math.abs(cheque.date.getTime() - fromPlainDate(lostOn).getTime());
          if (away < closest) {
            closest = away;
            replacement = cheque.id;
          }
        }

        // Nothing left to hang it from at all leaves the anchor null, which is
        // "now" - the only honest answer when the household has no cheques.
        if (replacement !== null) {
          await tx.occurrence.update({
            where: { id: orphan.id },
            data: { anchorOccurrenceId: replacement },
          });
        }
      }
    }
  }

  // ---- Flexible items, now that the cheques are settled -------------------
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

  for (const occurrence of placedByAnchor) {
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

    await reconcile(occurrence, anchorId);
  }

  return {
    from: window.from,
    to: window.to,
    considered: generated.length,
    created,
    existing,
    updated,
    removed,
    paychequeTemplatesCreated,
    skipped,
  };
}

/** The key the database is unique on, as a string. */
function occurrenceKey(templateId: string, periodKey: string): string {
  return `${templateId}|${periodKey}`;
}

/**
 * Has a person made this row their own?
 *
 * If so, generation must never change it again. Three things count, and all
 * four are statements by a person rather than by a template: the row's own
 * details were edited, somebody confirmed the amount, somebody ticked it as
 * dealt with, or it is already inside a typed-in balance.
 */
function isSomebodysOwn(row: {
  customisedAt: Date | null;
  verifiedAt: Date | null;
  paidAt: Date | null;
  clearedAt: Date | null;
}): boolean {
  return (
    row.customisedAt !== null ||
    row.verifiedAt !== null ||
    row.paidAt !== null ||
    row.clearedAt !== null
  );
}

/** A stored `@db.Date` against a plain date the engine produced. */
function samePlainDate(stored: Date | null, generated: PlainDate | undefined): boolean {
  if (stored === null) return generated === undefined;
  if (generated === undefined) return false;
  return toPlainDate(stored) === generated;
}

/**
 * Create the occurrence, unless its (template, period) is already there.
 *
 * Reconciliation handles the rows that exist; this only has to survive losing
 * a race with another run.
 */
async function create(
  tx: Prisma.TransactionClient,
  householdId: string,
  occurrence: GeneratedOccurrence,
  anchorOccurrenceId: string | null,
): Promise<"created" | "existing"> {
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

/**
 * Which paydays have a live paycheque on the ledger.
 *
 * Three callers need this same answer and each used to work it out for itself:
 * the setup checklist ("a payday has no pay"), the pay-period projection
 * (which must not expect a cheque the household has turned off) and this
 * module. The parsing is the fiddly part - `scheduleJson` is a free-form
 * column - so it lives in one place.
 *
 * "Live" means active and not deleted, deliberately: an archived paycheque is
 * a decision, and everything downstream has to see that the pay is off.
 */
export async function paydaysWithLivePay(
  tx: Pick<Prisma.TransactionClient, "template">,
  householdId: string,
): Promise<Set<string>> {
  const templates = await tx.template.findMany({
    where: {
      householdId,
      kind: "paycheque",
      scheduleType: "biweekly",
      active: true,
      deletedAt: null,
    },
    select: { scheduleJson: true },
  });

  const paydays = new Set<string>();
  for (const template of templates) {
    const parsed = scheduleSchema.safeParse(template.scheduleJson);
    if (!parsed.success || parsed.data.type !== "biweekly") continue;
    if (parsed.data.payScheduleId !== undefined) paydays.add(parsed.data.payScheduleId);
  }

  return paydays;
}

/**
 * How far either side of a payday money may land and still be that payday's
 * pay.
 *
 * Pay is not always entered as arriving exactly on the payday. One real
 * household has one person's entered as a deposit on the day and the other's
 * as an item "one day after a payday", because that is when the money shows
 * up. Three days is wide enough for any of those arrangements and far too
 * narrow for an unrelated monthly deposit to masquerade as pay: paydays are
 * fourteen days apart, so one monthly item can fall inside at most one of the
 * windows below.
 */
const PAY_LANDS_WITHIN_DAYS = 3;

/** How many paydays ahead have to have money before the pay counts as real. */
const PAYDAYS_LOOKED_AT = 3;

/**
 * Which paydays have no money arriving on the ledger at all.
 *
 * This is the wider of the two questions in this file, and the distinction
 * matters enough to spell out.
 *
 * `paydaysWithLivePay` asks the narrow one - "will a paycheque ROW be
 * projected for this payday" - and the pay-period projection needs exactly
 * that. Silencing a payday whose money arrives some other way would make the
 * projection add a phantom cheque on top of the real income and count the
 * same pay twice.
 *
 * The setup checklist needs this one. It used the narrow answer, and told a
 * household that had entered both people's pay by hand - one as a deposit,
 * one as an item a day after the payday - that their paydays were "not
 * putting any money on the ledger". Both were on the ledger. The statement was
 * true of paycheque templates and false of the thing it was describing, and
 * the button it offered restored an archived paycheque on top of income that
 * was already there, so the ledger then counted every cheque twice.
 *
 * So this asks what somebody reading the ledger would ask: is money arriving
 * around this payday? It is answered from the generated rows rather than from
 * the shape of a template, because a household may enter their pay however
 * suits them and every shape ends as a dated row.
 */
export async function paydaysWithNoIncomeArriving(
  tx: Pick<Prisma.TransactionClient, "template" | "household" | "paySchedule" | "occurrence">,
  householdId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const live = await paydaysWithLivePay(tx, householdId);

  const [household, schedules] = await Promise.all([
    tx.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { timezone: true, horizonPaychequeCount: true },
    }),
    tx.paySchedule.findMany({
      where: { deletedAt: null, user: { householdId, deletedAt: null } },
      select: { id: true, userId: true, anchorDate: true, defaultCents: true },
      orderBy: { anchorDate: "asc" },
    }),
  ]);

  const unpaid = schedules.filter((schedule) => !live.has(schedule.id));
  if (unpaid.length === 0) return new Set();

  const paySchedules: PaySchedule[] = schedules.map((schedule) => ({
    id: schedule.id,
    ownerId: schedule.userId,
    anchorDate: toPlainDate(schedule.anchorDate),
    defaultCents: schedule.defaultCents,
  }));

  /*
   * Only paydays that have been generated can be judged. Past the end of the
   * generation window there are no rows for anything, so "no money arriving"
   * would be true of every payday and of every household.
   */
  const today = todayInZone(household.timezone, now);
  const generatedThrough = generationWindow(
    today,
    computeHorizonEnd({
      today,
      paySchedules,
      paychequeCount: household.horizonPaychequeCount,
    }),
  ).to;

  const checking = new Map<string, { paydays: PlainDate[]; ownerId: string }>();
  let furthest = today;

  for (const schedule of unpaid) {
    const paydays = nextPaydays(toPlainDate(schedule.anchorDate), today, PAYDAYS_LOOKED_AT).filter(
      (payday) => compareDates(payday, generatedThrough) <= 0,
    );
    if (paydays.length === 0) continue;

    checking.set(schedule.id, { paydays, ownerId: schedule.userId });
    for (const payday of paydays) {
      if (compareDates(payday, furthest) > 0) furthest = payday;
    }
  }
  if (checking.size === 0) return new Set();

  /*
   * Everything coming in between now and the last payday being looked at.
   * Cleared rows count: a cheque that has already been received and folded
   * into the balance has left the timeline, but the money did arrive, and
   * reporting that payday as empty would be plainly wrong.
   */
  const arriving = await tx.occurrence.findMany({
    where: {
      householdId,
      deletedAt: null,
      kind: { in: ["paycheque", "deposit"] },
      cents: { gt: 0n },
      date: {
        gte: fromPlainDate(addDays(today, -PAY_LANDS_WITHIN_DAYS)),
        lte: fromPlainDate(addDays(furthest, PAY_LANDS_WITHIN_DAYS)),
      },
    },
    select: { date: true, ownerUserId: true },
  });

  const landings = arriving
    .filter((row): row is { date: Date; ownerUserId: string | null } => row.date !== null)
    .map((row) => ({ date: toPlainDate(row.date), ownerId: row.ownerUserId, claimed: false }))
    .sort((a, b) => compareDates(a.date, b.date));

  /**
   * Claim one arrival for this payday, if there is one going spare.
   *
   * Claimed, not merely matched, and that is the point. Two people paid on
   * the same day with one cheque between them are not both covered by it:
   * their pay is being counted once, which is exactly the under-counting this
   * checklist exists to catch. `computePayPeriods` places projected cheques
   * the same way, for the same reason.
   *
   * Their own cheque first, then one belonging to nobody in particular -
   * which is what the form under Money coming in produces unless a person is
   * picked, so it could be anyone's and should not be spent on the wrong
   * payday while its owner's payday goes without.
   */
  const claim = (payday: PlainDate, ownerId: string): boolean => {
    const near = (landing: (typeof landings)[number]): boolean => {
      if (landing.claimed) return false;
      const gap = daysBetween(payday, landing.date);
      return gap >= -PAY_LANDS_WITHIN_DAYS && gap <= PAY_LANDS_WITHIN_DAYS;
    };

    const theirs =
      landings.find((landing) => near(landing) && landing.ownerId === ownerId) ??
      landings.find((landing) => near(landing) && landing.ownerId === null);

    if (theirs === undefined) return false;
    theirs.claimed = true;
    return true;
  };

  const without = new Set<string>();
  for (const [scheduleId, { paydays, ownerId }] of checking) {
    // Every payday, not just the next one: a monthly deposit falls near at
    // most one of them, so asking about one payday would let a child benefit
    // answer for somebody's pay.
    let covered = true;
    for (const payday of paydays) {
      if (!claim(payday, ownerId)) covered = false;
    }
    if (!covered) without.add(scheduleId);
  }

  return without;
}

/**
 * Put a payday's pay back on the ledger.
 *
 * The checklist could say a payday had no paycheque and leave no way to act on
 * it. `ensurePaychequeTemplates` deliberately will not recreate an archived
 * cheque - turning the pay off has to stick - and the only button under "Money
 * coming in" creates a `deposit`, which looks like income in the list but
 * satisfies none of the things a paycheque does: it does not anchor flexible
 * bills, it does not claim the payday, and so the checklist went on
 * complaining whatever was entered.
 *
 * So this is the deliberate opposite of archiving, asked for explicitly:
 * restore the archived cheque for this payday if there is one, otherwise make
 * one. Returns the template, or null if the payday already has money.
 *
 * "Already has money" is the wide question, not the narrow one, and that is
 * the whole safety of this function. It used to ask only whether a paycheque
 * template was bound to the payday, so for a household who had entered their
 * pay by hand it answered "no" while the pay sat on the ledger in front of
 * them - and the button added a second one beside it. Income is the thing
 * that must not be duplicated; a paycheque template is only one way of
 * entering it.
 */
export async function restorePaycheque(
  tx: Prisma.TransactionClient,
  householdId: string,
  payScheduleId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ id: string; version: number; name: string } | null> {
  const without = await paydaysWithNoIncomeArriving(tx, householdId, now);
  if (!without.has(payScheduleId)) return null;

  const schedule = await tx.paySchedule.findFirst({
    where: { id: payScheduleId, deletedAt: null, user: { householdId, deletedAt: null } },
    select: {
      id: true,
      userId: true,
      defaultCents: true,
      user: { select: { name: true } },
    },
  });
  if (!schedule) return null;

  const candidates = await tx.template.findMany({
    where: {
      householdId,
      kind: "paycheque",
      scheduleType: "biweekly",
      deletedAt: null,
      active: false,
    },
    select: { id: true, version: true, name: true, ownerUserId: true, scheduleJson: true },
  });

  const bound = candidates.find((candidate) => {
    const parsed = scheduleSchema.safeParse(candidate.scheduleJson);
    return (
      parsed.success &&
      parsed.data.type === "biweekly" &&
      parsed.data.payScheduleId === payScheduleId
    );
  });

  /*
   * Failing that, one owned by the person whose payday it is - which is how a
   * cheque entered by hand before paydays brought their own would look.
   *
   * Only when there is exactly one. It used to take the first of however many
   * there were, which reads as helpful and is a lottery: a household testing
   * the app had five archived entries, three of them the same person's and
   * two of those sharing a name, so which one came back was whichever the
   * database happened to return first. When it is ambiguous, making a new
   * cheque is the answer somebody can predict.
   */
  const owned = candidates.filter((candidate) => candidate.ownerUserId === schedule.userId);
  const archived = bound ?? (owned.length === 1 ? owned[0] : undefined);

  if (archived) {
    return await tx.template.update({
      where: { id: archived.id },
      data: {
        active: true,
        // Rebind it, in case it was one of the hand-made ones that never named
        // the payday it follows.
        scheduleJson: { type: "biweekly", payScheduleId },
        ownerUserId: schedule.userId,
        version: archived.version + 1,
        updatedById: userId,
        updatedAt: new Date(),
      },
      select: { id: true, version: true, name: true },
    });
  }

  /*
   * Nothing to restore, so make one.
   *
   * Deliberately not via `ensurePaychequeTemplates`: that refuses to recreate
   * a cheque that has been removed, because automatic generation must never
   * undo a household's decision. This is not automatic - somebody pressed a
   * button that says to put the pay back - so the refusal does not apply, and
   * going through it would make the button do nothing at all for a payday
   * whose cheque was removed rather than archived.
   */
  return await createPaycheque(tx, householdId, schedule);
}
