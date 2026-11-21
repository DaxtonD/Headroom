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
  accountDelta,
  computeHorizonEnd,
  computePayPeriods,
  computeTimeline,
  effectiveBalance,
  type AccountMove,
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

type AccountKind = "chequing" | "savings" | "credit_card";

/**
 * A typed-in figure, as the engine projects it.
 *
 * Every amount in this database is a positive magnitude and its meaning comes
 * from what holds it - the same rule `Asset` uses for a liability. So a card
 * balance is stored as the debt: "$842.00 owed" is 84_200, not -84_200.
 *
 * The engine has no notion of a liability. It projects a balance, and owing
 * money is a negative one, which is what lets one engine run every account
 * with no special case for cards anywhere inside it. The flip happens here,
 * at the edge, and nowhere else.
 */
function toSignedBalance(kind: AccountKind, typedCents: bigint): bigint {
  return kind === "credit_card" ? -typedCents : typedCents;
}

/** And back again, for a person to read. */
function toTypedFigure(kind: AccountKind, signedCents: bigint): bigint {
  return kind === "credit_card" ? -signedCents : signedCents;
}

/**
 * A stored occurrence as a move between accounts.
 *
 * A null source is chequing, which is what every row meant before there was a
 * second account for money to leave. Resolving it to the real account id here
 * means the engine never has to guess, and refuses a row that failed to say.
 */
export function accountMoveOf(
  row: {
    readonly cents: bigint;
    readonly paidFromAccountId: string | null;
    readonly transferToAccountId: string | null;
  },
  chequingAccountId: string | null,
): AccountMove {
  return {
    cents: row.cents,
    fromAccountId: row.paidFromAccountId ?? chequingAccountId,
    toAccountId: row.transferToAccountId,
  };
}

export function todayInZone(timezone: string, now: Date = new Date()): PlainDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * One account's position: what it holds now, and where it is heading.
 *
 * Every figure is in the terms a person reads - a card's are what it OWES -
 * and every one of them is derived on this request from the same events the
 * ledger is built from. None of it is stored (section 16.1 rule 5).
 */
export interface AccountOutlook {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  /** The picture beside the name, or null for none. */
  readonly imageId: string | null;
  /** The last figure somebody typed in, exactly as they typed it. */
  readonly snapshotCents: bigint;
  readonly asOf: Date | null;
  readonly enteredBy: { readonly id: string; readonly name: string; readonly initial: string } | null;
  /** That figure plus everything settled after it: what it is at now. */
  readonly effectiveCents: bigint;
  /** Where it lands at the end of the horizon. */
  readonly horizonCents: bigint;
  /**
   * The furthest it gets in the wrong direction anywhere in the horizon: the
   * lowest a chequing or savings balance drops, the most a card ever owes.
   */
  readonly extremeCents: bigint;
  /** Transfers into this account that are scheduled and have not happened. */
  readonly scheduledInCents: bigint;
  /**
   * A card that owes money with nothing scheduled to pay it.
   *
   * This is the one thing that got riskier when charges correctly stopped
   * draining the chequing forecast: the debt can now grow while safe-to-spend
   * looks healthy. The household chose to keep safe-to-spend a pure chequing
   * figure - it is the one number whose working can be shown in a sentence -
   * and to make this impossible to miss instead. So it has to be right.
   */
  readonly needsPayment: boolean;
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
  /** Every account the household has, chequing included, in creation order. */
  readonly accounts: readonly AccountOutlook[];
  /**
   * Each account's own projection of the same events, by account id.
   *
   * Published because "which rows moved this account" is a question two
   * screens ask - the balance checklist and the card strip - and deriving it
   * twice is how two answers start disagreeing. A row's `deltaCents` here is
   * already the whole test: nothing else needs to know the sign rules.
   */
  readonly projections: ReadonlyMap<string, TimelineResult>;
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

  const [schedules, accountRows] = await Promise.all([
    prisma.paySchedule.findMany({
      where: { deletedAt: null, user: { householdId, deletedAt: null } },
      select: { id: true, userId: true, anchorDate: true, defaultCents: true },
      orderBy: { anchorDate: "asc" },
    }),
    prisma.account.findMany({
      where: { householdId, deletedAt: null },
      select: { id: true, name: true, kind: true, imageId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Chequing by KIND, not by creation order. Savings and the cards are Account
  // rows too, and "whichever row came first" would have let one of their
  // balances be read as the money available to spend.
  const account = accountRows.find((row) => row.kind === "chequing") ?? null;
  const chequingAccountId = account?.id ?? null;

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

  /*
   * The latest typed figure for each account, in parallel.
   *
   * One query per account rather than one clever one: "the newest row per
   * group" is awkward in Prisma, the count is the number of accounts a
   * household has, and the index on (accountId, asOf) makes each one a seek.
   */
  const snapshotEntries = await Promise.all(
    accountRows.map(
      async (row) =>
        [
          row.id,
          await prisma.balanceSnapshot.findFirst({
            where: { accountId: row.id },
            orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
            select: {
              cents: true,
              asOf: true,
              enteredBy: { select: { id: true, name: true, initial: true } },
            },
          }),
        ] as const,
    ),
  );
  const snapshots = new Map(snapshotEntries);
  const snapshot = account ? (snapshots.get(account.id) ?? null) : null;

  /**
   * The moment after which a settled row still counts toward an account.
   *
   * The account's own snapshot, because a figure read off the bank after the
   * money left already contains it. With no snapshot at all, the account's
   * creation: otherwise ticking a charge on a freshly added card would take it
   * out of the projection without ever having put it into the balance, and the
   * debt would go DOWN as charges landed.
   */
  const settledCutoffFor = (row: { readonly id: string; readonly createdAt: Date }): Date =>
    snapshots.get(row.id)?.asOf ?? row.createdAt;

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
  const earliestCutoff = accountRows.reduce<Date | null>((earliest, row) => {
    const cutoff = settledCutoffFor(row);
    return earliest === null || cutoff < earliest ? cutoff : earliest;
  }, null);

  const settledCandidates = earliestCutoff
    ? await prisma.occurrence.findMany({
        where: {
          householdId,
          deletedAt: null,
          OR: [{ paidAt: { gt: earliestCutoff } }, { clearedAt: { gt: earliestCutoff } }],
        },
        select: {
          cents: true,
          paidAt: true,
          clearedAt: true,
          paidFromAccountId: true,
          transferToAccountId: true,
        },
      })
    : [];

  /**
   * What one account is at right now: the figure typed in, plus everything
   * that has settled since, in that account's own terms.
   *
   * This is what makes a balance follow a tick. Pay a bill, mark it paid, and
   * the figure at the top goes down without anybody reading the bank again -
   * and marking a charge paid raises what the card owes, while chequing does
   * not move, because none of its money did.
   *
   * The strict `>` is the whole safety argument and needs no logic of its own.
   * A tick older than the newest typed figure stops being applied, because a
   * balance read off the bank after the money left already contains it. So the
   * moment somebody types what the bank says, every earlier tick drops out and
   * the typed figure stands alone. Ties go to the snapshot, the safe direction.
   */
  const effectiveSignedFor = (row: {
    readonly id: string;
    readonly kind: AccountKind;
    readonly createdAt: Date;
  }): bigint => {
    const cutoff = settledCutoffFor(row);
    const deltas = settledCandidates
      .filter((occurrence) => {
        const moment = settledMoment(occurrence);
        return moment !== null && moment > cutoff;
      })
      .map((occurrence) => accountDelta(accountMoveOf(occurrence, chequingAccountId), row.id));

    return effectiveBalance(
      toSignedBalance(row.kind, snapshots.get(row.id)?.cents ?? 0n),
      deltas,
    );
  };

  const snapshotCents = snapshot?.cents ?? 0n;
  const effectiveCents = account ? effectiveSignedFor(account) : snapshotCents;

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
      paidFromAccountId: true,
      transferToAccountId: true,
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
      // Resolved here, so the engine is never asked to guess which account a
      // row left. A null source has always meant chequing.
      fromAccountId: row.paidFromAccountId ?? chequingAccountId,
      toAccountId: row.transferToAccountId,
    }));

  const timeline = computeTimeline({
    events,
    startBalanceCents: effectiveCents,
    cushionCents: household.cushionCents,
    accountId: chequingAccountId,
  });

  /*
   * The same events, once per account.
   *
   * Not a second engine and not a simpler one: a card is an account whose
   * balance happens to be negative, so `lowest` is the most it ever owes and
   * `leftThisCycleCents` is what it owes at the horizon, both for free. The
   * cushion and the coverage check are chequing's business and are left out.
   *
   * Projecting another account needs every row to name its source, which is
   * only true once there is a chequing account to resolve a null one to.
   */
  const projections = new Map<string, TimelineResult>();

  const accounts: AccountOutlook[] = accountRows.map((row) => {
    const kind = row.kind as AccountKind;
    const effectiveSigned = effectiveSignedFor({ ...row, kind });
    const own =
      chequingAccountId === null
        ? null
        : computeTimeline({ events, startBalanceCents: effectiveSigned, accountId: row.id });
    if (own) projections.set(row.id, own);

    const scheduledInCents = (own?.rows ?? [])
      .filter((entry) => entry.event.toAccountId === row.id && entry.deltaCents > 0n)
      .reduce((total, entry) => total + entry.deltaCents, 0n);

    const effectiveTyped = toTypedFigure(kind, effectiveSigned);
    const horizonTyped = toTypedFigure(
      kind,
      own ? own.leftThisCycleCents : effectiveSigned,
    );

    return {
      id: row.id,
      name: row.name,
      kind,
      imageId: row.imageId,
      snapshotCents: snapshots.get(row.id)?.cents ?? 0n,
      asOf: snapshots.get(row.id)?.asOf ?? null,
      enteredBy: snapshots.get(row.id)?.enteredBy ?? null,
      effectiveCents: effectiveTyped,
      horizonCents: horizonTyped,
      extremeCents: toTypedFigure(kind, own ? own.lowest.cents : effectiveSigned),
      scheduledInCents,
      /*
       * A card that owes money now, or will by the horizon, and has nothing
       * coming to pay it. Both halves matter: a card whose balance nobody has
       * typed yet still has charges heading for it, and a card with a balance
       * and no charges still has to be paid.
       */
      needsPayment:
        kind === "credit_card" &&
        scheduledInCents === 0n &&
        (effectiveTyped > 0n || horizonTyped > 0n),
    } satisfies AccountOutlook;
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
    accountId: chequingAccountId,
    accounts,
    projections,
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
  /**
   * The picture beside the name, taken from the bill this row came from.
   *
   * On the template rather than the row: a picture belongs to the thing, not
   * to one month of it, so changing it once changes every row - which is the
   * only behaviour anybody would expect from "change the image". A one-off has
   * no template and so has no picture, which is correct: there is nothing
   * recurring to recognise.
   */
  readonly imageId: string | null;
  /** Null means chequing, which is what the UI shows when nothing is set. */
  readonly paidFromAccountId: string | null;
  readonly transferToAccountId: string | null;
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
      template: { select: { imageId: true } },
      transferToAccount: { select: { imageId: true } },
      paidFromAccount: { select: { imageId: true } },
      verifiedAt: true,
      paidAt: true,
      paidFromAccountId: true,
      transferToAccountId: true,
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
        /*
         * The picture a row wears, in order of how specific it is: the one
         * somebody chose for the thing itself, then the account the money
         * landed in, then the account it came out of.
         *
         * A one-off has no template, so a payment toward the Visa showed a
         * lettered square beside a row whose whole subject is the Visa -
         * which has a picture, two inches up the same screen, in "On cards".
         * Reported from use on 2026-11-19 and fixed by the second fallback.
         *
         * ## The third one reverses what this comment used to say
         *
         * It read: "Only the DESTINATION. A charge paid FROM a card is a
         * purchase, not the card: it already names the card in a chip, and
         * giving it the card's logo would say the row IS the card." That was
         * a real argument and the household has now used it and disagreed,
         * 2026-11-20: "I just made a purchase on Amazon today. It was charged
         * to our Visa... now, on the ledger, there is no picture."
         *
         * They are right, and the argument was weighing the wrong risk. A
         * charge on a card is still a row ABOUT that card more than it is
         * about nothing, and nothing is what it was showing. The confusion
         * the old reasoning feared is handled where it belongs: a payment
         * toward the Visa carries a "Pays Visa" chip and a charge carries a
         * plain "Visa" one, so the two are told apart by words rather than by
         * the absence of a picture.
         *
         * This can only ever fire for a card or a savings account. Chequing
         * is stored as a NULL source - `routing.ts` keeps it out of every
         * source picker for that reason - so an ordinary chequing bill with
         * no picture of its own still gets a lettered square, and the ledger
         * does not turn into a column of the same chequing logo.
         */
        imageId:
          row.template?.imageId ??
          row.transferToAccount?.imageId ??
          row.paidFromAccount?.imageId ??
          null,
        paidFromAccountId: row.paidFromAccountId,
        transferToAccountId: row.transferToAccountId,
        owner: row.owner,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt,
        paidBy: row.paidBy,
        paidAt: row.paidAt,
      },
    ]),
  );
}
