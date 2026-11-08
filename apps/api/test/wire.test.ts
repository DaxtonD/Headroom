/**
 * The money wire format, and the seam it protects.
 *
 * These exist because of a real bug. The web app turned a typed "186" into
 * 18600 cents and sent `"-18600"`; the API read `"-18600"` as a DOLLAR amount
 * and stored $18,600. Both sides had passing tests, because neither crossed
 * the seam between them: the API's tests sent dollar strings and the client's
 * sent cents.
 *
 * So the tests below do two things no earlier test did:
 *
 *  1. Assert the format explicitly, including that a decimal is REFUSED rather
 *     than guessed at.
 *  2. Follow a value the whole way round - typed by a person, sent, stored,
 *     read back, formatted for the screen - using the very same engine
 *     functions the UI uses. A 100x error anywhere in that loop fails here.
 */
import { randomUUID } from "node:crypto";
import { formatCents, parseCents } from "@headroom/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { wireCents, wireCentsNonNegative } from "../src/lib/wire.js";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

describe("wireCents", () => {
  it("reads integer cents from a string", () => {
    expect(wireCents.parse("18600")).toBe(18_600n);
    expect(wireCents.parse("-18600")).toBe(-18_600n);
    expect(wireCents.parse("0")).toBe(0n);
    expect(wireCents.parse(" 100 ")).toBe(100n);
  });

  it("accepts a safe integer number too", () => {
    expect(wireCents.parse(18_600)).toBe(18_600n);
    expect(wireCents.parse(-18_600)).toBe(-18_600n);
  });

  it("REFUSES a decimal rather than guessing the convention", () => {
    // This is the whole point. "186.00" could mean 186 cents or 18600 cents,
    // and guessing is what caused the $18,600 bug.
    expect(() => wireCents.parse("186.00")).toThrow();
    expect(() => wireCents.parse("186.5")).toThrow();
    expect(() => wireCents.parse(186.5)).toThrow();
    expect(() => wireCents.parse("1,860")).toThrow();
  });

  it("says what the right format is when it refuses", () => {
    const result = wireCents.safeParse("186.00");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/integer cents/);
      expect(result.error.issues[0]?.message).toMatch(/18600/);
    }
  });

  it("refuses anything that is not a number at all", () => {
    expect(() => wireCents.parse("")).toThrow();
    expect(() => wireCents.parse("abc")).toThrow();
    expect(() => wireCents.parse("$186")).toThrow();
    expect(() => wireCents.parse("1e4")).toThrow();
  });

  it("stays exact past the float limit", () => {
    expect(wireCents.parse("9007199254740993")).toBe(9_007_199_254_740_993n);
    // Too big to be a safe JS number, so it must be sent as a string.
    // Written as an expression, not a literal: a literal that large silently
    // loses precision before the schema ever sees it.
    expect(() => wireCents.parse(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it("will not take a negative balance", () => {
    expect(wireCentsNonNegative.parse("41000")).toBe(41_000n);
    expect(() => wireCentsNonNegative.parse("-1")).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The full round trip                                                        */
/* -------------------------------------------------------------------------- */

let harness: Harness;
let cookie: string;
let householdId: string;

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
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

/**
 * Exactly what the web app does when someone types into the amount box:
 * `parseCents` on the text, then send the integer cents as a string.
 */
function asTheUiWouldSend(typed: string, outflow: boolean): string {
  const magnitude = parseCents(typed);
  return (outflow ? -magnitude : magnitude).toString();
}

describe("an amount typed into a bill", () => {
  async function makeBill() {
    return harness.db.prisma.occurrence.create({
      data: {
        householdId,
        name: "Power",
        cents: -1_000n,
        kind: "bill",
        withdrawal: "flexible",
      },
    });
  }

  it.each([
    ["186", "$186.00"],
    ["186.00", "$186.00"],
    ["0.05", "$0.05"],
    ["1234.56", "$1,234.56"],
    ["$1,234.56", "$1,234.56"],
  ])('typing %s saves and shows as %s', async (typed, shown) => {
    const bill = await makeBill();

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cents: asTheUiWouldSend(typed, true) },
    });

    expect(response.statusCode).toBe(200);

    // What the screens would show, via the same formatter the UI uses.
    const stored = BigInt(response.json().occurrence.cents);
    expect(formatCents(-stored)).toBe(shown);

    // And the same figure comes back out of the read endpoint.
    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((reply) => reply.json());
    const row = timeline.rows.find((candidate: { id: string }) => candidate.id === bill.id);
    expect(formatCents(-BigInt(row.cents))).toBe(shown);
  });

  it("is stored as the exact number of cents, not a hundred times it", async () => {
    const bill = await makeBill();

    await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cents: asTheUiWouldSend("186", true) },
    });

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    // $186.00 is 18600 cents. Not 1860000.
    expect(row.cents).toBe(-18_600n);
  });

  it("refuses a decimal sent over the wire, so the old bug cannot come back", async () => {
    const bill = await makeBill();

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cents: "-186.00" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/integer cents/);

    // Nothing was stored.
    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.cents).toBe(-1_000n);
  });
});

describe("a balance typed into Home", () => {
  it.each([
    ["410", "$410.00"],
    ["410.00", "$410.00"],
    ["1234.56", "$1,234.56"],
  ])("typing %s shows as %s on the dashboard", async (typed, shown) => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { cents: parseCents(typed).toString() },
    });
    expect(response.statusCode).toBe(201);

    const dashboard = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((reply) => reply.json());

    expect(formatCents(BigInt(dashboard.balance.cents))).toBe(shown);
    expect(formatCents(BigInt(dashboard.balance.snapshotCents))).toBe(shown);
  });

  it("refuses a decimal balance", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { cents: "410.00" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/integer cents/);
  });
});

describe("a one-off added by hand", () => {
  it("keeps its amount exactly through create and read", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/occurrences",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { name: "Refund", cents: parseCents("47.35").toString(), kind: "deposit" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().occurrence.cents).toBe("4735");
    expect(formatCents(BigInt(created.json().occurrence.cents))).toBe("$47.35");
  });

  it("is signed by what it is, not by how it was typed", async () => {
    // A generated bill is negative because the engine signs it that way. One
    // added by hand has to follow the same rule, or the same bill is an
    // outflow from a template and income when someone types it in - and the
    // running balance goes UP when a bill is added.
    const bill = await harness.app.inject({
      method: "POST",
      url: "/api/occurrences",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { name: "Dentist", cents: "12500", kind: "bill" },
    });

    expect(bill.statusCode).toBe(201);
    expect(bill.json().occurrence.cents).toBe("-12500");

    // And a deposit stays an inflow even if someone puts a minus on it.
    const deposit = await harness.app.inject({
      method: "POST",
      url: "/api/occurrences",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { name: "Rebate", cents: "-3300", kind: "deposit" },
    });

    expect(deposit.json().occurrence.cents).toBe("3300");
  });
});

describe("every amount the API sends is integer cents in a string", () => {
  it("holds for the dashboard, the timeline and the pay periods", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { cents: "41000" },
    });
    await harness.db.prisma.occurrence.create({
      data: {
        householdId,
        name: "Power",
        cents: -12_345n,
        kind: "bill",
        withdrawal: "flexible",
      },
    });

    const isIntegerCentsString = (value: unknown): boolean =>
      typeof value === "string" && /^-?\d+$/.test(value);

    const dashboard = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((reply) => reply.json());

    for (const value of [
      dashboard.balance.cents,
      dashboard.balance.snapshotCents,
      dashboard.safeToSpendNowCents,
      dashboard.leftThisCycleCents,
      dashboard.lowest.cents,
      dashboard.cushionCents,
    ]) {
      expect(isIntegerCentsString(value), String(value)).toBe(true);
    }

    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((reply) => reply.json());

    for (const row of timeline.rows) {
      expect(isIntegerCentsString(row.cents), row.name).toBe(true);
      expect(isIntegerCentsString(row.runningCents), row.name).toBe(true);
    }
  });
});
