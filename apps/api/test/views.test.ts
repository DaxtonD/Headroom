/**
 * The screens' data, end to end: real Postgres, real HTTP, real engine.
 *
 * These assert that what Home and Upcoming receive is exactly what the
 * calculation engine produces from the stored facts - the running balance on
 * every line, the lowest point, safe-to-spend, coverage, and the ordering that
 * puts a flexible bill under the paycheque it hangs from.
 *
 * The scenario mirrors the real one's SHAPE (a starting balance, two
 * alternating biweekly cheques, dated automatic withdrawals and undated
 * flexible bills) with invented amounts.
 */
import { randomUUID } from "node:crypto";
import { computeTimeline, formatCents } from "@headroom/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let accountId: string;
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
  accountId = seeded.account.id;
  carolId = seeded.carol.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

const START_CENTS = 41_000n;

/**
 * Builds the scenario and returns what the engine says about it, so the
 * assertions compare the API against the engine rather than against numbers
 * typed into this file.
 */
async function buildScenario() {
  // The balance the user typed in.
  await harness.db.prisma.balanceSnapshot.create({
    data: {
      accountId,
      cents: START_CENTS,
      asOf: new Date("2026-11-07T15:58:00.000Z"),
      enteredById: carolId,
    },
  });

  // Pay schedules: alternating Thursdays, as in the real household.
  await harness.db.prisma.paySchedule.createMany({
    data: [
      {
        userId: carolId,
        anchorDate: new Date("2026-11-19T00:00:00.000Z"),
        defaultCents: 180_000n,
      },
    ],
  });
  const dax = await harness.db.prisma.user.findFirstOrThrow({
    where: { householdId, email: "dax@example.test" },
  });
  await harness.db.prisma.paySchedule.create({
    data: {
      userId: dax.id,
      anchorDate: new Date("2026-11-12T00:00:00.000Z"),
      defaultCents: 175_000n,
    },
  });

  const payDax = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Dax's pay",
      cents: 175_000n,
      kind: "paycheque",
      withdrawal: "auto",
      date: new Date("2026-11-12T00:00:00.000Z"),
      sortIndex: 1,
    },
  });

  // A flexible bill anchored to "now": it sits before the first paycheque.
  const power = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Power",
      cents: -12_345n,
      kind: "bill",
      withdrawal: "flexible",
      anchorOccurrenceId: null,
      sortIndex: 0,
    },
  });

  // A flexible bill hanging off Dax's cheque.
  const energy = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Energy",
      cents: -9_000n,
      kind: "bill",
      withdrawal: "flexible",
      anchorOccurrenceId: payDax.id,
      sortIndex: 2,
    },
  });

  // Dated automatic withdrawals, one already verified.
  const mortgage = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Mortgage",
      cents: -98_765n,
      kind: "bill",
      withdrawal: "auto",
      date: new Date("2026-11-13T00:00:00.000Z"),
      verifiedAt: new Date(),
      verifiedById: carolId,
      sortIndex: 3,
    },
  });

  const insurance = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Home insurance",
      cents: -21_500n,
      kind: "bill",
      withdrawal: "auto",
      date: new Date("2026-11-17T00:00:00.000Z"),
      sortIndex: 4,
    },
  });

  // An automatic deposit: dated, but money coming in.
  const credit = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Child tax credit",
      cents: 10_000n,
      kind: "deposit",
      withdrawal: "auto",
      date: new Date("2026-11-20T00:00:00.000Z"),
      sortIndex: 5,
    },
  });

  // What the engine makes of exactly these facts.
  const expected = computeTimeline({
    startBalanceCents: START_CENTS,
    cushionCents: 0n,
    events: [
      { id: power.id, name: "Power", cents: -12_345n, kind: "bill", placement: "flexible", anchorId: null, sortIndex: 0 },
      { id: payDax.id, name: "Dax's pay", cents: 175_000n, kind: "paycheque", placement: "auto", date: "2026-11-12", sortIndex: 1 },
      { id: energy.id, name: "Energy", cents: -9_000n, kind: "bill", placement: "flexible", anchorId: payDax.id, sortIndex: 2 },
      { id: mortgage.id, name: "Mortgage", cents: -98_765n, kind: "bill", placement: "auto", date: "2026-11-13", sortIndex: 3, verified: true },
      { id: insurance.id, name: "Home insurance", cents: -21_500n, kind: "bill", placement: "auto", date: "2026-11-17", sortIndex: 4 },
      { id: credit.id, name: "Child tax credit", cents: 10_000n, kind: "deposit", placement: "auto", date: "2026-11-20", sortIndex: 5 },
    ],
  });

  return { ids: { power, payDax, energy, mortgage, insurance, credit }, expected };
}

describe("GET /api/timeline", () => {
  it("returns the rows in the order the bank would apply them", async () => {
    const { ids } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(body.rows.map((row: { id: string }) => row.id)).toEqual([
      // Anchored to "now", so before everything.
      ids.power.id,
      // Payday, then the bill hanging off it, then the other dated items.
      ids.payDax.id,
      ids.energy.id,
      ids.mortgage.id,
      ids.insurance.id,
      ids.credit.id,
    ]);
  });

  it("matches the engine on every running balance", async () => {
    const { expected } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(body.rows.map((row: { runningCents: string }) => row.runningCents)).toEqual(
      expected.rows.map((row) => row.runningCents.toString()),
    );
  });

  it("matches the engine on the lowest point, safe-to-spend and the end balance", async () => {
    const { expected } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(body.lowest.cents).toBe(expected.lowest.cents.toString());
    expect(body.lowest.afterEventId).toBe(expected.lowest.afterEventId);
    expect(body.safeToSpendNowCents).toBe(expected.safeToSpendNowCents.toString());
    expect(body.leftThisCycleCents).toBe(expected.leftThisCycleCents.toString());
  });

  it("gives a flexible bill its anchor paycheque's date", async () => {
    const { ids } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    const energy = body.rows.find((row: { id: string }) => row.id === ids.energy.id);
    const power = body.rows.find((row: { id: string }) => row.id === ids.power.id);

    expect(energy.date).toBe("2026-11-12");
    expect(energy.isDated).toBe(false);
    // Anchored to "now" means there is no date at all.
    expect(power.date).toBeNull();
  });

  it("counts only dated money going out as needing coverage", async () => {
    const { ids } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    const byId = new Map(body.rows.map((row: { id: string }) => [row.id, row]));
    expect((byId.get(ids.mortgage.id) as { requiresCoverage: boolean }).requiresCoverage).toBe(true);
    // A deposit brings money in; a flexible bill can be moved.
    expect((byId.get(ids.credit.id) as { requiresCoverage: boolean }).requiresCoverage).toBe(false);
    expect((byId.get(ids.power.id) as { requiresCoverage: boolean }).requiresCoverage).toBe(false);
    expect(body.coverage.autoWithdrawalCount).toBe(2);
  });

  it("carries who verified what, so the other person can see it", async () => {
    const { ids } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    const mortgage = body.rows.find((row: { id: string }) => row.id === ids.mortgage.id);
    expect(mortgage.verified).toBe(true);
    expect(mortgage.verifiedBy.name).toBe("Carol");

    const insurance = body.rows.find((row: { id: string }) => row.id === ids.insurance.id);
    expect(insurance.verified).toBe(false);
    expect(insurance.verifiedBy).toBeNull();
    // Four bills in the scenario (Power, Energy, Mortgage, Home insurance),
    // of which only the mortgage is verified. The deposit and the paycheque
    // are not bills waiting for a real figure.
    expect(body.estimatesCount).toBe(3);
  });

  it("sends every amount as a string, never a number", async () => {
    await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    for (const row of body.rows) {
      expect(typeof row.cents, `cents of ${row.name}`).toBe("string");
      expect(typeof row.runningCents, `running of ${row.name}`).toBe("string");
    }
    expect(typeof body.leftThisCycleCents).toBe("string");
  });
});

describe("GET /api/dashboard", () => {
  it("agrees with the timeline on every shared figure", async () => {
    await buildScenario();

    const [dashboard, timeline] = await Promise.all([
      harness.app
        .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
        .then((response) => response.json()),
      harness.app
        .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
        .then((response) => response.json()),
    ]);

    // The two screens must never disagree, which is why one function loads both.
    expect(dashboard.safeToSpendNowCents).toBe(timeline.safeToSpendNowCents);
    expect(dashboard.leftThisCycleCents).toBe(timeline.leftThisCycleCents);
    expect(dashboard.lowest.cents).toBe(timeline.lowest.cents);
    expect(dashboard.coverage.allCovered).toBe(timeline.coverage.allCovered);
    expect(dashboard.estimatesCount).toBe(timeline.estimatesCount);
    expect(dashboard.horizonEnd).toBe(timeline.horizonEnd);
  });

  it("lists the next automatic withdrawals with the balance after each", async () => {
    const { expected } = await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    const autoRows = expected.rows.filter((row) => row.requiresCoverage);

    expect(body.nextAutoWithdrawals).toHaveLength(autoRows.length);
    expect(body.nextAutoWithdrawals.map((row: { balanceAfterCents: string }) => row.balanceAfterCents)).toEqual(
      autoRows.map((row) => row.runningCents.toString()),
    );
  });

  it("reports the balance the user typed in, and when", async () => {
    await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    expect(body.balance.snapshotCents).toBe(START_CENTS.toString());
    expect(body.balance.cents).toBe(START_CENTS.toString());
    expect(body.balance.asOf).toBe("2026-11-07T15:58:00.000Z");
    expect(body.balance.enteredBy.name).toBe("Carol");
  });

  it("warns about the first withdrawal that is not covered", async () => {
    await buildScenario();

    // A bill far larger than the balance can stand.
    await harness.db.prisma.occurrence.create({
      data: {
        householdId,
        name: "Surprise repair",
        cents: -500_000n,
        kind: "bill",
        withdrawal: "auto",
        date: new Date("2026-11-14T00:00:00.000Z"),
        sortIndex: 9,
      },
    });

    const body = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    expect(body.coverage.allCovered).toBe(false);
    expect(body.coverage.firstShortfall.name).toBe("Surprise repair");
    expect(body.coverage.firstShortfall.date).toBe("2026-11-14");
    // A real figure the warning can quote.
    expect(BigInt(body.coverage.firstShortfall.shortCents) > 0n).toBe(true);
  });
});

describe("GET /api/pay-periods", () => {
  it("reports two-week windows that keep in - auto - flexible = left", async () => {
    await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/pay-periods", headers: { cookie } })
      .then((response) => response.json());

    expect(body.periods.length).toBeGreaterThan(0);

    for (const period of body.periods) {
      const inCents = BigInt(period.inCents);
      const autoCents = BigInt(period.autoCents);
      const flexibleCents = BigInt(period.flexibleCents);
      expect(BigInt(period.leftCents), period.label).toBe(inCents - autoCents - flexibleCents);
    }
  });

  it("opens the current partial window with what is in the account", async () => {
    await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/pay-periods", headers: { cookie } })
      .then((response) => response.json());

    const partial = body.periods.find((period: { isCurrentPartial: boolean }) => period.isCurrentPartial);
    if (partial) {
      expect(BigInt(partial.inCents) >= START_CENTS).toBe(true);
    }
  });
});

describe("editing changes the derived numbers immediately", () => {
  it("recalculates everything after an amount is edited", async () => {
    const { ids } = await buildScenario();

    const before = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${ids.insurance.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cents: "-31000" },
    });
    expect(patched.statusCode).toBe(200);

    const after = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    // The bill grew, so less is left and the floor is lower.
    expect(BigInt(after.leftThisCycleCents) < BigInt(before.leftThisCycleCents)).toBe(true);
    expect(BigInt(after.lowest.cents) <= BigInt(before.lowest.cents)).toBe(true);
  });

  it("takes a bill off the timeline once it is marked paid", async () => {
    const { ids } = await buildScenario();

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${ids.power.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cleared: true },
    });
    expect(patched.statusCode).toBe(200);

    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(timeline.rows.map((row: { id: string }) => row.id)).not.toContain(ids.power.id);
    // It cleared after the snapshot, so it now counts against the balance.
    expect(BigInt(timeline.startBalanceCents)).toBe(START_CENTS - 12_345n);
  });

  it("keeps the end balance the same when a flexible bill is moved", async () => {
    const { ids } = await buildScenario();

    const before = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    const moved = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${ids.power.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { anchorOccurrenceId: ids.payDax.id },
    });
    expect(moved.statusCode).toBe(200);

    const after = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    // The money still goes out, so the total is unchanged...
    expect(after.leftThisCycleCents).toBe(before.leftThisCycleCents);
    // ...but it no longer comes out before the cheque arrives, so the floor
    // is higher than it was.
    expect(BigInt(after.lowest.cents) > BigInt(before.lowest.cents)).toBe(true);
  });

  it("formats what it returns the way the screens show it", async () => {
    await buildScenario();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    // The client turns these strings back into cents and formats them; this
    // is the round trip the UI depends on.
    expect(formatCents(BigInt(body.balance.cents))).toBe("$410.00");
  });
});
