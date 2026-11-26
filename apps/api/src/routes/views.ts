/**
 * The read endpoints behind Home, Upcoming and Pay plan (HANDOFF section 9).
 *
 * Every figure here is computed by `@headroom/core` from stored facts, on this
 * request. None of it is cached in the database, so there is no way for a
 * stored total to drift from the facts it came from.
 *
 * Amounts leave as strings: the reply serialiser turns every `bigint` into one,
 * because JSON has no bigint and a `number` would risk precision.
 */
import type { FastifyInstance } from "fastify";
import { HttpError } from "../lib/http.js";
import {
  loadOccurrenceDecorations,
  loadTimelineContext,
  type AccountOutlook,
  type OccurrenceDecoration,
} from "../lib/timelineService.js";
import { summariseTimeline, type TimelineRow } from "@headroom/core";

/**
 * One timeline row, as every screen receives it.
 *
 * Shared by the timeline and the pay plan deliberately: two serialisers for
 * the same row would drift, and then Upcoming and Pay plan would quietly
 * disagree about the same bill.
 */
function serialiseTimelineRow(row: TimelineRow, decoration: OccurrenceDecoration | undefined) {
  return {
    id: row.event.id,
    name: row.event.name,
    cents: row.event.cents,
    kind: row.event.kind,
    placement: row.event.placement,
    date: row.effectiveDate,
    // True when this row has its own date, rather than borrowing its anchor
    // paycheque's. The UI words the two differently.
    isDated: row.event.placement === "auto",
    anchorOccurrenceId: row.event.anchorId ?? null,
    isOneOff: row.event.isOneOff === true,
    verified: row.event.verified === true,
    verifiedBy: decoration?.verifiedBy ?? null,
    verifiedAt: decoration?.verifiedAt?.toISOString() ?? null,
    /*
     * "We have dealt with this."
     *
     * This used to be a tick that moved nothing, and the comment here said
     * the engine had no business seeing it. Both stopped being true when the
     * balance started following a tick: the money has left, so the figure at
     * the top comes down and the row stops counting forward.
     *
     * The two flags still say different things and the UI needs both. `paid`
     * is the gesture - who ticked it, and whether the button offers "Undo
     * paid". `settled` is the consequence the engine acted on, and it is also
     * true for a row taken into a typed balance by the checklist, which
     * nobody ever marked paid.
     */
    paid: decoration?.paidAt !== null && decoration?.paidAt !== undefined,
    paidBy: decoration?.paidBy ?? null,
    settled: row.event.settled === true,
    owner: decoration?.owner ?? null,
    requiresCoverage: row.requiresCoverage,
    runningCents: row.runningCents,
    /*
     * What this row did to the account the ledger is about, which for two
     * kinds of row is nothing: one already settled, one belonging to another
     * account - a charge on a credit card above all.
     *
     * Sent rather than inferred from the amount, because the amount is the
     * wrong thing to infer it from: a $95 charge on a card is a real $95 and
     * moved no chequing money at all. The UI shows a running balance only
     * where the balance actually ran.
     */
    deltaCents: row.deltaCents,
    /** Null means chequing. The UI names the account when it is not. */
    paidFromAccountId: decoration?.paidFromAccountId ?? null,
    /** Set when this row is a payment toward another account. */
    transferToAccountId: decoration?.transferToAccountId ?? null,
    /**
     * The picture: the bill's own, else the picture of whichever account the
     * row is about. `loadOccurrenceDecorations` holds the order and the
     * reasoning; nothing here may add a second rule for it.
     */
    imageId: decoration?.imageId ?? null,
    version: decoration?.version ?? 1,
    fromTemplate: decoration?.templateId !== null,
    /**
     * Whether this row can be taken off the ledger by hand.
     *
     * A one-off, which nothing produces, or a row whose bill has been
     * archived or deleted, which nothing produces any more. Sent rather than
     * worked out in the browser so the button and the route it calls agree:
     * a remove the screen offers and the API then refuses is worse than no
     * remove at all.
     */
    canRemove: row.event.isOneOff === true || decoration?.orphaned === true,
  };
}

/**
 * One account's position.
 *
 * Every figure is already in the terms a person reads it in - a card's are
 * what it owes - because the sign flip belongs at one edge, and that edge is
 * in the service rather than spread across the screens.
 */
function serialiseAccount(account: AccountOutlook) {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    imageId: account.imageId,
    cents: account.effectiveCents,
    snapshotCents: account.snapshotCents,
    asOf: account.asOf?.toISOString() ?? null,
    enteredBy: account.enteredBy,
    horizonCents: account.horizonCents,
    extremeCents: account.extremeCents,
    scheduledInCents: account.scheduledInCents,
    needsPayment: account.needsPayment,
  };
}

/** How many upcoming automatic withdrawals Home lists. */
const HOME_AUTO_COUNT = 4;

export async function registerViewRoutes(app: FastifyInstance): Promise<void> {
  /** Home: the one screen opened several times a day. */
  app.get("/dashboard", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const context = await loadTimelineContext(app.db.prisma, user.householdId);
    const { timeline } = context;

    const autoRows = timeline.rows.filter((row) => row.requiresCoverage);
    const nextAutoIds = autoRows.slice(0, HOME_AUTO_COUNT).map((row) => row.event.id);
    const mortgage = await app.db.prisma.mortgage.findFirst({
      where: { householdId: user.householdId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const mortgageId = mortgage?.id ?? null;

    const decorations = await loadOccurrenceDecorations(
      app.db.prisma,
      nextAutoIds,
      context.chequingImageId,
    );

    return reply.send({
      today: context.today,
      horizonEnd: context.horizonEnd,
      cushionCents: context.cushionCents,

      /*
       * The household row's version, for the one change this screen can make.
       *
       * "Purchases come from the Visa for now" is a household fact like any
       * other, so setting it needs `If-Match`. Sent here rather than fetched
       * from the settings screen: an extra request on the screen opened
       * several times a day, to carry one integer, is the wrong trade - and a
       * PATCH assembled without it would be a mutation on a money screen with
       * no conflict detection, which is the thing the rule exists to stop.
       */
      householdVersion: context.householdVersion,

      /*
       * Moves that would clear the first uncovered withdrawal.
       *
       * Empty unless something is short. Each one was applied to the events
       * and the whole timeline run again before being offered, so it clears
       * the shortfall and breaks nothing later - and the screen states them
       * as what WOULD happen rather than as instructions, because a flexible
       * item has no real due date in this model and only the household knows
       * whether a bill can wait.
       */
      suggestedMoves: context.suggestedMoves,

      /*
       * What the current period's room to save is for.
       *
       * The constraint and the policy, kept apart: `roomToSaveCents` on the
       * period is still the most that could leave chequing without something
       * later going short, and this says what the household decided to do
       * with it. Asked for on 2026-11-22, because one figure doing both jobs
       * read as an instruction to put all of it in savings.
       */
      roomAllocation: context.roomAllocation,

      /*
       * Where purchases come from, for now. Null is the ordinary state.
       *
       * Derived in `loadTimelineContext` so the banner and the one-off form's
       * default cannot disagree about whether it is in force - and so it
       * lapses by itself at midnight, with nothing to run.
       */
      spendFrom: context.spendFrom
        ? {
            accountId: context.spendFrom.accountId,
            accountName: context.spendFrom.accountName,
            until: context.spendFrom.until,
            note: context.spendFrom.note,
            setBy: context.spendFrom.setBy,
            setAt: context.spendFrom.setAt?.toISOString() ?? null,
          }
        : null,

      balance: {
        cents: context.balance.effectiveCents,
        // What the user actually typed in, and when, for "Updated today, 9:58 AM".
        snapshotCents: context.balance.cents,
        asOf: context.balance.asOf?.toISOString() ?? null,
        enteredBy: context.balance.enteredBy,
      },

      // Spending now lowers every later balance, so this is the lowest point
      // over the whole horizon less the cushion.
      safeToSpendNowCents: timeline.safeToSpendNowCents,
      leftThisCycleCents: timeline.leftThisCycleCents,
      lowest: timeline.lowest,

      coverage: {
        autoWithdrawalCount: timeline.coverage.autoWithdrawalCount,
        allCovered: timeline.coverage.allCovered,
        firstShortfall: timeline.coverage.firstShortfall,
      },

      estimatesCount: timeline.estimatesCount,

      /*
       * Every account, chequing included.
       *
       * The home screen leads with chequing and safe-to-spend, which is what
       * it is for. The cards come after them, with the warning that a card
       * owing money with nothing scheduled to pay it is the one thing that
       * got easier to miss once charges correctly stopped draining the
       * chequing forecast.
       */
      accounts: context.accounts.map(serialiseAccount),

      /*
       * Which mortgage a lump sum would pay, or null when there is none.
       *
       * Only the id: the ledger's one-off sheet needs to know whether to
       * offer "Paying the mortgage" at all and what to send, and nothing on
       * this screen shows anything else about it. The Savings screen remains
       * the place that reads the terms.
       */
      mortgageId,

      /*
       * The working behind the three headline figures, for the info button.
       *
       * Served rather than worked out in the browser, and taken straight off
       * the engine: "where did that number come from?" is only worth answering
       * if the answer cannot drift from the number itself.
       */
      breakdown: summariseTimeline(timeline),

      nextAutoWithdrawals: autoRows.slice(0, HOME_AUTO_COUNT).map((row) => {
        const decoration = decorations.get(row.event.id);
        return {
          id: row.event.id,
          name: row.event.name,
          cents: row.event.cents,
          date: row.effectiveDate,
          balanceAfterCents: row.runningCents,
          verified: row.event.verified === true,
          verifiedBy: decoration?.verifiedBy ?? null,
          // Ticked as dealt with, so this list says so too rather than leaving
          // the ledger and Home disagreeing about the same bill.
          paid: decoration?.paidAt !== null && decoration?.paidAt !== undefined,
          owner: decoration?.owner ?? null,
          version: decoration?.version ?? 1,
        };
      }),
    });
  });

  /** Upcoming: the full timeline with a running balance on every line. */
  app.get<{ Querystring: { until?: string } }>("/timeline", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const until = request.query.until;
    if (until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new HttpError(400, "invalid_request", "`until` must look like 2026-12-02.");
    }

    const context = await loadTimelineContext(app.db.prisma, user.householdId);

    const rows = until
      ? context.timeline.rows.filter((row) => row.effectiveDate === null || row.effectiveDate <= until)
      : context.timeline.rows;

    const decorations = await loadOccurrenceDecorations(
      app.db.prisma,
      rows.map((row) => row.event.id),
      context.chequingImageId,
    );

    return reply.send({
      today: context.today,
      horizonEnd: context.horizonEnd,
      startBalanceCents: context.timeline.startBalanceCents,
      leftThisCycleCents: context.timeline.leftThisCycleCents,
      lowest: context.timeline.lowest,
      safeToSpendNowCents: context.timeline.safeToSpendNowCents,
      coverage: context.timeline.coverage,
      estimatesCount: context.timeline.estimatesCount,
      accounts: context.accounts.map(serialiseAccount),

      rows: rows.map((row) => serialiseTimelineRow(row, decorations.get(row.event.id))),
    });
  });

  /**
   * Pay plan: the two-week windows, each with the rows that fall inside it.
   *
   * The rows are grouped here rather than in the browser so that the engine
   * stays the single authority on which window an item belongs to. Working it
   * out again client-side would be a second implementation of the same rule,
   * and the two would eventually disagree.
   */
  app.get("/pay-periods", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const context = await loadTimelineContext(app.db.prisma, user.householdId);

    const decorations = await loadOccurrenceDecorations(
      app.db.prisma,
      context.timeline.rows.map((row) => row.event.id),
      context.chequingImageId,
    );

    // Names and amounts for the cheques a window counts but that are not on
    // the timeline yet, because they fall past the horizon.
    const scheduleOwners = await app.db.prisma.paySchedule.findMany({
      where: { deletedAt: null, user: { householdId: user.householdId, deletedAt: null } },
      select: { id: true, defaultCents: true, user: { select: { id: true, name: true, initial: true } } },
    });
    const schedulesById = new Map(scheduleOwners.map((schedule) => [schedule.id, schedule]));

    return reply.send({
      today: context.today,
      horizonEnd: context.horizonEnd,
      periods: context.payPeriods.map((period) => {
        // Grouped by the ids the ENGINE counted, not by re-deriving the dates.
        // This was the same rule written twice, and the copies disagreed the
        // moment the engine's was corrected: a bill overdue by a week belongs
        // to the window it will actually come out of, and the date test here
        // put it in no window at all while the totals still felt it.
        const inWindow = new Set(period.rowIds);
        const rows = context.timeline.rows.filter((row) => inWindow.has(row.event.id));

        return {
          label: period.label,
          start: period.start,
          end: period.end,
          isCurrentPartial: period.isCurrentPartial,
          endsAtHorizon: period.endsAtHorizon,
          inCents: period.inCents,
          autoCents: period.autoCents,
          flexibleCents: period.flexibleCents,
          leftCents: period.leftCents,
          // Charges on a card inside this window: counted in none of the
          // figures above, and shown so the window reconciles with its rows.
          elsewhereCents: period.elsewhereCents,
          // "Safe to spend now" asked at a later point on the timeline: what
          // could be moved into savings out of this window without pushing any
          // later balance below the cushion. This is what turns a third cheque
          // from "silently absorbed" into a decision.
          roomToSaveCents: period.roomToSaveCents,
          lowest: period.lowest,
          allAutoCovered: period.allAutoCovered,
          // The one sentence worth saying about this period, built in the
          // engine from the same pass as the figures - and from the
          // household's own cushion, which is not in this payload.
          verdict: period.verdict,

          /*
           * The window split one cheque at a time.
           *
           * This is the figure the spreadsheet is dragged for: a selection
           * from a paycheque down to the row above the next one, and the sum
           * read off the bottom of the screen. A window is a fortnight and
           * holds two cheques, so `leftCents` above answers for both at once
           * and never reproduces it.
           *
           * Sent as the engine grouped them, ids and all, so the screen
           * prints the engine's blocks rather than working out its own from
           * the dates. That rule has been written twice here before, and the
           * copies disagreed the moment one of them was corrected.
           */
          blocks: period.blocks,

          rows: rows.map((row) => serialiseTimelineRow(row, decorations.get(row.event.id))),

          /** Cheques counted in `inCents` that have no occurrence yet. */
          projectedPaycheques: period.projectedPaychequeIds.map((id) => {
            const [scheduleId = "", date = ""] = id.split("|");
            const schedule = schedulesById.get(scheduleId);
            return {
              scheduleId,
              date,
              cents: schedule?.defaultCents ?? 0n,
              owner: schedule?.user ?? null,
            };
          }),
        };
      }),
    });
  });
}
