/**
 * Turning templates into occurrences (HANDOFF section 6.5).
 *
 * A template says "the mortgage comes out the day after each of Dax's
 * paydays". This module works out the actual dates, far enough ahead to cover
 * the horizon plus one pay period, and hands back a list of occurrences to
 * create.
 *
 * It is pure: it reads no clock and touches no database. Dates in, dates out.
 * Each generated occurrence carries a `periodKey` that is unique per template,
 * which is what the database's unique constraint uses to make generating twice
 * - or twice at the same moment - impossible to duplicate.
 *
 * Editing one occurrence never edits its template. "Change for all future" is
 * a separate, deliberate action.
 */
import {
  addDays,
  applyWeekendRule,
  compareDates,
  monthlyOccurrenceDate,
  parseDate,
  paydaysBetween,
  type MonthlyDay,
  type PlainDate,
  type WeekendRule,
} from "./dates.js";
import type { Cents } from "./money.js";
import type { OccurrenceKind, PaySchedule, Placement } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

export type ScheduleSpec =
  /** The 17th of every month. `day` is clamped to a short month's length. */
  | { readonly type: "monthly"; readonly day: number }
  /** The last day of every month, which is how "the 31st" behaves. */
  | { readonly type: "monthly_last" }
  /** A fixed number of days after each of one person's paydays. */
  | { readonly type: "relative_to_pay"; readonly payScheduleId: string; readonly offsetDays: number }
  /** A paycheque: every 14 days from the schedule's anchor. */
  | { readonly type: "biweekly"; readonly payScheduleId: string }
  /** Undated, attached to a paycheque, movable. */
  | { readonly type: "flexible"; readonly frequency: "monthly" | "per_pay_period" };

export interface TemplateSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: OccurrenceKind;
  /** The usual amount. An occurrence can be edited away from it at any time. */
  readonly defaultCents: Cents;
  readonly schedule: ScheduleSpec;
  readonly ownerId?: string | null | undefined;
  readonly active?: boolean | undefined;
  /** Where it sits among the other items on the same day or anchor. */
  readonly sortIndex?: number | undefined;
}

/**
 * One occurrence to create.
 *
 * A flexible item has no date; it carries the payday it should hang from, as a
 * date. Resolving that to a particular paycheque row is the database's job,
 * not the engine's.
 */
export interface GeneratedOccurrence {
  readonly templateId: string;
  /** Unique per template. The database constraint relies on this. */
  readonly periodKey: string;
  readonly name: string;
  readonly cents: Cents;
  readonly kind: OccurrenceKind;
  readonly placement: Placement;
  readonly date?: PlainDate | undefined;
  /** For a flexible item: the payday it should be anchored to. */
  readonly anchorPaydayDate?: PlainDate | undefined;
  readonly sortIndex: number;
  readonly ownerId?: string | null | undefined;
}

export interface GenerateOptions {
  readonly templates: readonly TemplateSpec[];
  readonly paySchedules: readonly PaySchedule[];
  /** Generate from this date onwards, inclusive. */
  readonly from: PlainDate;
  /** Generate up to this date, inclusive. */
  readonly to: PlainDate;
  /** Section 14 question 8. Applies to dated items only. */
  readonly weekendRule?: WeekendRule;
}

/**
 * How far past the horizon to generate, so the next pay period is already
 * populated when the horizon rolls forward (section 6.5).
 */
export const GENERATION_LOOKAHEAD_DAYS = 14;

/** The window to generate for: the horizon plus one pay period. */
export function generationWindow(today: PlainDate, horizonEnd: PlainDate): { from: PlainDate; to: PlainDate } {
  return { from: today, to: addDays(horizonEnd, GENERATION_LOOKAHEAD_DAYS) };
}

/**
 * Every occurrence the templates call for in `[from, to]`.
 *
 * Deterministic: the same inputs always produce the same list, in the same
 * order, with the same period keys. That is what makes it safe to run twice.
 */
export function generateOccurrences(options: GenerateOptions): GeneratedOccurrence[] {
  const weekendRule = options.weekendRule ?? "as_scheduled";
  const schedulesById = new Map(options.paySchedules.map((schedule) => [schedule.id, schedule]));

  const generated: GeneratedOccurrence[] = [];

  for (const template of options.templates) {
    if (template.active === false) continue;

    switch (template.schedule.type) {
      case "monthly":
        generated.push(
          ...monthlyOccurrences(template, template.schedule.day, options, weekendRule),
        );
        break;

      case "monthly_last":
        generated.push(...monthlyOccurrences(template, "last", options, weekendRule));
        break;

      case "relative_to_pay": {
        const schedule = schedulesById.get(template.schedule.payScheduleId);
        if (!schedule) {
          throw new Error(
            `Template "${template.name}" follows pay schedule "${template.schedule.payScheduleId}", which does not exist.`,
          );
        }
        generated.push(
          ...relativeToPayOccurrences(template, schedule, template.schedule.offsetDays, options, weekendRule),
        );
        break;
      }

      case "biweekly": {
        const schedule = schedulesById.get(template.schedule.payScheduleId);
        if (!schedule) {
          throw new Error(
            `Paycheque template "${template.name}" names pay schedule "${template.schedule.payScheduleId}", which does not exist.`,
          );
        }
        generated.push(...biweeklyOccurrences(template, schedule, options));
        break;
      }

      case "flexible":
        generated.push(
          ...flexibleOccurrences(template, template.schedule.frequency, options),
        );
        break;

      default: {
        const exhaustive: never = template.schedule;
        throw new Error(`Unknown schedule type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Stable order, so two runs produce identical lists.
  generated.sort(
    (a, b) =>
      compareDates(a.date ?? a.anchorPaydayDate ?? "", b.date ?? b.anchorPaydayDate ?? "") ||
      a.sortIndex - b.sortIndex ||
      a.templateId.localeCompare(b.templateId) ||
      a.periodKey.localeCompare(b.periodKey),
  );

  return generated;
}

/* -------------------------------------------------------------------------- */
/* One schedule type at a time                                                */
/* -------------------------------------------------------------------------- */

/** Every month touched by `[from, to]`, as `{year, month}`. */
function monthsBetween(from: PlainDate, to: PlainDate): { year: number; month: number }[] {
  const start = parseDate(from);
  const end = parseDate(to);
  const months: { year: number; month: number }[] = [];

  let year = start.year;
  let month = start.month;

  while (year < end.year || (year === end.year && month <= end.month)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthlyOccurrences(
  template: TemplateSpec,
  day: MonthlyDay,
  options: GenerateOptions,
  weekendRule: WeekendRule,
): GeneratedOccurrence[] {
  const result: GeneratedOccurrence[] = [];

  for (const { year, month } of monthsBetween(options.from, options.to)) {
    const scheduled = monthlyOccurrenceDate(year, month, day);
    const date = applyWeekendRule(scheduled, weekendRule);

    if (compareDates(date, options.from) < 0 || compareDates(date, options.to) > 0) continue;

    result.push({
      templateId: template.id,
      // Keyed by the month, not the date: moving a bill to a different day of
      // the month must not generate a second copy for that month.
      periodKey: monthKey(year, month),
      name: template.name,
      cents: outflowSign(template),
      kind: template.kind,
      placement: "auto",
      date,
      sortIndex: template.sortIndex ?? 0,
      ownerId: template.ownerId,
    });
  }

  return result;
}

function relativeToPayOccurrences(
  template: TemplateSpec,
  schedule: PaySchedule,
  offsetDays: number,
  options: GenerateOptions,
  weekendRule: WeekendRule,
): GeneratedOccurrence[] {
  // Look back far enough that a payday just before the window still produces
  // its occurrence inside it, which is how the mortgage behaves the day after.
  const searchFrom = addDays(options.from, -Math.abs(offsetDays) - 1);
  const searchTo = addDays(options.to, Math.abs(offsetDays) + 1);

  const result: GeneratedOccurrence[] = [];

  for (const payday of paydaysBetween(schedule.anchorDate, searchFrom, searchTo)) {
    const scheduled = addDays(payday, offsetDays);
    const date = applyWeekendRule(scheduled, weekendRule);

    if (compareDates(date, options.from) < 0 || compareDates(date, options.to) > 0) continue;

    result.push({
      templateId: template.id,
      // Keyed by the payday it follows, which is the thing that identifies it.
      periodKey: payday,
      name: template.name,
      cents: outflowSign(template),
      kind: template.kind,
      placement: "auto",
      date,
      sortIndex: template.sortIndex ?? 0,
      ownerId: template.ownerId,
    });
  }

  return result;
}

function biweeklyOccurrences(
  template: TemplateSpec,
  schedule: PaySchedule,
  options: GenerateOptions,
): GeneratedOccurrence[] {
  return paydaysBetween(schedule.anchorDate, options.from, options.to).map((payday) => ({
    templateId: template.id,
    periodKey: payday,
    name: template.name,
    cents: absOf(template.defaultCents),
    kind: template.kind,
    placement: "auto" as const,
    date: payday,
    // Paychequess land first on their day (section 6.2), and the timeline
    // ordering enforces that too.
    sortIndex: template.sortIndex ?? 0,
    ownerId: template.ownerId,
  }));
}

/**
 * Flexible items: undated, hung off a paycheque.
 *
 * `monthly` produces one per month, anchored to the first paycheque of that
 * month. `per_pay_period` produces one per pay period, anchored to its
 * paycheque. Either can be moved afterwards without generating another.
 */
function flexibleOccurrences(
  template: TemplateSpec,
  frequency: "monthly" | "per_pay_period",
  options: GenerateOptions,
): GeneratedOccurrence[] {
  const allPaydays = everyPayday(options);
  if (allPaydays.length === 0) return [];

  if (frequency === "per_pay_period") {
    return allPaydays.map((payday) => ({
      templateId: template.id,
      periodKey: payday,
      name: template.name,
      cents: outflowSign(template),
      kind: template.kind,
      placement: "flexible" as const,
      anchorPaydayDate: payday,
      sortIndex: template.sortIndex ?? 0,
      ownerId: template.ownerId,
    }));
  }

  const result: GeneratedOccurrence[] = [];

  for (const { year, month } of monthsBetween(options.from, options.to)) {
    // The first payday of that month, whoever it belongs to.
    const firstPayday = allPaydays.find((payday) => {
      const parts = parseDate(payday);
      return parts.year === year && parts.month === month;
    });
    if (!firstPayday) continue;

    result.push({
      templateId: template.id,
      periodKey: monthKey(year, month),
      name: template.name,
      cents: outflowSign(template),
      kind: template.kind,
      placement: "flexible",
      anchorPaydayDate: firstPayday,
      sortIndex: template.sortIndex ?? 0,
      ownerId: template.ownerId,
    });
  }

  return result;
}

/** Every payday from every schedule in the window, in order, deduplicated. */
function everyPayday(options: GenerateOptions): PlainDate[] {
  const paydays = new Set<PlainDate>();
  for (const schedule of options.paySchedules) {
    for (const payday of paydaysBetween(schedule.anchorDate, options.from, options.to)) {
      paydays.add(payday);
    }
  }
  return [...paydays].sort(compareDates);
}

function absOf(value: Cents): Cents {
  return value < 0n ? -value : value;
}

/**
 * The sign an occurrence should carry.
 *
 * Templates store a magnitude - "the power bill is $186" - and the direction
 * comes from what kind of thing it is. A bill or a transfer leaves the
 * account; a deposit or a paycheque arrives.
 */
function outflowSign(template: TemplateSpec): Cents {
  const magnitude = absOf(template.defaultCents);
  return template.kind === "bill" || template.kind === "transfer" ? -magnitude : magnitude;
}
