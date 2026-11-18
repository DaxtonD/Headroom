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
/**
 * How long a settled row stays on the ledger after it was ticked.
 *
 * Long enough to answer "is that one paid?" for the cycle you paid it in, and
 * no longer. It does not need to cover the gap until the next one is due: the
 * horizon runs four paycheques ahead, so next month's instance of a monthly
 * bill has been on screen for weeks by the time this month's ages out. A bill
 * never disappears - only one month of it does, and only once its successor
 * is already visible.
 *
 * Measured from the moment it was settled rather than from its date, for two
 * reasons: a flexible row has no date of its own and would otherwise never
 * age out at all, and "a fortnight after you ticked it" is a rule somebody
 * can hold in their head.
 */
const SETTLED_VISIBLE_DAYS = 14;

/**
 * When the household first said this had left the account, or null if nobody
 * has said so.
 *
 * `paidAt` is a tick on the ledger and `clearedAt` is a tick in the balance
 * checklist, and both assert the same fact. A row can carry both, so one
 * value has to win, and it has to be the EARLIER of the two.
 *
 * Take a bill ticked paid at 11:27, a balance typed at 11:28, and the row
 * cleared at 11:30. The 11:28 figure was read off the bank after the money
 * left, so it already contains the bill. The earlier timestamp says settled
 * at 11:27, which is not after the snapshot, so it is not applied again -
 * correct. The later one says 11:30, which is, and the bill would come out of
 * the account twice.
 */
export function settledMoment(row: {
  readonly paidAt: Date | null;
  readonly clearedAt: Date | null;
}): Date | null {
  const { paidAt, clearedAt } = row;
  if (paidAt !== null && clearedAt !== null) return paidAt < clearedAt ? paidAt : clearedAt;
  return paidAt ?? clearedAt;
}

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

  /*
   * Anything settled AFTER the snapshot has already hit the account, so it is
   * applied to the typed-in figure (section 6.1).
   *
   * This is what makes the balance follow a tick: pay a bill, mark it paid,
   * and the figure at the top goes down without anybody having to read the
   * bank again. The household's rule for it is that the app suggests what the
   * balance should be from what it knows, and the frequent manual updates
   * define what really exists.
   *
   * The strict `>` is the whole safety argument, and it needs no logic of its
   * own. A tick older than the newest typed figure stops being applied,
   * because a balance read off the bank after the money left already contains
   * it. So the moment somebody types what the bank actually says, every
   * earlier tick drops out and the typed figure stands alone. Ties go to the
   * snapshot, which is the safe direction.
   *
   * SQL gets a superset - a row qualifies if EITHER timestamp is recent
   * enough - because Prisma cannot express "the earlier of these two columns"
   * in a where clause. `settledMoment` then decides exactly, in one place.
   */
  const settledCandidates = snapshot
    ? await prisma.occurrence.findMany({
        where: {
          householdId,
          deletedAt: null,
          OR: [{ paidAt: { gt: snapshot.asOf } }, { clearedAt: { gt: snapshot.asOf } }],
        },
        select: { cents: true, paidAt: true, clearedAt: true },
      })
    : [];

  const settledSince = settledCandidates.filter((occurrence) => {
    const moment = settledMoment(occurrence);
    return moment !== null && moment > (snapshot as { asOf: Date }).asOf;
  });

  const snapshotCents = snapshot?.cents ?? 0n;
  const effectiveCents = effectiveBalance(
    snapshotCents,
    settledSince.map((occurrence) => occurrence.cents),
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
        // Received or cleared: both say the cheque has landed. Testing only
        // `clearedAt` here would let a cheque that was marked received, but
        // not yet taken into a typed balance, be projected a second time -
        // which overstates the account, the one direction that is not safe.
        OR: [{ paidAt: { not: null } }, { clearedAt: { not: null } }],
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

  /*
   * A settled row stays on the ledger; it just stops counting.
   *
   * This used to read `clearedAt: null`, which took a row off the ledger the
   * moment it was dealt with. That is the disappearing act the household
   * objected to: a bill ticked paid, then swept away by the next balance
   * update, with nothing on screen to say it would be.
   *
   * Within the horizon, anything not yet dealt with is kept with no lower
   * bound - a dated item in the past that has not settled is still coming,
   * because the money has not moved yet.
   */
  const settledFloor = new Date(now.getTime() - SETTLED_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
  const horizonCutoff = fromPlainDate(horizonEnd);
  // Flexible items have no date; the engine places them by anchor.
  const withinHorizon = { OR: [{ date: { lte: horizonCutoff } }, { date: null }] };

  const rows = await prisma.occurrence.findMany({
    where: {
      householdId,
      deletedAt: null,
      OR: [
        // Still to come, or overdue and nobody has said it is dealt with.
        { AND: [{ paidAt: null }, { clearedAt: null }, withinHorizon] },
        // Settled recently enough to still be worth looking at. The SQL is
        // the same superset as above; a row kept a few days longer because
        // its later timestamp is recent is cosmetic, not arithmetic.
        {
          AND: [
            { OR: [{ paidAt: { gte: settledFloor } }, { clearedAt: { gte: settledFloor } }] },
            withinHorizon,
          ],
        },
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
      paidAt: true,
      clearedAt: true,
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
      settled: settledMoment(row) !== null,
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
