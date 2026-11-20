/**
 * The Year screen's four extras, assembled from the database.
 *
 * `yearAhead.ts` in the engine does the arithmetic; this gets it the right
 * inputs. There are only two interesting decisions in here and they are both
 * about honesty.
 *
 * ## Where the ledger stops and the projection starts
 *
 * For as far as the ledger reaches - today to the horizon - the balance is
 * carried by the ledger's OWN rows, through `loadTimelineContext`. That costs
 * a second timeline computation on a screen that is opened rarely, and it
 * buys the only thing that matters: this month's figure on the Year screen is
 * the same figure the Ledger screen shows. Two screens deriving the same
 * number two ways is how they start disagreeing, and the household would be
 * right to trust neither.
 *
 * Past the horizon there are no rows, so the templates are run forward and
 * each occurrence is turned into a delta by `accountDelta` - the one function
 * in Headroom allowed to decide a sign. The two ranges do not overlap: the
 * timeline's query is bounded at the horizon, and generation starts the day
 * after it.
 *
 * Everything past the horizon assumes each bill costs what it costs today and
 * that nothing is bought in between, which is false the moment anybody buys
 * groceries. `ledgerThrough` is published so the screen can draw the line and
 * say which side is which.
 *
 * ## The bills that skip months are read from the templates, not the ledger
 *
 * A ledger row knows its amount and its date; it does not know what cadence
 * produced it. So the irregular bills are generated over the WHOLE window
 * from the templates alone, and handed to the engine separately. They do not
 * move the balance - they are a label on money the moves already carry.
 */
import {
  accountDelta,
  addDays,
  cadenceOfSchedule,
  computeYearAhead,
  daysInMonth,
  generateOccurrences,
  isIrregular,
  nextMonth,
  parseDate,
  setAsideFor,
  type Cadence,
  type Lump,
  type PaySchedule,
  type PlainDate,
  type ProjectedMove,
  type ScheduleSpec,
  type SetAside,
  type TemplateSpec,
  type YearAheadMonth,
} from "@headroom/core";
import { scheduleSchema } from "./generateService.js";
import { loadTimelineContext, toPlainDate } from "./timelineService.js";
import type { PrismaLike } from "./versioning.js";

export interface YearAheadResult {
  readonly months: readonly YearAheadMonth[];
  readonly setAside: SetAside;
  /** Chequing as it stands now: the figure the projection starts from. */
  readonly startBalanceCents: bigint;
  /**
   * The last date the ledger's own rows cover. Up to here the monthly figures
   * are the ledger's; past it they are worked out from the schedules.
   */
  readonly ledgerThrough: PlainDate;
  /** False when the household has no chequing account to project. */
  readonly hasBalance: boolean;
}

/** The last day of the month `monthCount - 1` months after the one holding `from`. */
function windowEnd(from: PlainDate, monthCount: number): PlainDate {
  const first = parseDate(from);
  let cursor = { year: first.year, month: first.month };
  for (let index = 1; index < monthCount; index += 1) {
    cursor = nextMonth(cursor.year, cursor.month);
  }

  const day = daysInMonth(cursor.year, cursor.month);
  return `${String(cursor.year).padStart(4, "0")}-${String(cursor.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** One template, as both the generator and the sign rule need it. */
interface LoadedTemplate {
  readonly spec: TemplateSpec;
  readonly cadence: Cadence;
  readonly fromAccountId: string | null;
  readonly toAccountId: string | null;
}

export async function loadYearAhead(
  prisma: PrismaLike,
  householdId: string,
  monthCount: number,
  now: Date = new Date(),
): Promise<YearAheadResult> {
  const context = await loadTimelineContext(prisma, householdId, now);
  const { today, horizonEnd, accountId } = context;
  const until = windowEnd(today, monthCount);

  const [household, templateRows, scheduleRows] = await Promise.all([
    prisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { weekendWithdrawalRule: true },
    }),
    prisma.template.findMany({
      where: { householdId, deletedAt: null, active: true },
      select: {
        id: true,
        name: true,
        kind: true,
        defaultCents: true,
        scheduleJson: true,
        ownerUserId: true,
        paidFromAccountId: true,
        transferToAccountId: true,
      },
    }),
    prisma.paySchedule.findMany({
      where: { deletedAt: null, user: { householdId, deletedAt: null } },
      select: { id: true, userId: true, anchorDate: true, defaultCents: true },
      orderBy: { anchorDate: "asc" },
    }),
  ]);

  const paySchedules: PaySchedule[] = scheduleRows.map((row) => ({
    id: row.id,
    ownerId: row.userId,
    anchorDate: toPlainDate(row.anchorDate),
    defaultCents: row.defaultCents,
  }));

  const templates: LoadedTemplate[] = [];
  for (const row of templateRows) {
    const parsed = scheduleSchema.safeParse(row.scheduleJson);
    // A schedule nobody can read stops that one template and nothing else,
    // exactly as it does in the generator. Leaving it out understates the
    // projection, which is the safe direction for a screen about money.
    if (!parsed.success) continue;

    const schedule = parsed.data as ScheduleSpec;
    templates.push({
      spec: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        defaultCents: row.defaultCents,
        schedule,
        ownerId: row.ownerUserId,
      },
      cadence: cadenceOfSchedule(schedule),
      // Null has always meant chequing. Resolved here so the sign rule is
      // never handed a row whose source it would have to guess.
      fromAccountId: row.paidFromAccountId ?? accountId,
      toAccountId: row.transferToAccountId,
    });
  }

  /* ---- Up to the horizon: the ledger's own rows ---- */

  const moves: ProjectedMove[] = [];

  for (const row of context.timeline.rows) {
    // Zero is a settled row, a row belonging to another account, or a
    // genuinely empty one. None of them move chequing.
    if (row.deltaCents === 0n) continue;
    if (row.effectiveDate === null) continue;

    // An overdue bill nobody has dealt with is money still to leave, and it
    // leaves this month rather than in the month it was due.
    const date = row.effectiveDate < today ? today : row.effectiveDate;
    moves.push({ date, name: row.event.name, deltaCents: row.deltaCents });
  }

  /* ---- Past the horizon: the schedules, run forward ---- */

  const beyond =
    templates.length === 0
      ? []
      : generateOccurrences({
          templates: templates.map((template) => template.spec),
          paySchedules,
          from: addDays(horizonEnd, 1),
          to: until,
          weekendRule: household.weekendWithdrawalRule,
        });

  const byId = new Map(templates.map((template) => [template.spec.id, template]));

  for (const occurrence of beyond) {
    const template = byId.get(occurrence.templateId);
    if (template === undefined) continue;

    // A flexible item has no date of its own; it sits on the paycheque it
    // hangs from, which is where the bank would see it.
    const date = occurrence.date ?? occurrence.anchorPaydayDate;
    if (date === undefined) continue;

    const delta = accountDelta(
      {
        cents: occurrence.cents,
        fromAccountId: template.fromAccountId,
        toAccountId: template.toAccountId,
      },
      accountId,
    );
    if (delta === 0n) continue;

    moves.push({ date, name: occurrence.name, deltaCents: delta });
  }

  /* ---- The bills that skip months, over the whole window ---- */

  const irregular = templates.filter((template) => isIrregular(template.cadence));
  const lumpOccurrences =
    irregular.length === 0
      ? []
      : generateOccurrences({
          templates: irregular.map((template) => template.spec),
          paySchedules,
          from: today,
          to: until,
          weekendRule: household.weekendWithdrawalRule,
        });

  const lumps: Lump[] = [];
  for (const occurrence of lumpOccurrences) {
    const template = byId.get(occurrence.templateId);
    if (template === undefined) continue;

    const date = occurrence.date ?? occurrence.anchorPaydayDate;
    if (date === undefined) continue;

    // Money going out only. A yearly thing arriving - a tax refund - is real,
    // and it is not something to put money aside for; this list is read as
    // "what is coming for you".
    if (occurrence.cents >= 0n) continue;

    lumps.push({
      name: occurrence.name,
      date,
      cents: -occurrence.cents,
      cadence: template.cadence,
    });
  }

  const months = computeYearAhead({
    from: today,
    monthCount,
    startBalanceCents: context.balance.effectiveCents,
    moves,
    lumps,
  });

  return {
    months,
    setAside: setAsideFor(months),
    startBalanceCents: context.balance.effectiveCents,
    ledgerThrough: horizonEnd,
    hasBalance: accountId !== null,
  };
}
