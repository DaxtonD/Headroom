/**
 * The year view over HTTP, against a real Postgres.
 *
 * The interesting arithmetic - which months hold three of something, and the
 * windfall-beside-a-squeeze that the mortgage's one-day offset causes - is
 * tested deterministically in the engine with synthetic anchors. It cannot be
 * tested here, because this endpoint starts from the real clock and the pattern
 * depends on what today is.
 *
 * So these check what only the API can get wrong: that the right rows reach the
 * engine, that the mortgage is turned into a series anchored off the payday it
 * follows rather than off its own date, that a household with no mortgage still
 * works, and that the figures stay integer cents on the wire.
 *
 * Amounts and dates are invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let daxId: string;
let carolId: string;

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
  householdId = seeded.household.id;
  daxId = seeded.dax.id;
  carolId = seeded.carol.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

/** Two people paid every fortnight, a week apart. */
async function seedPay() {
  const dax = await harness.db.prisma.paySchedule.create({
    data: { userId: daxId, anchorDate: new Date("2026-01-08T00:00:00Z"), defaultCents: 200_000n },
  });
  const carol = await harness.db.prisma.paySchedule.create({
    data: { userId: carolId, anchorDate: new Date("2026-01-15T00:00:00Z"), defaultCents: 180_000n },
  });
  return { dax, carol };
}

async function seedMortgage(payScheduleId: string, offsetDays = 1) {
  return harness.db.prisma.mortgage.create({
    data: {
      householdId,
      balanceCents: 2_000_000n,
      asOf: new Date("2026-01-08T00:00:00Z"),
      rateBasisPoints: 525,
      paymentCents: 100_000n,
      payScheduleId,
      offsetDays,
      prepaymentCapCents: 5_000_000n,
    },
  });
}

function get(url = "/api/year") {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

interface Entry {
  id: string;
  name: string;
  cents: string;
  count: number;
  extraCount: number;
  extraCents: string;
  dates: string[];
}
interface Month {
  year: number;
  month: number;
  label: string;
  start: string;
  end: string;
  isUnusual: boolean;
  netExtraCents: string;
  entries: Entry[];
}

describe("GET /api/year", () => {
  it("returns fourteen consecutive months starting with today's", async () => {
    await seedPay();
    const body = await get().then((response) => response.json());

    expect(body.monthCount).toBe(14);
    expect(body.months).toHaveLength(14);

    // Starts in the month that contains today, whatever today happens to be.
    const [first] = body.months as Month[];
    expect(first!.start).toBe(`${body.today.slice(0, 7)}-01`);

    // And every later month follows the one before it, rolling the year over.
    const months = body.months as Month[];
    for (let index = 1; index < months.length; index += 1) {
      const previous = months[index - 1]!;
      const current = months[index]!;
      const expected =
        previous.month === 12
          ? { year: previous.year + 1, month: 1 }
          : { year: previous.year, month: previous.month + 1 };
      expect({ year: current.year, month: current.month }).toEqual(expected);
    }
  });

  it("names each series after its owner, so a third cheque says whose it is", async () => {
    await seedPay();
    const body = await get().then((response) => response.json());

    const names = (body.months[0] as Month).entries.map((entry) => entry.name);
    expect(names).toContain("Dax's pay");
    expect(names).toContain("Carol's pay");
  });

  it("lands two or three times a month, never any other count", async () => {
    await seedPay();
    const body = await get().then((response) => response.json());

    for (const month of body.months as Month[]) {
      for (const entry of month.entries) {
        expect([2, 3]).toContain(entry.count);
        expect(entry.dates).toHaveLength(entry.count);
        // Every date really is inside the month it was counted in.
        for (const date of entry.dates) {
          expect(date >= month.start && date <= month.end).toBe(true);
        }
      }
    }
  });

  it("flags a month if and only if something lands three times", async () => {
    await seedPay();
    const body = await get().then((response) => response.json());

    for (const month of body.months as Month[]) {
      const odd = month.entries.some((entry) => entry.count !== 2);
      expect(month.isUnusual).toBe(odd);
    }
  });

  it("finds at least one unusual month, because fourteen months must contain one", async () => {
    // Twenty-six payments a year over fourteen months is about thirty, against
    // twenty-eight "usual" slots, so some month has to hold a third.
    await seedPay();
    const body = await get().then((response) => response.json());

    expect((body.months as Month[]).filter((month) => month.isUnusual).length).toBeGreaterThan(0);
  });

  it("nets the extras against each other, in integer cents on the wire", async () => {
    const { dax } = await seedPay();
    await seedMortgage(dax.id);
    const body = await get().then((response) => response.json());

    expect(body.hasMortgage).toBe(true);

    for (const month of body.months as Month[]) {
      const sum = month.entries.reduce((total, entry) => total + BigInt(entry.extraCents), 0n);
      expect(BigInt(month.netExtraCents)).toBe(sum);

      for (const entry of month.entries) {
        // Strings, not numbers, and never a decimal point.
        expect(entry.cents).toMatch(/^-?\d+$/);
        expect(entry.extraCents).toMatch(/^-?\d+$/);
        expect(BigInt(entry.extraCents)).toBe(BigInt(entry.extraCount) * BigInt(entry.cents));
      }
    }
  });

  it("treats the mortgage as money leaving, anchored off the payday it follows", async () => {
    const { dax } = await seedPay();
    const mortgage = await seedMortgage(dax.id, 1);
    const body = await get().then((response) => response.json());

    const allMonths = body.months as Month[];
    const payDates = new Set(
      allMonths.flatMap((month) => month.entries.find((e) => e.id === dax.id)?.dates ?? []),
    );
    const mortgageDates = allMonths.flatMap(
      (month) => month.entries.find((e) => e.id === mortgage.id)?.dates ?? [],
    );

    expect(mortgageDates.length).toBeGreaterThan(0);

    // Every payment is exactly one day after one of Dax's paydays. This offset
    // is the whole reason a month can hold three cheques but two payments.
    for (const date of mortgageDates) {
      const dayBefore = new Date(`${date}T00:00:00Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      expect(payDates.has(dayBefore.toISOString().slice(0, 10))).toBe(true);
    }

    // And it is negative, because it is money going out.
    const entry = allMonths[0]!.entries.find((e) => e.id === mortgage.id);
    expect(BigInt(entry!.cents)).toBe(-100_000n);
  });

  it("moves with the offset, so a zero offset keeps the two in lockstep", async () => {
    const { dax } = await seedPay();
    const mortgage = await seedMortgage(dax.id, 0);
    const body = await get().then((response) => response.json());

    for (const month of body.months as Month[]) {
      const pay = month.entries.find((e) => e.id === dax.id);
      const mort = month.entries.find((e) => e.id === mortgage.id);
      expect(mort!.count).toBe(pay!.count);
      expect(mort!.dates).toEqual(pay!.dates);
    }
  });

  it("works for a household with no mortgage at all", async () => {
    await seedPay();
    const body = await get().then((response) => response.json());

    expect(body.hasMortgage).toBe(false);
    for (const month of body.months as Month[]) {
      expect(month.entries).toHaveLength(2);
    }
  });

  it("copes with a household that has no pay schedules yet", async () => {
    // The state a brand new household is in, before anyone has been set up.
    const response = await get();

    expect(response.statusCode).toBe(200);
    expect(response.json().months).toHaveLength(14);
    expect(response.json().months[0].entries).toEqual([]);
    expect(response.json().months[0].isUnusual).toBe(false);
  });

  it("takes a shorter or longer horizon", async () => {
    await seedPay();

    expect((await get("/api/year?months=3").then((r) => r.json())).months).toHaveLength(3);
    expect((await get("/api/year?months=24").then((r) => r.json())).months).toHaveLength(24);
  });

  it("refuses a horizon that is not a sensible number of months", async () => {
    await seedPay();

    expect((await get("/api/year?months=0")).statusCode).toBe(400);
    expect((await get("/api/year?months=999")).statusCode).toBe(400);
    expect((await get("/api/year?months=notanumber")).statusCode).toBe(400);
  });

  it("needs a signed-in user", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/year",
      headers: { "idempotency-key": randomUUID() },
    });

    expect(response.statusCode).toBe(401);
  });
});
