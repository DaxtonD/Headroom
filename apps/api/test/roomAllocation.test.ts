/**
 * What the room to save is for, end to end.
 *
 * Asked for on 2026-11-22: "a blanket 'room to save' doesn't cover all
 * scenarios. Our household is really trying to save to make lump-sum payments
 * to the mortgage and for vacations, but that doesn't mean every spare dollar
 * is to be allocated to savings."
 *
 * The division itself is tested as behaviour in
 * `packages/core/test/allocateRoom.test.ts`. This file covers what only a
 * real database can answer:
 *
 *  - the intent **round-trips** through create, patch and read;
 *  - the allocation reaches the ledger payload in the household's own order;
 *  - **null survives**, because null is not zero here and the difference
 *    decides whether a goal is allocated to at all;
 *  - an edit made from the savings screen does not clear the plan, which is
 *    the shape of data loss this feature could most easily have shipped.
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
let seeded: Awaited<ReturnType<typeof seedHousehold>>;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  seeded = await seedHousehold(harness);
  cookie = await signIn(harness, "alex@example.test", seeded.password);

  // A balance and a payday, so there is a current period with room in it.
  await harness.db.prisma.balanceSnapshot.create({
    data: {
      accountId: seeded.account.id,
      cents: 300_000n,
      asOf: new Date(Date.now() - 60 * 60 * 1000),
      enteredById: seeded.alex.id,
    },
  });
  await harness.db.prisma.paySchedule.create({
    data: { userId: seeded.alex.id, anchorDate: new Date(), defaultCents: 100_000n },
  });
});

interface Allocation {
  readonly availableCents: string;
  readonly intendedCents: string;
  readonly lines: readonly {
    readonly goalId: string;
    readonly name: string;
    readonly intentCents: string;
    readonly allocatedCents: string;
    readonly isShort: boolean;
  }[];
  readonly unallocatedCents: string;
  readonly shortCents: string;
}

async function allocation(): Promise<Allocation | null> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { roomAllocation: Allocation | null }).roomAllocation;
}

async function addGoal(body: Record<string, unknown>): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/goals",
    headers: { cookie, "idempotency-key": randomUUID() },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { goal: { id: string } }).goal.id;
}

async function goalRow(id: string) {
  return harness.db.prisma.goal.findUniqueOrThrow({
    where: { id },
    select: { perPaydayIntentCents: true, version: true, name: true },
  });
}

describe("stating an intent", () => {
  it("round-trips through create and back out of the ledger", async () => {
    await addGoal({
      name: "Mortgage lump sum",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "30000",
      sortIndex: 0,
    });

    const result = await allocation();
    expect(result?.lines).toHaveLength(1);
    expect(result?.lines[0]?.name).toBe("Mortgage lump sum");
    expect(result?.lines[0]?.intentCents).toBe("30000");
    expect(result?.intendedCents).toBe("30000");
  });

  it("keeps null as null, which is not the same as zero", async () => {
    /*
     * The distinction the whole feature rests on. A pot with no plan is never
     * allocated to, which is what stops "not earmarked" becoming zero - and
     * zero would be a plan of nothing, which is a different statement.
     */
    const id = await addGoal({ name: "Someday", targetCents: null, savedCents: "0" });

    expect((await goalRow(id)).perPaydayIntentCents).toBeNull();

    const result = await allocation();
    expect(result?.lines).toEqual([]);
    expect(result?.intendedCents).toBe("0");
    // Every cent of the room stays uncommitted.
    expect(result?.unallocatedCents).toBe(result?.availableCents);
  });

  it("is cleared by sending null, which is a real edit", async () => {
    const id = await addGoal({
      name: "Vacation",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "20000",
    });
    const before = await goalRow(id);

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/goals/${id}`,
      headers: { cookie, "if-match": String(before.version), "idempotency-key": randomUUID() },
      payload: { perPaydayIntentCents: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    expect((await goalRow(id)).perPaydayIntentCents).toBeNull();
    expect((await allocation())?.lines).toEqual([]);
  });

  it("refuses a negative intent", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        name: "Nope",
        targetCents: null,
        savedCents: "0",
        perPaydayIntentCents: "-100",
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("dividing the room up", () => {
  it("follows the household's order, not the amounts", async () => {
    /*
     * `sortIndex` is the household's stated priority and already existed, so
     * this needed no new way of saying what matters. Sorting by size here
     * would quietly overrule them.
     */
    await addGoal({
      name: "Vacation",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "20000",
      sortIndex: 1,
    });
    await addGoal({
      name: "Mortgage lump sum",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "30000",
      sortIndex: 0,
    });

    const result = await allocation();
    expect(result?.lines.map((line) => line.name)).toEqual(["Mortgage lump sum", "Vacation"]);
  });

  it("leaves the constraint exactly as the engine computed it", async () => {
    // Policy must not be able to change arithmetic. `availableCents` is the
    // period's own room to save and nothing here may move it.
    await addGoal({
      name: "Mortgage lump sum",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "30000",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/pay-periods",
      headers: { cookie },
    });
    const periods = (
      response.json() as { periods: readonly { isCurrentPartial: boolean; roomToSaveCents: string }[] }
    ).periods;
    const current = periods.find((period) => period.isCurrentPartial);

    expect((await allocation())?.availableCents).toBe(current?.roomToSaveCents);
  });
});

/**
 * The data-loss trap.
 *
 * The savings screen edits a goal through the goal form, and that form sends
 * every field it knows about. If the savings payload did not carry the intent,
 * the form would read it as absent and saving any edit made from that screen
 * would clear the household's plan without saying so.
 */
describe("the savings screen's copy of a goal", () => {
  it("carries the intent, so an edit from there cannot wipe it", async () => {
    await harness.db.prisma.account.create({
      data: { householdId: seeded.household.id, name: "Savings", kind: "savings" },
    });
    const id = await addGoal({
      name: "Vacation",
      targetCents: null,
      savedCents: "0",
      perPaydayIntentCents: "20000",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/savings",
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    const earmarks = (
      response.json() as {
        earmarks: readonly { id: string; perPaydayIntentCents: string | null }[];
      }
    ).earmarks;

    expect(earmarks.find((earmark) => earmark.id === id)?.perPaydayIntentCents).toBe("20000");
  });
});
