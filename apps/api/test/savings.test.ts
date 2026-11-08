/**
 * Savings, earmarks and the mortgage payoff over HTTP, against a real Postgres.
 *
 * The amortization itself has deterministic tests in the engine, computed
 * independently of the implementation. The synthetic mortgage here is the same
 * one - $20,000.00 at 5.00% with a $500.00 payment every fourteen days from
 * 2026-01-02, paying off on 2027-08-13 after 42 payments and $831.21 of
 * interest - so these tests check the seam rather than the sums:
 *
 *  - the payment anchor is the PAYDAY PLUS THE OFFSET, not the payday, which is
 *    the one piece of arithmetic this layer does and the one that decides
 *    whether the third-payment months land in the right place;
 *  - lump sums already inside the stored balance are not applied twice;
 *  - what is planned but unpaid is kept apart from what is paid;
 *  - the balance and the earmarks are reconciled rather than clamped.
 *
 * Every amount and date is invented. The household's real figures live in the
 * git-ignored seed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let daxId: string;

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
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

const headers = () => ({ cookie, "idempotency-key": randomUUID() });
const match = (version: number) => ({ ...headers(), "if-match": `"${String(version)}"` });

/** The payday the mortgage follows. Plus one day, that is 2026-01-02. */
const PAY_ANCHOR = "2026-01-01";

async function seedPaySchedule() {
  return harness.db.prisma.paySchedule.create({
    data: {
      userId: daxId,
      anchorDate: new Date(`${PAY_ANCHOR}T00:00:00Z`),
      defaultCents: 200_000n,
    },
  });
}

/** The engine's synthetic mortgage, reached through the API. */
async function createMortgage(overrides: Record<string, unknown> = {}) {
  const schedule = await seedPaySchedule();

  const response = await harness.app.inject({
    method: "POST",
    url: "/api/mortgage",
    headers: headers(),
    payload: {
      balanceCents: "2000000",
      asOf: "2026-01-02",
      rateBasisPoints: 500,
      paymentCents: "50000",
      payScheduleId: schedule.id,
      offsetDays: 1,
      prepaymentCapCents: "1000000",
      ...overrides,
    },
  });

  return { schedule, response, body: response.json() };
}

async function savingsAccount(name = "Savings") {
  return harness.db.prisma.account.create({
    data: { householdId, name, kind: "savings" },
  });
}

function get(url = "/api/savings") {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

/* -------------------------------------------------------------------------- */
/* The balance and the earmarks                                              */
/* -------------------------------------------------------------------------- */

describe("GET /api/savings: the account", () => {
  it("has no savings account to begin with, and says so rather than showing zero", async () => {
    const body = await get().then((response) => response.json());

    expect(body.hasSavingsAccount).toBe(false);
    expect(body.accounts).toEqual([]);
    // Nothing saved and nothing earmarked is a consistent, honest state.
    expect(body.balanceCents).toBe("0");
    expect(body.unallocatedCents).toBe("0");
    expect(body.mortgage).toBeNull();
  });

  it("distinguishes an account with no balance yet from one holding nothing", async () => {
    await savingsAccount();
    const body = await get().then((response) => response.json());

    expect(body.hasSavingsAccount).toBe(true);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].cents).toBeNull();
    expect(body.accounts[0].asOf).toBeNull();
  });

  it("reads the balance typed in through the ordinary balance endpoint", async () => {
    const account = await savingsAccount();

    const posted = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "438215" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().snapshot.accountId).toBe(account.id);

    const body = await get().then((response) => response.json());
    expect(body.balanceCents).toBe("438215");
    expect(body.accounts[0].cents).toBe("438215");
    expect(body.accounts[0].enteredBy.name).toBe("Carol");
  });

  it("keeps the savings balance out of the money available to spend", async () => {
    // The whole reason Account.kind exists. Before it, "the chequing account"
    // meant "the first account row", so a savings balance could have been read
    // as what was safe to spend.
    const account = await savingsAccount();
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { cents: "120000" },
    });
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "900000" },
    });

    const home = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    expect(home.balance.cents).toBe("120000");
    expect((await get().then((response) => response.json())).balanceCents).toBe("900000");
  });

  it("refuses to clear bills against an account bills do not come out of", async () => {
    const account = await savingsAccount();

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "100000", clearedOccurrenceIds: [randomUUID()] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("adds up several savings accounts without hiding either of them", async () => {
    const first = await savingsAccount("Savings");
    const second = await savingsAccount("Second savings");

    for (const [account, cents] of [
      [first, "300000"],
      [second, "125050"],
    ] as const) {
      await harness.app.inject({
        method: "POST",
        url: "/api/balance",
        headers: headers(),
        payload: { accountId: account.id, cents },
      });
    }

    const body = await get().then((response) => response.json());
    expect(body.balanceCents).toBe("425050");
    expect(body.accounts.map((account: { cents: string }) => account.cents)).toEqual([
      "300000",
      "125050",
    ]);
  });
});

describe("GET /api/savings: earmarks", () => {
  async function earmark(payload: Record<string, unknown>) {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json().goal;
  }

  it("reports what is left over once everything is earmarked", async () => {
    const account = await savingsAccount();
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "500000" },
    });

    await earmark({ name: "Trip", savedCents: "300000", sortIndex: 0 });
    await earmark({ name: "Lump sum", savedCents: "150000", purpose: "mortgage_lump_sum", sortIndex: 1 });

    const body = await get().then((response) => response.json());

    expect(body.earmarkedCents).toBe("450000");
    expect(body.unallocatedCents).toBe("50000");
    expect(body.isOverAllocated).toBe(false);
    expect(body.earmarks.map((item: { name: string }) => item.name)).toEqual(["Trip", "Lump sum"]);
  });

  it("surfaces promising more than exists instead of clamping it away", async () => {
    const account = await savingsAccount();
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "100000" },
    });
    await earmark({ name: "Trip", savedCents: "250000" });

    const body = await get().then((response) => response.json());

    expect(body.unallocatedCents).toBe("-150000");
    expect(body.isOverAllocated).toBe(true);
  });

  it("carries a target when there is one and null when there is not", async () => {
    await earmark({ name: "Trip", savedCents: "100000", sortIndex: 0 });
    await earmark({ name: "Roof", savedCents: "100000", targetCents: "400000", sortIndex: 1 });

    const body = await get().then((response) => response.json());
    const [trip, roof] = body.earmarks;

    expect(trip.targetCents).toBeNull();
    expect(trip.remainingCents).toBeNull();
    expect(trip.pct).toBeNull();

    expect(roof.targetCents).toBe("400000");
    expect(roof.remainingCents).toBe("300000");
    expect(roof.pct).toBe(25);
  });

  it("gives each earmark the version an edit of it needs", async () => {
    const created = await earmark({ name: "Trip", savedCents: "100000" });

    const body = await get().then((response) => response.json());
    expect(body.earmarks[0].version).toBe(created.version);

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/goals/${created.id as string}`,
      headers: match(created.version as number),
      payload: { savedCents: "150000" },
    });
    expect(patched.statusCode).toBe(200);

    const after = await get().then((response) => response.json());
    expect(after.earmarks[0].version).toBe((created.version as number) + 1);
    expect(after.earmarks[0].setAsideCents).toBe("150000");
  });
});

/* -------------------------------------------------------------------------- */
/* The mortgage                                                               */
/* -------------------------------------------------------------------------- */

describe("POST /api/mortgage", () => {
  it("stores the terms and nothing derived from them", async () => {
    const { response, body } = await createMortgage();

    expect(response.statusCode).toBe(201);
    expect(body.mortgage.balanceCents).toBe("2000000");
    expect(body.mortgage.offsetDays).toBe(1);
    // Nothing computed is persisted, so nothing computed comes back from a write.
    expect(body.mortgage).not.toHaveProperty("payoffDate");
    expect(body.mortgage).not.toHaveProperty("plan");

    const row = await harness.db.prisma.mortgage.findFirstOrThrow({ where: { householdId } });
    expect(row.balanceCents).toBe(2_000_000n);
    expect(row.periodsPerYear).toBe(26);
  });

  it("refuses a balance date that is not a payment date, and says which dates are", async () => {
    // 2026-01-01 is the PAYDAY. The payment is the day after, so a balance
    // dated on the payday itself is a misunderstanding worth catching: every
    // later figure would be a fortnight out.
    const { response } = await createMortgage({ asOf: "2026-01-01" });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("2026-01-02");
    expect(await harness.db.prisma.mortgage.count({ where: { householdId } })).toBe(0);
  });

  it("refuses a payment too small to ever clear the balance", async () => {
    const { response } = await createMortgage({ paymentCents: "100" });

    expect(response.statusCode).toBe(400);
    expect(await harness.db.prisma.mortgage.count({ where: { householdId } })).toBe(0);
  });

  it("refuses a rate that is not whole basis points", async () => {
    const { response } = await createMortgage({ rateBasisPoints: 5.25 });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a payday schedule from another household", async () => {
    const other = await harness.db.prisma.household.create({ data: { name: "Someone else" } });
    const stranger = await harness.db.prisma.user.create({
      data: {
        householdId: other.id,
        name: "Stranger",
        initial: "S",
        email: "stranger@example.test",
        passwordHash: "x",
        colorFg: "#000000",
        colorBg: "#FFFFFF",
      },
    });
    const schedule = await harness.db.prisma.paySchedule.create({
      data: { userId: stranger.id, anchorDate: new Date("2026-01-01T00:00:00Z"), defaultCents: 1n },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/mortgage",
      headers: headers(),
      payload: {
        balanceCents: "2000000",
        asOf: "2026-01-02",
        rateBasisPoints: 500,
        paymentCents: "50000",
        payScheduleId: schedule.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("needs an idempotency key like every other mutation", async () => {
    const schedule = await seedPaySchedule();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/mortgage",
      headers: { cookie },
      payload: {
        balanceCents: "2000000",
        asOf: "2026-01-02",
        rateBasisPoints: 500,
        paymentCents: "50000",
        payScheduleId: schedule.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/savings: the mortgage panel", () => {
  it("reproduces the engine's schedule from the stored terms", async () => {
    await createMortgage();
    const body = await get().then((response) => response.json());

    expect(body.mortgage.error).toBeNull();
    expect(body.mortgage.plan.payoffDate).toBe("2027-08-13");
    expect(body.mortgage.plan.paymentCount).toBe(42);
    expect(body.mortgage.plan.totalInterestCents).toBe("83121");
    expect(body.mortgage.follows).toBe("Dax");
  });

  it("anchors the payments on the payday plus the offset, not on the payday", async () => {
    // With offsetDays 0 the schedule shifts by a day and the whole run moves
    // with it. If this layer ever anchored on the payday itself, the previous
    // test would still pass and every date would be silently one day early.
    await createMortgage({ offsetDays: 0, asOf: "2026-01-01" });
    const body = await get().then((response) => response.json());

    expect(body.mortgage.plan.payoffDate).toBe("2027-08-12");
    expect(body.mortgage.plan.paymentCount).toBe(42);
  });

  it("works out what is owing today rather than repeating the stored balance", async () => {
    await createMortgage();
    const body = await get().then((response) => response.json());

    const owingToday = BigInt(body.mortgage.plan.balanceTodayCents);
    const stored = BigInt(body.mortgage.balanceCents);

    expect(body.mortgage.asOf).toBe("2026-01-02");
    // Derived, never stored: by any date after the first payment it is lower
    // than the figure that was typed in.
    expect(owingToday).toBeLessThan(stored);
    expect(owingToday).toBeGreaterThanOrEqual(0n);
    expect(body.mortgage.plan.remainingPaymentCount).toBeLessThan(42);
  });

  it("applies a lump sum with the first payment on or after its date", async () => {
    const { body: created } = await createMortgage();

    const added = await harness.app.inject({
      method: "POST",
      url: `/api/mortgage/${created.mortgage.id as string}/prepayments`,
      headers: headers(),
      payload: { paidOn: "2026-07-01", cents: "500000", note: "Invented" },
    });
    expect(added.statusCode).toBe(201);

    const body = await get().then((response) => response.json());

    // The engine's verified figures for the same lump sum: the payment on
    // 2026-07-03 carries it, and the term shortens to 32 payments.
    expect(body.mortgage.plan.paymentCount).toBe(32);
    expect(body.mortgage.plan.payoffDate).toBe("2027-03-26");
    expect(body.mortgage.prepayments).toHaveLength(1);
    expect(body.mortgage.prepayments[0].cents).toBe("500000");
  });

  it("does not apply a lump sum that is already inside the stored balance", async () => {
    const { body: created } = await createMortgage();

    // Dated before the balance date, so the balance already reflects it.
    // Applying it again would pay the mortgage off twice.
    await harness.app.inject({
      method: "POST",
      url: `/api/mortgage/${created.mortgage.id as string}/prepayments`,
      headers: headers(),
      payload: { paidOn: "2025-11-15", cents: "500000" },
    });

    const body = await get().then((response) => response.json());

    expect(body.mortgage.plan.paymentCount).toBe(42);
    expect(body.mortgage.plan.payoffDate).toBe("2027-08-13");
    // Still on record, and still shown. It is history, not a mistake.
    expect(body.mortgage.prepayments).toHaveLength(1);
  });

  it("separates what is planned from what is paid, and prices the difference", async () => {
    const { body: created } = await createMortgage();

    await harness.app.inject({
      method: "POST",
      url: `/api/mortgage/${created.mortgage.id as string}/prepayments`,
      headers: headers(),
      payload: { paidOn: "2026-07-01", cents: "500000", paid: false },
    });

    const body = await get().then((response) => response.json());

    // "If we stop here" keeps the original term...
    expect(body.mortgage.withoutFurther.payoffDate).toBe("2027-08-13");
    expect(body.mortgage.withoutFurther.paymentCount).toBe(42);
    // ...while the plan includes the intention.
    expect(body.mortgage.plan.payoffDate).toBe("2027-03-26");
    expect(body.mortgage.plan.paymentCount).toBe(32);
    // And this is the sentence the screen exists to say.
    expect(body.mortgage.plannedBuys.daysEarlier).toBe(140);
    expect(body.mortgage.plannedBuys.interestSavedCents).toBe("23518");
    expect(body.mortgage.plannedBuys.paymentsSaved).toBe(10);
    expect(body.mortgage.plannedBuys.lumpSumCents).toBe("500000");
  });

  it("prices what the mortgage earmark would buy if it were paid now", async () => {
    await createMortgage();
    const account = await savingsAccount();
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: headers(),
      payload: { accountId: account.id, cents: "400000" },
    });
    await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Lump sum", savedCents: "400000", purpose: "mortgage_lump_sum" },
    });

    const body = await get().then((response) => response.json());

    expect(body.mortgage.whatIf.source).toBe("earmark");
    expect(body.mortgage.whatIf.lumpSumCents).toBe("400000");
    expect(body.mortgage.whatIf.appliedOn).toBe(body.today);
    expect(body.mortgage.whatIf.daysEarlier).toBeGreaterThan(0);
    expect(BigInt(body.mortgage.whatIf.interestSavedCents)).toBeGreaterThan(0n);
    // Paying it brings the date forward, never back.
    expect(body.mortgage.whatIf.payoffDate <= body.mortgage.plan.payoffDate).toBe(true);
  });

  it("answers a what-if asked directly, in preference to the earmark", async () => {
    await createMortgage();
    await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Lump sum", savedCents: "400000", purpose: "mortgage_lump_sum" },
    });

    const body = await get("/api/savings?lumpSumCents=100000").then((response) => response.json());

    expect(body.mortgage.whatIf.source).toBe("query");
    expect(body.mortgage.whatIf.lumpSumCents).toBe("100000");
  });

  it("has nothing to say about a lump sum when none is set aside", async () => {
    await createMortgage();
    const body = await get().then((response) => response.json());

    expect(body.mortgage.whatIf).toBeNull();
  });

  it("refuses a what-if in dollars, like every other amount on the wire", async () => {
    await createMortgage();
    const response = await get("/api/savings?lumpSumCents=1000.00");

    expect(response.statusCode).toBe(400);
  });

  it("counts paid lump sums against this year's allowance and planned ones apart", async () => {
    const { body: created } = await createMortgage();
    const today = (await get().then((response) => response.json())).today as string;
    const year = today.slice(0, 4);

    for (const payload of [
      { paidOn: `${year}-02-10`, cents: "200000", paid: true },
      { paidOn: `${year}-09-10`, cents: "150000", paid: false },
    ]) {
      await harness.app.inject({
        method: "POST",
        url: `/api/mortgage/${created.mortgage.id as string}/prepayments`,
        headers: headers(),
        payload,
      });
    }

    const body = await get().then((response) => response.json());

    expect(body.mortgage.room.capCents).toBe("1000000");
    // An intention must not eat the allowance; that would talk them out of
    // paying it.
    expect(body.mortgage.room.usedCents).toBe("200000");
    expect(body.mortgage.room.plannedCents).toBe("150000");
    expect(body.mortgage.room.roomCents).toBe("800000");
    expect(body.mortgage.room.isUsedUp).toBe(false);
    expect(body.mortgage.room.isTracked).toBe(true);
    expect(body.mortgage.room.resetsOn).toBe(`${String(Number(year) + 1)}-01-01`);
  });

  it("says plainly when no allowance is being tracked", async () => {
    await createMortgage({ prepaymentCapCents: "0" });
    const body = await get().then((response) => response.json());

    expect(body.mortgage.room.isTracked).toBe(false);
    expect(body.mortgage.room.capCents).toBe("0");
  });
});

describe("editing the mortgage", () => {
  it("takes a corrected balance through the versioned path", async () => {
    const { body: created } = await createMortgage();

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/mortgage/${created.mortgage.id as string}`,
      headers: match(created.mortgage.version as number),
      payload: { balanceCents: "1900000", asOf: "2026-01-16" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().mortgage.balanceCents).toBe("1900000");
    expect(patched.json().mortgage.asOf).toBe("2026-01-16");

    const body = await get().then((response) => response.json());
    expect(body.mortgage.plan.payoffDate).toBe("2027-07-30");
  });

  it("needs an If-Match, like every other edit", async () => {
    const { body: created } = await createMortgage();

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/mortgage/${created.mortgage.id as string}`,
      headers: headers(),
      payload: { balanceCents: "1900000" },
    });

    expect(response.statusCode).toBe(428);
  });

  it("refuses a correction that makes the terms unworkable, and keeps the old ones", async () => {
    const { body: created } = await createMortgage();

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/mortgage/${created.mortgage.id as string}`,
      headers: match(created.mortgage.version as number),
      payload: { paymentCents: "100" },
    });

    expect(response.statusCode).toBe(400);

    const row = await harness.db.prisma.mortgage.findFirstOrThrow({ where: { householdId } });
    expect(row.paymentCents).toBe(50_000n);
    expect(row.version).toBe(created.mortgage.version);
  });

  it("removes a mortgage softly, leaving the row and its history", async () => {
    const { body: created } = await createMortgage();

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/api/mortgage/${created.mortgage.id as string}`,
      headers: match(created.mortgage.version as number),
    });
    expect(removed.statusCode).toBe(200);

    expect((await get().then((response) => response.json())).mortgage).toBeNull();
    const row = await harness.db.prisma.mortgage.findFirstOrThrow({ where: { householdId } });
    expect(row.deletedAt).not.toBeNull();
  });
});

describe("editing a lump sum", () => {
  async function withPrepayment() {
    const { body: created } = await createMortgage();
    const added = await harness.app.inject({
      method: "POST",
      url: `/api/mortgage/${created.mortgage.id as string}/prepayments`,
      headers: headers(),
      payload: { paidOn: "2026-07-01", cents: "500000", paid: false },
    });
    return { mortgage: created.mortgage, prepayment: added.json().prepayment };
  }

  it("marks an intention as paid without changing the schedule it already implied", async () => {
    const { prepayment } = await withPrepayment();

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/prepayments/${prepayment.id as string}`,
      headers: match(prepayment.version as number),
      payload: { paid: true },
    });
    expect(patched.statusCode).toBe(200);

    const body = await get().then((response) => response.json());

    // The plan was already counting it, so the payoff date does not move...
    expect(body.mortgage.plan.payoffDate).toBe("2027-03-26");
    // ...but "if we stop here" now includes it, so there is nothing left to buy.
    expect(body.mortgage.withoutFurther.payoffDate).toBe("2027-03-26");
    expect(body.mortgage.plannedBuys.daysEarlier).toBe(0);
    expect(body.mortgage.plannedBuys.interestSavedCents).toBe("0");
  });

  it("corrects a figure typed from a statement", async () => {
    const { prepayment } = await withPrepayment();

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/prepayments/${prepayment.id as string}`,
      headers: match(prepayment.version as number),
      payload: { cents: "250000" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().prepayment.cents).toBe("250000");
    expect((await get().then((r) => r.json())).mortgage.plan.paymentCount).toBe(37);
  });

  it("removes one softly, and stops counting it", async () => {
    const { prepayment } = await withPrepayment();

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/api/prepayments/${prepayment.id as string}`,
      headers: match(prepayment.version as number),
    });
    expect(removed.statusCode).toBe(200);

    const body = await get().then((response) => response.json());
    expect(body.mortgage.prepayments).toEqual([]);
    expect(body.mortgage.plan.payoffDate).toBe("2027-08-13");
  });

  it("refuses a lump sum against another household's mortgage", async () => {
    const { prepayment } = await withPrepayment();
    await harness.db.prisma.mortgage.updateMany({
      where: { householdId },
      data: { householdId: (await harness.db.prisma.household.create({ data: { name: "Other" } })).id },
    });

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/prepayments/${prepayment.id as string}`,
      headers: match(prepayment.version as number),
      payload: { cents: "1" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("savings needs a signed-in user", () => {
  it("refuses a read", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/savings" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a write", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/mortgage",
      headers: { "idempotency-key": randomUUID() },
      payload: { balanceCents: "1", asOf: "2026-01-02", rateBasisPoints: 1, paymentCents: "1" },
    });
    expect(response.statusCode).toBe(401);
  });
});
