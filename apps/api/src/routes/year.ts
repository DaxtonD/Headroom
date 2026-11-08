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
import { computeChequeCalendar, mortgageSeriesFromPaySchedule } from "@headroom/core";
import type { BiweeklySeries } from "@headroom/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { toPlainDate, todayInZone } from "../lib/timelineService.js";

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
          paySchedule: { select: { anchorDate: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const series: BiweeklySeries[] = schedules.map((schedule) => ({
      id: schedule.id,
      // "Dax's pay" rather than "Pay", because the whole point of the screen is
      // noticing that it is HIS third cheque and not hers.
      name: `${schedule.user.name}'s pay`,
      anchorDate: toPlainDate(schedule.anchorDate),
      cents: schedule.defaultCents,
    }));

    if (mortgage) {
      series.push(
        mortgageSeriesFromPaySchedule({
          id: mortgage.id,
          name: "Mortgage",
          payAnchorDate: toPlainDate(mortgage.paySchedule.anchorDate),
          offsetDays: mortgage.offsetDays,
          paymentCents: mortgage.paymentCents,
        }),
      );
    }

    const months = computeChequeCalendar({ from: today, monthCount, series });

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
    });
  });
}
