/**
 * The year view: which months are unusual, and by how much.
 *
 * Everything biweekly lands in a month twice, except when it lands three
 * times. Pay is biweekly and so is the mortgage, so some months carry an extra
 * paycheque and some carry an extra mortgage payment - and because the
 * mortgage comes out the day after a payday, they are not the same months.
 *
 * This endpoint needs no amounts entered and no bills verified, only the
 * schedules, so unlike the timeline it stays honest a year out. That is why it
 * is a separate screen with its own horizon rather than a longer ledger: a
 * fourteen-month ledger would be mostly estimates, and it would bury the tight
 * week coming up in three hundred rows.
 */
import {
  computeChequeCalendar,
  lowestMonth,
  mortgageSeries,
  mortgageSeriesFromPaySchedule,
  pairUnusualMonths,
} from "@headroom/core";
import type { BiweeklySeries } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { toPlainDate, todayInZone } from "../lib/timelineService.js";
import { loadYearAhead } from "../lib/yearAheadService.js";

/** A year plus a little, so the next anniversary of anything is in view. */
const DEFAULT_MONTHS = 14;
const MAX_MONTHS = 36;

const query = z.object({
  months: z.coerce.number().int().min(1).max(MAX_MONTHS).optional(),
});

export async function registerYearRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { months?: string } }>("/year", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = query.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Could not read that request.",
      );
    }
    const monthCount = parsed.data.months ?? DEFAULT_MONTHS;

    const household = await app.db.prisma.household.findUniqueOrThrow({
      where: { id: user.householdId },
      select: { timezone: true },
    });
    const today = todayInZone(household.timezone);

    const [schedules, mortgage] = await Promise.all([
      app.db.prisma.paySchedule.findMany({
        where: { deletedAt: null, user: { householdId: user.householdId, deletedAt: null } },
        select: {
          id: true,
          anchorDate: true,
          defaultCents: true,
          user: { select: { id: true, name: true } },
        },
        orderBy: { anchorDate: "asc" },
      }),
      app.db.prisma.mortgage.findFirst({
        where: { householdId: user.householdId, deletedAt: null },
        select: {
          id: true,
          paymentCents: true,
          offsetDays: true,
          payScheduleId: true,
          anchorDate: true,
          paySchedule: { select: { anchorDate: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const series: BiweeklySeries[] = schedules.map((schedule) => ({
      id: schedule.id,
      // "Alex's pay" rather than "Pay", because the whole point of the screen
      // is noticing WHOSE third cheque it is.
      name: `${schedule.user.name}'s pay`,
      anchorDate: toPlainDate(schedule.anchorDate),
      cents: schedule.defaultCents,
    }));

    if (mortgage) {
      // Its own payment dates when it has them; otherwise the payday it
      // follows plus the offset, which is what makes a third cheque and a
      // third mortgage payment land in different months.
      const mortgageRow =
        mortgage.anchorDate !== null
          ? mortgageSeries({
              id: mortgage.id,
              name: "Mortgage",
              anchorDate: toPlainDate(mortgage.anchorDate),
              paymentCents: mortgage.paymentCents,
            })
          : mortgage.paySchedule !== null
            ? mortgageSeriesFromPaySchedule({
                id: mortgage.id,
                name: "Mortgage",
                payAnchorDate: toPlainDate(mortgage.paySchedule.anchorDate),
                offsetDays: mortgage.offsetDays,
                paymentCents: mortgage.paymentCents,
              })
            : // Anchored neither way. The Savings screen says so plainly; this
              // one simply leaves it out rather than refusing the whole year.
              null;

      if (mortgageRow) series.push(mortgageRow);
    }

    const months = computeChequeCalendar({ from: today, monthCount, series });

    /*
     * The four extras, asked for on 2026-11-20. They are a separate read
     * because they need something the cheque calendar deliberately does not:
     * amounts, and the balance the ledger is showing right now. See
     * `yearAheadService.ts` for where the ledger stops and the projection
     * starts.
     */
    const ahead = await loadYearAhead(app.db.prisma, user.householdId, monthCount, new Date());

    /*
     * Keyed on the first of the month rather than zipped by index. Both lists
     * are built from the same `today` and the same `monthCount`, so they
     * cannot disagree today - but a lookup says so, and an index does not.
     */
    const aheadByStart = new Map(ahead.months.map((month) => [month.start, month]));

    const pairs = pairUnusualMonths(
      months.map((month) => ({
        start: month.start,
        label: month.label,
        netExtraCents: month.netExtraCents,
      })),
    );

    const lowest = lowestMonth(ahead.months);

    return reply.send({
      today,
      monthCount,
      // Said plainly so the client does not have to infer why a month is
      // flagged, or re-derive the arithmetic to label it.
      hasMortgage: mortgage !== null,
      months: months.map((month) => ({
        year: month.year,
        month: month.month,
        label: month.label,
        start: month.start,
        end: month.end,
        isUnusual: month.isUnusual,
        netExtraCents: month.netExtraCents,
        // What actually moves through the month, and where it leaves the
        // balance. Null for a month the projection does not cover, which
        // cannot happen today and would be a silent zero if it ever did.
        inCents: aheadByStart.get(month.start)?.inCents ?? null,
        outCents: aheadByStart.get(month.start)?.outCents ?? null,
        endBalanceCents: aheadByStart.get(month.start)?.endBalanceCents ?? null,
        lumpTotalCents: aheadByStart.get(month.start)?.lumpTotalCents ?? 0n,
        lumps: (aheadByStart.get(month.start)?.lumps ?? []).map((lump) => ({
          name: lump.name,
          date: lump.date,
          cents: lump.cents,
          cadence: lump.cadence,
        })),
        entries: month.entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          cents: entry.cents,
          count: entry.count,
          extraCount: entry.extraCount,
          extraCents: entry.extraCents,
          dates: entry.dates,
        })),
      })),

      /* ---- Where the balance goes ---- */
      hasBalance: ahead.hasBalance,
      startBalanceCents: ahead.startBalanceCents,
      /*
       * Up to here the monthly figures are the ledger's own rows; past it
       * they are worked out from the schedules and assume every bill costs
       * what it costs today. The screen draws the line rather than letting
       * the reader assume the whole year is equally solid.
       */
      ledgerThrough: ahead.ledgerThrough,
      lowestStart: lowest?.start ?? null,

      /* ---- What to put aside for the bills that skip months ---- */
      setAside: {
        monthCount: ahead.setAside.monthCount,
        totalCents: ahead.setAside.totalCents,
        billCount: ahead.setAside.billCount,
        evenCents: ahead.setAside.evenCents,
        levelCents: ahead.setAside.levelCents,
        bindingStart: ahead.setAside.bindingStart,
        bindingLabel: ahead.setAside.bindingLabel,
      },

      /* ---- Which windfall pays for which squeeze ---- */
      pairs: pairs.pairs.map((pair) => ({
        windfallStart: pair.windfallStart,
        windfallLabel: pair.windfallLabel,
        squeezeStart: pair.squeezeStart,
        squeezeLabel: pair.squeezeLabel,
        coveredCents: pair.coveredCents,
        squeezeFirst: pair.squeezeFirst,
      })),
      uncoveredCents: pairs.uncoveredCents,
      spareCents: pairs.spareCents,
    });
  });
}
