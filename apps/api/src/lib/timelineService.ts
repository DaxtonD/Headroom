/**
 * Loads the household's facts and hands them to `@headroom/core`.
 *
 * Nothing derived is read from or written to the database: running balances,
 * the lowest point, safe-to-spend, left-over and coverage are all computed
 * here on demand from the stored facts (HANDOFF section 16.1 rule 5). That is
 * why the web app can run the identical engine locally for instant feedback
 * and still treat the server's answer as authoritative.
 */
import {
  computeHorizonEnd,
  computePayPeriods,
  computeTimeline,
  effectiveBalance,
  type PayPeriod,
  type PaySchedule,
  type PlainDate,
  type TimelineInput,
  type TimelineResult,
} from "@headroom/core";
import type { PrismaClient } from "../generated/prisma/client.js";
import { paydaysWithLivePay } from "./generateService.js";
import type { PrismaLike } from "./versioning.js";

/**
 * A `@db.Date` column as a plain date.
 *
 * Prisma reads a Postgres `date` as a JS `Date` at midnight UTC, so the UTC
 * portion is exactly the stored day. Using local getters here would shift the
 * day for anyone west of UTC, which is everyone in Saskatchewan.
 */
export function toPlainDate(value: Date): PlainDate {
  return value.toISOString().slice(0, 10);
}

/** Midnight UTC for a plain date, which is how `@db.Date` round-trips. */
export function fromPlainDate(value: PlainDate): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Today, in the household's timezone.
 *
 * `en-CA` formats dates as `YYYY-MM-DD`, which is the shape this codebase uses
 * throughout. The server clock decides what "today" is (section 16.1 rule 10);
 * a client's idea of the date is never trusted.
 */
export function todayInZone(timezone: string, now: Date = new Date()): PlainDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface TimelineContext {
  readonly householdId: string;
  readonly today: PlainDate;
  readonly horizonEnd: PlainDate;
  readonly cushionCents: bigint;
  readonly timeline: TimelineResult;
  readonly payPeriods: readonly PayPeriod[];
  readonly paySchedules: readonly PaySchedule[];
  readonly balance: {
    readonly cents: bigint;
    readonly asOf: Date | null;
    readonly enteredBy: { readonly id: string; readonly name: string; readonly initial: string } | null;
    /** Includes anything cleared since the snapshot was taken. */
    readonly effectiveCents: bigint;
  };
  readonly accountId: string | null;
}

/**
 * Everything Home, Upcoming and Pay plan need, in one read.
 *
 * Deliberately one function: the three screens must never disagree about the
 * balance, the horizon or the ordering.
 */
export async function loadTimelineContext(
  prisma: PrismaLike,
  householdId: string,
  now: Date = new Date(),
): Promise<TimelineContext> {
  const household = await prisma.household.findUniqueOrThrow({
    where: { id: householdId },
    select: {
      timezone: true,
      cushionCents: true,
      horizonPaychequeCount: true,
      weekendWithdrawalRule: true,
    },
  });

  const today = todayInZone(household.timezone, now);

  const [schedules, account] = await Promise.all([
    prisma.paySchedule.findMany({
      where: { deletedAt: null, user: { householdId, deletedAt: null } },
      select: { id: true, userId: true, anchorDate: true, defaultCents: true },
      orderBy: { anchorDate: "asc" },
    }),
    // Chequing by KIND, not by creation order. The savings account is an
    // Account row too, and "whichever row came first" would have let a savings
    // balance be read as the money available to spend.
    prisma.account.findFirst({
      where: { householdId, deletedAt: null, kind: "chequing" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const paySchedules: PaySchedule[] = schedules.map((schedule) => ({
    id: schedule.id,
    ownerId: schedule.userId,
    anchorDate: toPlainDate(schedule.anchorDate),
    defaultCents: schedule.defaultCents,
  }));

  // The horizon needs at least one schedule; with none, show a fortnight.
  const horizonEnd =
    paySchedules.length > 0
      ? computeHorizonEnd({
          today,
          paySchedules,
          paychequeCount: household.horizonPaychequeCount,
        })
      : addDaysToPlainDate(today, 14);

  const snapshot = account
    ? await prisma.balanceSnapshot.findFirst({
        where: { accountId: account.id },
        orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
        select: {
          cents: true,
          asOf: true,
          enteredBy: { select: { id: true, name: true, initial: true } },
        },
      })
    : null;

  // Anything cleared AFTER the snapshot has already hit the account, so it is
  // added to the typed-in figure and leaves the timeline (section 6.1).
  const clearedSince = snapshot
    ? await prisma.occurrence.findMany({
        where: {
          householdId,
          deletedAt: null,
          clearedAt: { gt: snapshot.asOf },
        },
        select: { cents: true },
      })
    : [];

  const snapshotCents = snapshot?.cents ?? 0n;
  const effectiveCents = effectiveBalance(
    snapshotCents,
    clearedSince.map((occurrence) => occurrence.cents),
  );

  /*
   * Cheques that have arrived, and paydays whose pay has been turned off.
   *
   * Both are reasons a payday legitimately has no row on the timeline, and
   * neither is something the engine can work out for itself - so without them
   * it projected a cheque for the payday and counted the same pay twice.
   *
   * Only cheques dated today or later are needed: the windows start today, so
   * no earlier payday is ever projected.
   */
  const [receivedCheques, livePaydays] = await Promise.all([
    prisma.occurrence.findMany({
      where: {
        householdId,
        deletedAt: null,
        kind: "paycheque",
        clearedAt: { not: null },
        date: { gte: fromPlainDate(today) },
      },
      select: { date: true },
    }),
    paydaysWithLivePay(prisma, householdId),
  ]);

  const receivedPaycheques = receivedCheques
    .filter((cheque): cheque is { date: Date } => cheque.date !== null)
    .map((cheque) => ({ scheduleId: null, date: toPlainDate(cheque.date) }));

  const paydaysWithoutPay = paySchedules
    .filter((schedule) => !livePaydays.has(schedule.id))
    .map((schedule) => schedule.id);

  const rows = await prisma.occurrence.findMany({
    where: {
      householdId,
      deletedAt: null,
      // Cleared items have left the timeline.
      clearedAt: null,
      OR: [
        // Dated items up to the horizon. A dated item in the past that has not
        // cleared is still coming: the money has not moved yet.
        { date: { lte: fromPlainDate(horizonEnd) } },
        // Flexible items have no date; the engine places them by anchor.
        { date: null },
      ],
    },
    select: {
      id: true,
      name: true,
      cents: true,
      kind: true,
      withdrawal: true,
      date: true,
      anchorOccurrenceId: true,
      sortIndex: true,
      isOneOff: true,
      verifiedAt: true,
      templateId: true,
      ownerUserId: true,
      version: true,
    },
    orderBy: [{ date: "asc" }, { sortIndex: "asc" }],
  });

  const includedIds = new Set(rows.map((row) => row.id));

  const events: TimelineInput[] = rows
    // A flexible item whose anchor fell outside the window would have nothing
    // to hang from, so it waits until its anchor is in view.
    .filter(
      (row) =>
        row.withdrawal === "auto" ||
        row.anchorOccurrenceId === null ||
        includedIds.has(row.anchorOccurrenceId),
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      cents: row.cents,
      kind: row.kind,
      placement: row.withdrawal,
      date: row.date ? toPlainDate(row.date) : undefined,
      anchorId: row.anchorOccurrenceId,
      sortIndex: row.sortIndex,
      isOneOff: row.isOneOff,
      verified: row.verifiedAt !== null,
      ownerId: row.ownerUserId,
      payScheduleId: null,
    }));

  const timeline = computeTimeline({
    events,
    startBalanceCents: effectiveCents,
    cushionCents: household.cushionCents,
  });

  const payPeriods =
    paySchedules.length > 0
      ? computePayPeriods({
          timeline,
          paySchedules,
          today,
          periodCount: 3,
          // Three windows is the minimum the mockups show; the horizon is an
          // editable setting, so the windows follow it rather than assuming
          // three will reach far enough.
          coverThrough: horizonEnd,
          // Windows are anchored on the earliest schedule, which is how the
          // spreadsheet's two-week columns line up.
          anchorScheduleId: paySchedules[0]?.id,
          cushionCents: household.cushionCents,
          receivedPaycheques,
          paydaysWithoutPay,
        })
      : [];

  return {
    householdId,
    today,
    horizonEnd,
    cushionCents: household.cushionCents,
    timeline,
    payPeriods,
    paySchedules,
    accountId: account?.id ?? null,
    balance: {
      cents: snapshotCents,
      asOf: snapshot?.asOf ?? null,
      enteredBy: snapshot?.enteredBy ?? null,
      effectiveCents,
    },
  };
}

function addDaysToPlainDate(value: PlainDate, days: number): PlainDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The extra per-row detail the Upcoming screen shows. */
export interface OccurrenceDecoration {
  readonly version: number;
  readonly templateId: string | null;
  readonly owner: { readonly id: string; readonly name: string; readonly initial: string } | null;
  readonly verifiedBy: { readonly id: string; readonly name: string; readonly initial: string } | null;
  readonly verifiedAt: Date | null;
  readonly paidBy: { readonly id: string; readonly name: string; readonly initial: string } | null;
  readonly paidAt: Date | null;
}

/**
 * Versions and verifier details for the rows on screen.
 *
 * Fetched separately from the engine inputs because the engine has no business
 * knowing about row versions or who verified what: it computes money.
 */
export async function loadOccurrenceDecorations(
  prisma: PrismaClient,
  ids: readonly string[],
): Promise<Map<string, OccurrenceDecoration>> {
  if (ids.length === 0) return new Map();

  const rows = await prisma.occurrence.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      version: true,
      templateId: true,
      verifiedAt: true,
      paidAt: true,
      owner: { select: { id: true, name: true, initial: true } },
      verifiedBy: { select: { id: true, name: true, initial: true } },
      paidBy: { select: { id: true, name: true, initial: true } },
    },
  });

  return new Map(
    rows.map((row) => [
      row.id,
      {
        version: row.version,
        templateId: row.templateId,
        owner: row.owner,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt,
        paidBy: row.paidBy,
        paidAt: row.paidAt,
      },
    ]),
  );
}
