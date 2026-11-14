/**
 * Run the suite as if it were another day.
 *
 * Off unless `PIN_DATE` is set, so an ordinary `pnpm test` is unaffected:
 *
 *   PIN_DATE=2026-12-21 pnpm -F @headroom/api test
 *
 * This exists because the suite kept going red on dates nobody had tried. The
 * ledger is built out of "today" - the generation window runs from today, the
 * horizon is the day before the Nth upcoming paycheque, and the pay-period
 * windows start today - so a test with a hardcoded date is really a test of
 * one arrangement of today, and passes or fails by the calendar.
 *
 * Six were found this way, having passed for weeks:
 *
 *  - a monthly bill on a fixed day lands past the horizon for most of any
 *    month, so the row generates and never reaches the timeline;
 *  - a hardcoded pay anchor stops arriving before the bill it is supposed to
 *    cover, once today moves past it;
 *  - two occurrences of a monthly bill only fit inside the window early in
 *    the month;
 *  - counts of rows differ legitimately between two schedules, because which
 *    months fall inside the window depends on today.
 *
 * A test that asserts an ORDER or a GUARANTEE survives any date. One that
 * asserts a COUNT usually does not.
 *
 * **Only pin to today or later.** The database writes its own `now()` for
 * default timestamps, and that clock is not faked, so pinning to a past date
 * makes the two disagree and session expiry in particular misreads. Future
 * dates are consistent because every comparison the app makes is between
 * values it supplied itself.
 */
import { afterAll, beforeAll, vi } from "vitest";

const pinned = process.env["PIN_DATE"];

beforeAll(() => {
  if (pinned === undefined || pinned === "") return;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(pinned)) {
    throw new Error(`PIN_DATE must look like 2026-12-21, not "${pinned}".`);
  }

  vi.useFakeTimers({
    // Only `Date`. Faking timers as well would stop Fastify, Prisma and the
    // connection pool from ever resolving anything.
    toFake: ["Date"],
    // Midday UTC, so the household's own date in America/Regina is the same
    // day rather than the one before.
    now: new Date(`${pinned}T18:00:00.000Z`),
    // The clock still moves, so two requests get two different timestamps.
    shouldAdvanceTime: true,
  });
});

afterAll(() => {
  if (pinned !== undefined && pinned !== "") vi.useRealTimers();
});
