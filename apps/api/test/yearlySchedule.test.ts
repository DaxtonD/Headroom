/**
 * An expense that comes out once a year, end to end against real Postgres.
 *
 * ## What the household asked for
 *
 * On 2026-11-19, after the account-routing work shipped: "when I mentioned
 * annual expenses / subscriptions I thought you'd add an option on the expense
 * form to select every year on a date."
 *
 * The budget half of this was already built and had been from the start -
 * `Cadence` in `monthlyEquivalent.ts` has had `yearly` all along, and the
 * Budget page has always known that an amount charged once a year is a twelfth
 * of itself each month. What was missing was any schedule that could produce
 * it: the five schedule types were monthly, last-of-month, after-a-payday,
 * fortnightly and flexible, so an annual policy had to be entered as a monthly
 * twelfth, which loses the date the money actually leaves.
 *
 * So these tests prove the two halves meet: the schedule puts the whole amount
 * on the ledger on its real date, and the budget counts a twelfth of it per
 * month. Getting either one wrong is a quiet, plausible wrong answer rather
 * than a crash, which is why they are down here against the database and not
 * source checks upstairs.
 *
 * Dates are built from today. Every figure in Headroom is, and a hardcoded
 * date tests one arrangement of today and then goes red by the calendar.
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
 * Paydays, because the horizon is counted in them.
 *
 * Without a pay schedule the horizon falls back to a fortnight, which would
 * still cover a date three days out - but the fallback is not what the
 * household runs on, and a test that only passes under the fallback proves
 * less than one that passes under the real thing.
 */
async function seedSchedules() {
  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  await harness.db.prisma.paySchedule.create({
    data: { userId: jordanId, anchorDate: anchor, defaultCents: 175_000n },
  });
  const second = new Date(anchor);
  second.setUTCDate(second.getUTCDate() + 7);
  await harness.db.prisma.paySchedule.create({
    data: { userId: alexId, anchorDate: second, defaultCents: 180_000n },
  });
}

/**
 * A month and day a few days from now, with the year it belongs to.
 *
 * Three days out is inside the horizon whatever today is, which a fixed date
 * is not: "the 3rd of March" is eleven months away for most of the year, so
 * the row would generate correctly and never reach the timeline this asserts
 * on.
 */
function soon(days = 3): { month: number; day: number; date: string; year: number } {
  const date = inDays(days);
  const [year, month, day] = date.split("-");
  return {
    month: Number(month),
    day: Number(day),
    date,
    year: Number(year),
  };
}

async function timelineRows(): Promise<{ name: string; date: string | null }[]> {
  const body = await get("/api/timeline").then((response) => response.json());
  return body.rows as { name: string; date: string | null }[];
}

describe("an expense that recurs every year", () => {
  it("puts the whole amount on the ledger, on the date it names", async () => {
    await seedSchedules();
    const when = soon();

    const created = await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);

    const row = (await timelineRows()).find((entry) => entry.name === "House insurance");
    expect(row, "a yearly expense should reach the ledger").toBeDefined();
    expect(row?.date).toBe(when.date);
  });

  /**
   * The point of entering it as a yearly amount.
   *
   * $1,200.00 once a year is $100.00 a month in the budget. Counting the whole
   * $1,200.00 as a monthly line would overstate the month twelvefold and make
   * "left over" useless; counting nothing at all would hide a real cost.
   */
  it("counts a twelfth of itself in the monthly budget", async () => {
    const created = await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      // No horizon worry here: the budget reads templates, not occurrences.
      schedule: { type: "yearly", month: 3, day: 3 },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);

    const budget = await get("/api/budget").then((response) => response.json());
    const line = budget.fixed.lines.find(
      (entry: { name: string }) => entry.name === "House insurance",
    );

    expect(line, "a yearly expense should appear in the budget").toBeDefined();
    expect(line.monthlyCents).toBe("10000");
    expect(line.yearlyCents).toBe("120000");
  });

  it("is keyed by the year, so generating twice leaves one row", async () => {
    await seedSchedules();
    const when = soon();

    const created = await post("/api/templates", {
      name: "Domain renewal",
      kind: "bill",
      defaultCents: "2400",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);
    // `{ template: ... }`, not the row at the top level. Worth asserting
    // rather than trusting: a Prisma `where` whose value is undefined matches
    // EVERY row, so reading the wrong field here made this count the whole
    // household's occurrences and look like a duplication bug.
    const templateId = created.json().template.id as string;
    expect(templateId).toBeTypeOf("string");

    // Creating already generated once; these are the second and third runs.
    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);
    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);

    const rows = await harness.db.prisma.occurrence.findMany({
      where: { templateId },
      select: { periodKey: true },
    });

    expect(rows).toHaveLength(1);
    // The year alone. A monthly row would be keyed "2026-11"; keying a yearly
    // one the same way would produce a second row for any year the date was
    // moved within.
    expect(rows[0]?.periodKey).toBe(String(when.year));
  });

  it("refuses a month that is not a month", async () => {
    const created = await post("/api/templates", {
      name: "Nonsense",
      kind: "bill",
      defaultCents: "1000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: 13, day: 1 },
      section: "fixed",
    });

    expect(created.statusCode).toBe(400);
  });

  /**
   * Accepted, not refused, and then clamped by the engine.
   *
   * Somebody whose policy renews on the 29th of February should be able to
   * say so. The engine puts it on the 28th in the three years out of four
   * that have no 29th, which is what it already does for a monthly bill on
   * the 31st.
   */
  it("accepts the 29th of February", async () => {
    const created = await post("/api/templates", {
      name: "Leap policy",
      kind: "bill",
      defaultCents: "50000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: 2, day: 29 },
      section: "fixed",
    });

    expect(created.statusCode).toBe(201);
  });

  /**
   * The existing rule, now covering the new type.
   *
   * "Flexible" means undated and hanging off a paycheque, which is how a
   * household moves something when money is tight. A yearly schedule names a
   * date, so the two cannot both be true - and nothing had to be added for
   * this to hold, which is the reason to assert it.
   */
  it("cannot be a flexible withdrawal, because it names a date", async () => {
    const created = await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "flexible",
      schedule: { type: "yearly", month: 3, day: 3 },
      section: "fixed",
    });

    expect(created.statusCode).toBe(400);
    expect(created.json().message).toMatch(/cannot be flexible/);
  });

  /**
   * Changing a monthly expense to a yearly one.
   *
   * The form offers both, so this is a real edit somebody will make - and the
   * budget figure has to follow it. A monthly $100.00 and a yearly $100.00 are
   * the same template with one field changed and a twelvefold difference in
   * what it costs a month.
   */
  it("follows an edit from monthly to yearly", async () => {
    const created = await post("/api/templates", {
      name: "Subscription",
      kind: "bill",
      defaultCents: "10000",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 3 },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);
    const { id, version } = created.json().template as { id: string; version: number };

    const before = await get("/api/budget").then((response) => response.json());
    expect(
      before.fixed.lines.find((entry: { name: string }) => entry.name === "Subscription")
        .monthlyCents,
    ).toBe("10000");

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${id}`,
      headers: { ...headers(), "if-match": `"${version}"` },
      payload: { schedule: { type: "yearly", month: 3, day: 3 } },
    });
    expect(patched.statusCode).toBe(200);

    const after = await get("/api/budget").then((response) => response.json());
    // $100.00 a year is $8.33 a month, half a cent rounded up.
    expect(
      after.fixed.lines.find((entry: { name: string }) => entry.name === "Subscription")
        .monthlyCents,
    ).toBe("833");
  });
});
