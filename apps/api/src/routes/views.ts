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
  type OccurrenceDecoration,
} from "../lib/timelineService.js";
import type { TimelineRow } from "@headroom/core";

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
    owner: decoration?.owner ?? null,
    requiresCoverage: row.requiresCoverage,
    runningCents: row.runningCents,
    version: decoration?.version ?? 1,
    fromTemplate: decoration?.templateId !== null,
  };
}

/** How many upcoming automatic withdrawals Home lists. */
const HOME_AUTO_COUNT = 4;

export async function registerViewRoutes(app: FastifyInstance): Promise<void> {
  /** Home: the one screen Carol opens several times a day. */
  app.get("/dashboard", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const context = await loadTimelineContext(app.db.prisma, user.householdId);
    const { timeline } = context;

    const autoRows = timeline.rows.filter((row) => row.requiresCoverage);
    const nextAutoIds = autoRows.slice(0, HOME_AUTO_COUNT).map((row) => row.event.id);
    const decorations = await loadOccurrenceDecorations(app.db.prisma, nextAutoIds);

    return reply.send({
      today: context.today,
      horizonEnd: context.horizonEnd,
      cushionCents: context.cushionCents,

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
          inCents: period.inCents,
          autoCents: period.autoCents,
          flexibleCents: period.flexibleCents,
          leftCents: period.leftCents,
          // "Safe to spend now" asked at a later point on the timeline: what
          // could be moved into savings out of this window without pushing any
          // later balance below the cushion. This is what turns a third cheque
          // from "silently absorbed" into a decision.
          roomToSaveCents: period.roomToSaveCents,
          lowest: period.lowest,
          allAutoCovered: period.allAutoCovered,

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
