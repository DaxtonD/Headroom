/**
 * A lump sum off the mortgage, recorded where the money actually moves.
 *
 * Reported on 2026-11-20: "How do I make a lump sum payment to the mortgage?
 * It's not accessible from the ledger screen (one-off). The only way to do it
 * is from the savings screen (Add a lump sum) but it doesn't specify where the
 * money is coming out of."
 *
 * It did not specify because, as built, none did: a `prepayment` fed the
 * payoff projection and the prepayment allowance and moved no balance
 * anywhere. Recording a real lump sum took two unrelated entries, and doing
 * only the first left the Savings screen saying the mortgage was years shorter
 * while chequing had never dropped.
 *
 * A lump sum is now a ledger row carrying `mortgageId`, and that row is the
 * whole record - the Savings screen derives its paid lump sums from these
 * rather than keeping a copy. So what has to be proved here is that the one
 * row reaches BOTH: the balance falls, and the payoff projection moves. And
 * that the two can never disagree, because an edit on the ledger is the only
 * place either of them reads.
 *
 * Dates are built from today. Every amount is invented.
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
let householdId: string;
let accountId: string;
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
  householdId = seeded.household.id;
  accountId = seeded.account.id;
  alexId = seeded.alex.id;
  jordanId = seeded.jordan.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

function post(url: string, payload: unknown) {
  return harness.app.inject({
    method: "POST",
    url,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload,
  });
}

function del(url: string, version: number) {
  return harness.app.inject({
    method: "DELETE",
    url,
    headers: { cookie, "idempotency-key": randomUUID(), "if-match": String(version) },
  });
}

function patch(url: string, version: number, payload: unknown) {
  return harness.app.inject({
    method: "PATCH",
    url,
    headers: { cookie, "idempotency-key": randomUUID(), "if-match": String(version) },
    payload,
  });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

async function seedPay() {
  const response = await post("/api/pay-schedules", {
    userId: jordanId,
    anchorDate: inDays(0),
    defaultCents: "200000",
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { paySchedule: { id: string } }).paySchedule;
}

/** A savings account, so a lump sum has somewhere other than chequing to come from. */
async function seedSavings() {
  return harness.db.prisma.account.create({
    data: { householdId, name: "Savings", kind: "savings" },
  });
}

async function seedBalance(cents: bigint, account = accountId) {
  await harness.db.prisma.balanceSnapshot.create({
    data: { accountId: account, cents, asOf: new Date(), enteredById: alexId },
  });
}

/**
 * A mortgage anchored on its own dates.
 *
 * Its own, rather than following a payday: `amortize` refuses an `asOf` that
 * is not a payment date for the schedule, and a payday-anchored one has to be
 * a payday plus the offset, which is a different date every time this runs.
 */
async function seedMortgage() {
  return harness.db.prisma.mortgage.create({
    data: {
      householdId,
      balanceCents: 20_000_000n,
      asOf: new Date(`${inDays(-14)}T00:00:00Z`),
      anchorDate: new Date(`${inDays(-14)}T00:00:00Z`),
      rateBasisPoints: 500,
      paymentCents: 100_000n,
      prepaymentCapCents: 2_000_000n,
    },
  });
}

interface LumpWire {
  id: string;
  paidOn: string;
  cents: string;
  note: string | null;
  paid: boolean;
  version: number;
  occurrenceId: string | null;
  fromAccountName: string | null;
}

async function lumpSums(): Promise<LumpWire[]> {
  const body = (await get("/api/savings").then((response) => response.json())) as {
    mortgage: { prepayments: LumpWire[] } | null;
  };
  return body.mortgage?.prepayments ?? [];
}

async function chequingCents(): Promise<bigint> {
  const body = (await get("/api/dashboard").then((response) => response.json())) as {
    balance: { cents: string };
  };
  return BigInt(body.balance.cents);
}

/* -------------------------------------------------------------------------- */
/* The ledger can pay the mortgage at all                                     */
/* -------------------------------------------------------------------------- */

describe("a one-off that pays the mortgage", () => {
  it("is offered to the ledger: the dashboard says which mortgage", async () => {
    await seedPay();
    const before = (await get("/api/dashboard").then((r) => r.json())) as { mortgageId: unknown };
    // Nothing to pay yet, so nothing is offered.
    expect(before.mortgageId).toBe(null);

    const mortgage = await seedMortgage();
    const after = (await get("/api/dashboard").then((r) => r.json())) as { mortgageId: unknown };
    expect(after.mortgageId).toBe(mortgage.id);
  });

  /**
   * The whole report, in one assertion each way: the money leaves the account
   * AND the mortgage knows about it, from the single row.
   */
  it("takes the money out of the account and off the mortgage", async () => {
    await seedPay();
    await seedBalance(500_000n);
    const mortgage = await seedMortgage();

    const opening = await chequingCents();

    const created = await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
      paid: true,
    });
    expect(created.statusCode).toBe(201);

    expect(await chequingCents()).toBe(opening - 150_000n);

    const sums = await lumpSums();
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({
      cents: "150000",
      paid: true,
      note: "Lump sum",
      fromAccountName: "Chequing",
    });
    expect(sums[0]?.occurrenceId).toBe((created.json() as { occurrence: { id: string } }).occurrence.id);
  });

  /** The thing the Savings form could never say: which account it left. */
  it("says which account the money came out of", async () => {
    await seedPay();
    const savings = await seedSavings();
    const mortgage = await seedMortgage();

    await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: mortgage.id,
      paidFromAccountId: savings.id,
      date: inDays(0),
      paid: true,
    });

    expect((await lumpSums())[0]?.fromAccountName).toBe("Savings");
  });

  /**
   * A lump sum leaves chequing and goes to a loan. There is no balance for it
   * to arrive in, so money ARRIVING would make the payoff projection pay the
   * mortgage down with money nobody spent.
   */
  it("refuses one recorded as money coming in", async () => {
    const mortgage = await seedMortgage();
    const response = await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "deposit",
      mortgageId: mortgage.id,
      date: inDays(0),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("money going out");
  });

  /** It cannot both pay down a loan and land in an account. */
  it("refuses one that also names a destination account", async () => {
    const savings = await seedSavings();
    const mortgage = await seedMortgage();

    const response = await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "transfer",
      mortgageId: mortgage.id,
      transferToAccountId: savings.id,
      date: inDays(0),
    });

    expect(response.statusCode).toBe(400);
  });

  /** A bad id is a 400 with a sentence, not a foreign-key 500. */
  it("refuses a mortgage that is not this household's", async () => {
    const other = await harness.db.prisma.household.create({ data: { name: "Someone else" } });
    const theirs = await harness.db.prisma.mortgage.create({
      data: {
        householdId: other.id,
        balanceCents: 10_000_000n,
        asOf: new Date(),
        rateBasisPoints: 500,
        paymentCents: 100_000n,
      },
    });

    const response = await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: theirs.id,
      date: inDays(0),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("not one we can pay");
  });
});

/* -------------------------------------------------------------------------- */
/* One record, so the two screens cannot disagree                             */
/* -------------------------------------------------------------------------- */

describe("the row is the record", () => {
  async function aLumpSum(cents = "150000", paid = true) {
    const mortgage = await seedMortgage();
    const created = await post("/api/occurrences", {
      name: "Lump sum",
      cents,
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
      ...(paid ? { paid: true } : {}),
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { occurrence: { id: string; version: number } }).occurrence;
  }

  /**
   * The failure this design exists to prevent. With a copy in `prepayment`,
   * changing the amount on the ledger would move the balance and leave the
   * payoff date quoting the old figure - and nothing on either screen would
   * look wrong.
   */
  it("follows an edit made on the ledger", async () => {
    await seedPay();
    await seedBalance(500_000n);
    const row = await aLumpSum();

    const changed = await patch(`/api/occurrences/${row.id}`, row.version, { cents: "-90000" });
    expect(changed.statusCode).toBe(200);

    expect((await lumpSums())[0]?.cents).toBe("90000");
  });

  it("follows the date being moved", async () => {
    await seedPay();
    const row = await aLumpSum();

    const moved = await patch(`/api/occurrences/${row.id}`, row.version, { date: inDays(-3) });
    expect(moved.statusCode).toBe(200);

    expect((await lumpSums())[0]?.paidOn).toBe(inDays(-3));
  });

  /**
   * Intended and paid are different facts, and only a paid one counts against
   * the year's prepayment allowance. On the ledger the same distinction is
   * the tick, so the two have to be the same switch.
   */
  it("is planned until the row is ticked, then paid", async () => {
    await seedPay();
    const row = await aLumpSum("150000", false);
    expect((await lumpSums())[0]?.paid).toBe(false);

    const ticked = await patch(`/api/occurrences/${row.id}`, row.version, { paid: true });
    expect(ticked.statusCode).toBe(200);

    expect((await lumpSums())[0]?.paid).toBe(true);
  });

  it("goes when the row goes", async () => {
    await seedPay();
    const row = await aLumpSum();
    expect(await lumpSums()).toHaveLength(1);

    const removed = await del(`/api/occurrences/${row.id}`, row.version);
    expect(removed.statusCode).toBe(200);

    expect(await lumpSums()).toEqual([]);
  });

  /**
   * A lump sum entered on the ledger is not editable from the Savings screen,
   * because there is nothing there to edit. The wire says which is which, and
   * the screen reads this to decide between an Edit and a link.
   */
  it("tells the Savings screen it lives on the ledger", async () => {
    await seedPay();
    await aLumpSum();

    const [onLedger] = await lumpSums();
    expect(onLedger?.occurrenceId).not.toBe(null);
    expect(onLedger?.fromAccountName).not.toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Intentions still work the way they did                                     */
/* -------------------------------------------------------------------------- */

describe("a lump sum that is only planned", () => {
  it("is still a prepayment, and still moves no money", async () => {
    await seedPay();
    await seedBalance(500_000n);
    const mortgage = await seedMortgage();
    const opening = await chequingCents();

    const created = await post(`/api/mortgage/${mortgage.id}/prepayments`, {
      paidOn: inDays(30),
      cents: "150000",
      paid: false,
    });
    expect(created.statusCode).toBe(201);

    // An intention is not money leaving an account.
    expect(await chequingCents()).toBe(opening);

    const [planned] = await lumpSums();
    expect(planned?.paid).toBe(false);
    // No row behind it, so the Savings screen keeps its own Edit.
    expect(planned?.occurrenceId).toBe(null);
    expect(planned?.fromAccountName).toBe(null);
  });

  it("sits in the same list as one paid on the ledger, in date order", async () => {
    await seedPay();
    const mortgage = await seedMortgage();

    await post(`/api/mortgage/${mortgage.id}/prepayments`, {
      paidOn: inDays(60),
      cents: "100000",
      paid: false,
    });
    await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
      paid: true,
    });

    const sums = await lumpSums();
    expect(sums).toHaveLength(2);
    expect(sums.map((lump) => lump.paidOn)).toEqual([inDays(0), inDays(60)]);
    expect(sums.map((lump) => lump.occurrenceId === null)).toEqual([false, true]);
  });
});

/* -------------------------------------------------------------------------- */
/* It reaches the arithmetic, not just the list                               */
/* -------------------------------------------------------------------------- */

describe("the payoff projection", () => {
  it("counts a paid lump sum against this year's allowance", async () => {
    await seedPay();
    const mortgage = await seedMortgage();

    const before = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { room: { usedCents: number | string } };
    };

    await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
      paid: true,
    });

    const after = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { room: { usedCents: number | string } };
    };

    expect(BigInt(String(after.mortgage.room.usedCents))).toBe(
      BigInt(String(before.mortgage.room.usedCents)) + 150_000n,
    );
  });

  /**
   * Only PAID lump sums consume the allowance. Counting an intention would
   * understate the room and talk the household out of paying it, which is a
   * rule the Savings screen already had and the ledger must not break.
   */
  it("does not count one still waiting to be ticked", async () => {
    await seedPay();
    const mortgage = await seedMortgage();

    const before = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { room: { usedCents: number | string } };
    };

    await post("/api/occurrences", {
      name: "Lump sum",
      cents: "150000",
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
    });

    const after = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { room: { usedCents: number | string } };
    };

    expect(String(after.mortgage.room.usedCents)).toBe(String(before.mortgage.room.usedCents));
  });

  /** It is a real payment, so it has to bring the payoff date forward. */
  it("pays the mortgage off sooner", async () => {
    await seedPay();
    const mortgage = await seedMortgage();

    const before = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { plan: { payoffDate: string } | null };
    };

    await post("/api/occurrences", {
      name: "Lump sum",
      cents: "1000000",
      kind: "bill",
      mortgageId: mortgage.id,
      date: inDays(0),
      paid: true,
    });

    const after = (await get("/api/savings").then((r) => r.json())) as {
      mortgage: { plan: { payoffDate: string } | null };
    };

    expect(before.mortgage.plan).not.toBe(null);
    expect(after.mortgage.plan).not.toBe(null);
    expect(after.mortgage.plan!.payoffDate < before.mortgage.plan!.payoffDate).toBe(true);
  });
});
