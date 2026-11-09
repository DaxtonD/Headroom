/**
 * A payday brings its paycheque with it.
 *
 * The bug these protect against, reported from a real setup: paydays entered,
 * every bill entered, and a ledger of nothing but outgoings. The running
 * balance only fell, the lowest point was far below zero, and the coverage
 * banner said there was not enough money for the mortgage - all correct
 * readings of the data, none of them true of the household.
 *
 * The cause was that a pay schedule stored only DATES and an amount used for
 * the pay-period totals. Only a paycheque template put a row on the timeline,
 * and nothing created one. The same screen therefore showed money coming in
 * at the top of a window and a running balance that never rose.
 *
 * Every amount here is invented; the dates are the structure under test.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateForAllHouseholds } from "../src/lib/generateService.js";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let firstMemberId: string;
let secondMemberId: string;

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
  firstMemberId = seeded.carol.id;
  secondMemberId = seeded.dax.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

/** The next Thursday, as a plain date. Any weekday would do; biweekly does the rest. */
function nextThursday(weeksAhead = 0): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + ((4 - date.getUTCDay() + 7) % 7) + 7 * weeksAhead);
  return date.toISOString().slice(0, 10);
}

function post(url: string, payload: unknown) {
  return harness.app.inject({
    method: "POST",
    url,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload,
  });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

async function addPayday(userId: string, anchorDate: string, defaultCents: string) {
  const response = await post("/api/pay-schedules", { userId, anchorDate, defaultCents });
  expect(response.statusCode).toBe(201);
  return response.json().paySchedule as { id: string; version: number };
}

interface TimelineRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly cents: string;
  readonly runningCents: string;
}

async function timeline() {
  const body = await get("/api/timeline").then((response) => response.json());
  return body as {
    rows: TimelineRow[];
    lowest: { cents: string };
    safeToSpendNowCents: string;
    coverage: { allCovered: boolean };
  };
}

describe("adding a payday", () => {
  it("puts the paycheque itself on the ledger", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");

    const { rows } = await timeline();
    const paycheques = rows.filter((row) => row.kind === "paycheque");

    expect(paycheques.length).toBeGreaterThan(0);
    for (const cheque of paycheques) {
      // Money arriving, not leaving. A sign error here would be invisible on
      // the screen and catastrophic in the totals.
      expect(BigInt(cheque.cents)).toBe(200_000n);
    }
  });

  it("makes the running balance rise, which is the whole complaint", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");
    await post("/api/balance", { cents: "30000" });
    expect(
      (
        await post("/api/templates", {
          name: "Hydro",
          kind: "bill",
          defaultCents: "9000",
          withdrawal: "auto",
          schedule: { type: "monthly", day: 17 },
          section: "fixed",
        })
      ).statusCode,
    ).toBe(201);

    const result = await timeline();

    // The reported symptom was a lowest point far below the opening balance
    // with nothing but ordinary bills on the ledger.
    expect(BigInt(result.lowest.cents)).toBeGreaterThan(0n);
    expect(BigInt(result.safeToSpendNowCents)).toBeGreaterThan(0n);
    expect(result.coverage.allCovered).toBe(true);

    // And the balance genuinely goes up somewhere, not merely stays level.
    const runs = result.rows.map((row) => BigInt(row.runningCents));
    expect(runs.some((value, index) => index > 0 && value > (runs[index - 1] as bigint))).toBe(true);
  });

  it("gives each person their own cheque", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");
    await addPayday(secondMemberId, nextThursday(1), "210000");

    const templates = await harness.db.prisma.template.findMany({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { ownerUserId: true, defaultCents: true },
    });

    expect(templates).toHaveLength(2);
    expect(new Set(templates.map((row) => row.ownerUserId))).toEqual(
      new Set([firstMemberId, secondMemberId]),
    );
    expect(new Set(templates.map((row) => row.defaultCents))).toEqual(new Set([200_000n, 210_000n]));
  });

  it("names the cheque after the person it belongs to", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");

    const template = await harness.db.prisma.template.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { name: true, section: true, withdrawal: true },
    });

    expect(template.name).toMatch(/'s? pay$/);
    expect(template.section).toBe("income");
    // A paycheque lands on the employer's date. It is not movable to a later
    // cheque the way a flexible bill is.
    expect(template.withdrawal).toBe("auto");
  });
});

describe("a household set up before paydays brought their cheque", () => {
  /**
   * Written against the database directly, which is exactly the state the
   * reported setup was in: schedules present, no paycheque template anywhere.
   */
  async function legacySchedule(userId: string, anchorDate: string, cents: bigint) {
    return harness.db.prisma.paySchedule.create({
      data: { userId, anchorDate: new Date(`${anchorDate}T00:00:00.000Z`), defaultCents: cents },
    });
  }

  function generate() {
    return post("/api/templates/generate", {});
  }

  it("heals itself on the next run, with nothing re-entered", async () => {
    await legacySchedule(firstMemberId, nextThursday(), 200_000n);

    const first = await generate();
    expect(first.json().generation.paychequeTemplatesCreated).toBe(1);

    const { rows } = await timeline();
    expect(rows.some((row) => row.kind === "paycheque")).toBe(true);
  });

  it("does not create a second one on every later run", async () => {
    await legacySchedule(firstMemberId, nextThursday(), 200_000n);

    await generate();
    const second = await generate();
    expect(second.json().generation.paychequeTemplatesCreated).toBe(0);

    const templates = await harness.db.prisma.template.count({
      where: { householdId, kind: "paycheque", deletedAt: null },
    });
    expect(templates).toBe(1);
  });

  it("leaves an archived paycheque archived", async () => {
    await legacySchedule(firstMemberId, nextThursday(), 200_000n);
    await generate();

    const template = await harness.db.prisma.template.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { id: true },
    });
    await harness.db.prisma.template.update({
      where: { id: template.id },
      data: { active: false },
    });

    // Archiving is a decision. Putting the template back on the next write
    // would make it impossible to turn a paycheque off.
    expect((await generate()).json().generation.paychequeTemplatesCreated).toBe(0);
    expect(
      await harness.db.prisma.template.count({
        where: { householdId, kind: "paycheque", deletedAt: null, active: true },
      }),
    ).toBe(0);
  });
});

describe("changing the pay amount", () => {
  it("carries through to future cheques", async () => {
    const schedule = await addPayday(firstMemberId, nextThursday(), "200000");

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/pay-schedules/${schedule.id}`,
      headers: {
        cookie,
        "idempotency-key": randomUUID(),
        "if-match": `"${String(schedule.version)}"`,
      },
      payload: { defaultCents: "215000" },
    });
    expect(patched.statusCode).toBe(200);

    const template = await harness.db.prisma.template.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { defaultCents: true },
    });
    expect(template.defaultCents).toBe(215_000n);
  });

  it("does not rewrite a cheque already on the ledger", async () => {
    const schedule = await addPayday(firstMemberId, nextThursday(), "200000");

    const before = await harness.db.prisma.occurrence.findMany({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { id: true, cents: true },
      orderBy: { date: "asc" },
    });
    expect(before.length).toBeGreaterThan(0);

    await harness.app.inject({
      method: "PATCH",
      url: `/api/pay-schedules/${schedule.id}`,
      headers: {
        cookie,
        "idempotency-key": randomUUID(),
        "if-match": `"${String(schedule.version)}"`,
      },
      payload: { defaultCents: "215000" },
    });

    const after = await harness.db.prisma.occurrence.findMany({
      where: { id: { in: before.map((row) => row.id) } },
      select: { cents: true },
    });
    // One of these may have been edited for overtime or banked hours. A raise
    // entered later must not reach back and rewrite it.
    for (const row of after) expect(row.cents).toBe(200_000n);
  });
});

describe("the setup checklist", () => {
  async function missing(): Promise<string[]> {
    const body = await get("/api/setup").then((response) => response.json());
    return body.missing as string[];
  }

  it("stays quiet once a payday carries its cheque", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");
    expect(await missing()).not.toContain("income_on_ledger");
  });

  it("speaks up when the paycheque has been archived", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");
    await harness.db.prisma.template.updateMany({
      where: { householdId, kind: "paycheque" },
      data: { active: false },
    });

    expect(await missing()).toContain("income_on_ledger");
  });

  it("is not silenced by some other deposit", async () => {
    /**
     * The exact reason the check failed in production. It asked "is there any
     * income template at all", and one unrelated benefit payment answered yes
     * while neither person's pay was on the ledger - so the checklist stayed
     * silent through precisely the setup it existed to catch.
     */
    await addPayday(firstMemberId, nextThursday(), "200000");
    await harness.db.prisma.template.updateMany({
      where: { householdId, kind: "paycheque" },
      data: { active: false },
    });

    expect(
      (
        await post("/api/templates", {
          name: "A benefit payment",
          kind: "deposit",
          defaultCents: "15000",
          withdrawal: "auto",
          schedule: { type: "monthly", day: 20 },
          section: "income",
        })
      ).statusCode,
    ).toBe(201);

    expect(await missing()).toContain("income_on_ledger");
  });

  it("notices one missing payday among several that are fine", async () => {
    const first = await addPayday(firstMemberId, nextThursday(), "200000");
    await addPayday(secondMemberId, nextThursday(1), "210000");

    // Archive only one of the two. "Any income exists" would pass here.
    const templates = await harness.db.prisma.template.findMany({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { id: true, scheduleJson: true },
    });
    const forFirst = templates.find(
      (row) => (row.scheduleJson as { payScheduleId?: string }).payScheduleId === first.id,
    );
    expect(forFirst).toBeDefined();
    await harness.db.prisma.template.update({
      where: { id: (forFirst as { id: string }).id },
      data: { active: false },
    });

    expect(await missing()).toContain("income_on_ledger");
  });
});

describe("the periodic sweep", () => {
  /**
   * Generation otherwise only runs after a write, which leaves two gaps: a
   * household that edits nothing watches its ledger shorten as the horizon
   * rolls forward, and an upgrade that adds something everyone should have
   * reaches nobody until they happen to edit something.
   */
  const quiet = {
    info: () => undefined,
    warn: () => undefined,
  };

  it("heals a household that has not been touched since the upgrade", async () => {
    await harness.db.prisma.paySchedule.create({
      data: {
        userId: firstMemberId,
        anchorDate: new Date(`${nextThursday()}T00:00:00.000Z`),
        defaultCents: 200_000n,
      },
    });

    const result = await generateForAllHouseholds(harness.db.prisma, quiet);
    expect(result.paychequeTemplatesCreated).toBe(1);

    const { rows } = await timeline();
    expect(rows.some((row) => row.kind === "paycheque")).toBe(true);
  });

  it("does nothing on a household that is already current", async () => {
    await addPayday(firstMemberId, nextThursday(), "200000");

    const result = await generateForAllHouseholds(harness.db.prisma, quiet);
    expect(result.paychequeTemplatesCreated).toBe(0);
    expect(result.created).toBe(0);
  });

  it("carries on past a household it cannot generate", async () => {
    // A schedule this one template claims to follow, which does not exist.
    await harness.db.prisma.template.create({
      data: {
        householdId,
        kind: "bill",
        name: "Points at nothing",
        defaultCents: 1_000n,
        withdrawal: "auto",
        scheduleType: "biweekly",
        scheduleJson: { type: "biweekly", payScheduleId: randomUUID() },
      },
    });
    await addPayday(firstMemberId, nextThursday(), "200000");

    const other = await harness.db.prisma.household.create({ data: { name: "Next door" } });
    const neighbour = await harness.db.prisma.user.create({
      data: {
        householdId: other.id,
        name: "Sam",
        initial: "S",
        email: "sam@example.test",
        passwordHash: "x",
        colorFg: "#2A3C8F",
        colorBg: "#E3E7F7",
      },
    });
    await harness.db.prisma.paySchedule.create({
      data: {
        userId: neighbour.id,
        anchorDate: new Date(`${nextThursday()}T00:00:00.000Z`),
        defaultCents: 190_000n,
      },
    });

    // One household throws; the other still gets its paycheque. A sweep is
    // maintenance and must never leave later households unserved.
    const result = await generateForAllHouseholds(harness.db.prisma, quiet);
    expect(result.households).toBe(2);

    expect(
      await harness.db.prisma.template.count({
        where: { householdId: other.id, kind: "paycheque", deletedAt: null },
      }),
    ).toBe(1);

    // And the broken one really did fail, so this is not passing vacuously:
    // its transaction rolled back, taking the paycheque template with it.
    expect(
      await harness.db.prisma.template.count({
        where: { householdId, kind: "paycheque", deletedAt: null },
      }),
    ).toBe(0);
  });
});

describe("a household that followed the old advice", () => {
  /**
   * Before paydays brought their cheque, the setup checklist said to add the
   * pay by hand under "Money coming in". That produced a paycheque template
   * with fortnightly dates of its own and, since the field is optional, often
   * no owner.
   *
   * Creating a second cheque for the same payday would double the household's
   * income - the one failure worse than the bug being fixed, because a ledger
   * that is too optimistic is not obviously wrong the way a ledger that only
   * falls is.
   */
  async function legacySchedule(userId: string, anchorDate: string, cents: bigint) {
    return harness.db.prisma.paySchedule.create({
      data: { userId, anchorDate: new Date(`${anchorDate}T00:00:00.000Z`), defaultCents: cents },
    });
  }

  function handMadePay(anchorDate: string, ownerUserId: string | null) {
    return harness.db.prisma.template.create({
      data: {
        householdId,
        kind: "paycheque",
        name: "Pay",
        defaultCents: 200_000n,
        ownerUserId,
        withdrawal: "auto",
        scheduleType: "biweekly",
        scheduleJson: { type: "biweekly", anchorDate },
        section: "income",
      },
    });
  }

  function generate() {
    return post("/api/templates/generate", {});
  }

  async function paychequeCount() {
    return harness.db.prisma.template.count({
      where: { householdId, kind: "paycheque", deletedAt: null },
    });
  }

  it("does not add a second cheque when the hand-made one has an owner", async () => {
    const anchor = nextThursday();
    await legacySchedule(firstMemberId, anchor, 200_000n);
    await handMadePay(anchor, firstMemberId);

    await generate();
    expect(await paychequeCount()).toBe(1);
  });

  it("recognises an unowned one by its dates", async () => {
    const anchor = nextThursday();
    await legacySchedule(firstMemberId, anchor, 200_000n);
    // No owner, and an anchor two fortnights off the payday: the same series.
    await handMadePay(nextThursday(4), null);

    await generate();
    expect(await paychequeCount()).toBe(1);
  });

  it("leaves genuinely unrelated fortnightly income alone", async () => {
    const anchor = nextThursday();
    await legacySchedule(firstMemberId, anchor, 200_000n);
    // A week off the payday, so not the same fortnightly series at all.
    await handMadePay(nextThursday(1), null);

    await generate();
    // The hand-made one plus the payday's own: two, which is correct.
    expect(await paychequeCount()).toBe(2);
  });

  it("refuses to guess when two people are paid on the same day", async () => {
    const anchor = nextThursday();
    await legacySchedule(firstMemberId, anchor, 200_000n);
    await legacySchedule(secondMemberId, anchor, 210_000n);
    await handMadePay(anchor, null);

    await generate();

    // Whose cheque is it? Adding one for each payday would count the pay
    // three times. Better a payday with no cheque, which the checklist names
    // and a person can fix, than silent double income.
    expect(await paychequeCount()).toBe(1);

    const setup = await get("/api/setup").then((response) => response.json());
    expect(setup.missing).toContain("income_on_ledger");
  });
});
