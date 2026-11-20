/**
 * The ledger must not draw a pay period it cannot fill.
 *
 * ## What the household reported
 *
 * On 2026-11-19, straight after the yearly schedule shipped: a subscription
 * renewing on the 18th of December, a pay period on screen reading 10-23
 * December, and no row for it anywhere.
 *
 * ## It was never about the yearly schedule
 *
 * The occurrence generated correctly, on the right date, with the right
 * period key. A **monthly** expense on the 18th was dropped identically. The
 * fault is that two different definitions of "how far ahead" meet on the
 * ledger and disagree:
 *
 *  - The pay-period windows are whole fortnights, anchored on one person's
 *    paydays (HANDOFF section 5 rule 1).
 *  - The horizon is "the day before the Nth upcoming paycheque, counting
 *    every person's" (section 6.3). With two earners paid on alternating
 *    weeks that is a cheque most weeks, so four paycheques is about four
 *    weeks - and it lands in the MIDDLE of a fortnight.
 *
 * Rows are fetched to the horizon. So the last window claimed thirteen days
 * it could not populate, and that was not only a wrong label: window
 * membership and the projected paydays are both decided by the window's end,
 * so it counted up to a week of pay whose bills it was structurally unable to
 * show. Income through the 23rd against bills through the 16th, and a
 * left-over figure inflated from both directions.
 *
 * The window is now reported as far as the ledger actually reaches. No
 * derived figure anywhere else moved - the golden tests confirm it - because
 * the rows beyond the horizon were never fetched in the first place.
 *
 * Dates are built from today, because every figure in Headroom is.
 *
 * Every amount is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  inDays,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let alexId: string;
let jordanId: string;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  const seeded = await seedHousehold(harness);
  alexId = seeded.alex.id;
  jordanId = seeded.jordan.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

function headers() {
  return { cookie, "idempotency-key": randomUUID() };
}

function post(url: string, payload: unknown) {
  return harness.app.inject({ method: "POST", url, headers: headers(), payload });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

/**
 * Two earners, paid on alternating weeks.
 *
 * This is the arrangement that produces the fault: a cheque every seven days
 * between them, so a four-cheque horizon is four weeks and does not line up
 * with the anchor person's fortnights.
 */
async function seedAlternatingPaydays() {
  await harness.db.prisma.paySchedule.create({
    data: {
      userId: jordanId,
      anchorDate: new Date(`${inDays(-7)}T00:00:00Z`),
      defaultCents: 200_000n,
    },
  });
  await harness.db.prisma.paySchedule.create({
    data: {
      userId: alexId,
      anchorDate: new Date(`${inDays(0)}T00:00:00Z`),
      defaultCents: 180_000n,
    },
  });
}

/** A yearly expense 29 days out, which is what 18 December is from 19 November. */
async function addYearlyExpense(name: string, daysOut = 29) {
  const target = inDays(daysOut);
  const [, month, day] = target.split("-");

  const created = await post("/api/templates", {
    name,
    kind: "bill",
    defaultCents: "9900",
    withdrawal: "auto",
    schedule: { type: "yearly", month: Number(month), day: Number(day) },
    section: "fixed",
  });
  expect(created.statusCode).toBe(201);
  return { templateId: created.json().template.id as string, date: target };
}

async function setHorizon(paycheques: number) {
  const setup = await get("/api/setup").then((response) => response.json());
  const response = await harness.app.inject({
    method: "PATCH",
    url: "/api/settings/household",
    headers: { ...headers(), "if-match": `"${setup.household.version}"` },
    payload: { horizonPaychequeCount: paycheques },
  });
  expect(response.statusCode, response.body).toBe(200);
}

interface Period {
  readonly start: string;
  readonly end: string;
  readonly endsAtHorizon: boolean;
  readonly isCurrentPartial: boolean;
}

async function ledger(): Promise<{
  horizonEnd: string;
  periods: Period[];
  names: string[];
}> {
  const body = await get("/api/pay-periods").then((response) => response.json());
  const periods = body.periods as (Period & { rows: { name: string }[] })[];
  return {
    horizonEnd: body.horizonEnd as string,
    periods,
    // Rows hang off the window that counted them, not off the response, which
    // is the whole reason a window has to cover every row there is.
    names: periods.flatMap((period) => period.rows.map((row) => row.name)),
  };
}

describe("a pay period the horizon cuts short", () => {
  /**
   * The invariant, and the one worth keeping forever: no window may claim a
   * day whose rows the ledger did not fetch. Stated against the horizon
   * rather than against a date, so it holds whatever today is.
   */
  it("never reports a window ending after the horizon", async () => {
    await seedAlternatingPaydays();
    await addYearlyExpense("Yearly sub");

    const { horizonEnd, periods } = await ledger();

    expect(periods.length).toBeGreaterThan(0);
    for (const period of periods) {
      expect(
        period.end <= horizonEnd,
        `period ${period.start}..${period.end} runs past the horizon ${horizonEnd}`,
      ).toBe(true);
    }
  });

  it("marks the window the horizon cut, and only that one", async () => {
    await seedAlternatingPaydays();
    await addYearlyExpense("Yearly sub");

    const { horizonEnd, periods } = await ledger();
    const cut = periods.filter((period) => period.endsAtHorizon);

    // At most the last one, and when there is one it ends exactly there.
    expect(cut.length).toBeLessThanOrEqual(1);
    if (cut[0]) {
      expect(cut[0]).toBe(periods[periods.length - 1]);
      expect(cut[0].end).toBe(horizonEnd);
    }
  });

  /**
   * The remedy, which is a setting the household already has.
   *
   * An odd paycheque count lands on the anchor person's own payday, so the
   * horizon and the fortnight agree exactly: five cheques instead of four
   * both reveals the expense and leaves no window cut short. This is the
   * answer given to the household, so it is the answer that gets a test.
   */
  it("reaches the expense once the horizon is raised, with nothing cut short", async () => {
    await seedAlternatingPaydays();
    const { date } = await addYearlyExpense("Yearly sub");

    const before = await ledger();
    expect(before.names).not.toContain("Yearly sub");
    expect(before.horizonEnd < date).toBe(true);

    await setHorizon(5);

    const after = await ledger();
    expect(after.names).toContain("Yearly sub");
    expect(after.horizonEnd >= date).toBe(true);
    expect(after.periods.some((period) => period.endsAtHorizon)).toBe(false);
  });

  /**
   * Proof this was never about the schedule type, kept so nobody has to work
   * it out again from the shape of the bug.
   */
  it("drops a monthly expense on the same day in exactly the same way", async () => {
    await seedAlternatingPaydays();
    const target = inDays(29);
    const [, , day] = target.split("-");

    const created = await post("/api/templates", {
      name: "Monthly sub",
      kind: "bill",
      defaultCents: "9900",
      withdrawal: "auto",
      schedule: { type: "monthly", day: Number(day) },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);
    const templateId = created.json().template.id as string;

    // Generated, with the right date - it is the ledger that does not reach it.
    const rows = await harness.db.prisma.occurrence.findMany({
      where: { templateId },
      select: { date: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date.toISOString().slice(0, 10)).toBe(target);

    expect((await ledger()).names).not.toContain("Monthly sub");
  });
});
