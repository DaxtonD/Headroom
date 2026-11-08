/**
 * Generating occurrences from templates, against a real Postgres.
 *
 * The two properties worth protecting:
 *
 *  1. Running it again creates nothing and changes nothing - in particular it
 *     never undoes an edit, a verification, a move or a clearing.
 *  2. Running it twice at the same moment cannot duplicate anything.
 *
 * Amounts are invented; dates are structure.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let carolId: string;
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
  carolId = seeded.carol.id;
  daxId = seeded.dax.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

/** Pay schedules far enough ahead that the window always contains paydays. */
async function seedSchedules() {
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  // Any Thursday works as an anchor; biweekly does the rest.
  const anchorDax = new Date(monday);
  anchorDax.setUTCDate(anchorDax.getUTCDate() + ((4 - anchorDax.getUTCDay() + 7) % 7));
  const anchorCarol = new Date(anchorDax);
  anchorCarol.setUTCDate(anchorCarol.getUTCDate() + 7);

  const dax = await harness.db.prisma.paySchedule.create({
    data: { userId: daxId, anchorDate: anchorDax, defaultCents: 175_000n },
  });
  const carol = await harness.db.prisma.paySchedule.create({
    data: { userId: carolId, anchorDate: anchorCarol, defaultCents: 180_000n },
  });

  return { dax, carol };
}

function generate() {
  return harness.app.inject({
    method: "POST",
    url: "/api/templates/generate",
    headers: { cookie, "idempotency-key": randomUUID() },
    payload: {},
  });
}

describe("POST /api/templates", () => {
  it("creates a template and records it in the history", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        name: "Home insurance",
        kind: "bill",
        defaultCents: "21500",
        withdrawal: "auto",
        schedule: { type: "monthly", day: 17 },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().template.name).toBe("Home insurance");
    expect(response.json().template.defaultCents).toBe("21500");

    const activity = await harness.db.prisma.activity.findFirst({
      where: { entity: "template" },
    });
    expect(activity?.action).toBe("create");
  });

  it("refuses a schedule that contradicts the placement", async () => {
    const flexibleButDated = await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        name: "Confused",
        kind: "bill",
        defaultCents: "1000",
        withdrawal: "flexible",
        schedule: { type: "monthly", day: 3 },
      },
    });
    expect(flexibleButDated.statusCode).toBe(400);

    const autoButFlexible = await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        name: "Also confused",
        kind: "bill",
        defaultCents: "1000",
        withdrawal: "auto",
        schedule: { type: "flexible", frequency: "monthly" },
      },
    });
    expect(autoButFlexible.statusCode).toBe(400);
  });

  it("refuses a malformed schedule", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        name: "Bad day",
        kind: "bill",
        defaultCents: "1000",
        withdrawal: "auto",
        schedule: { type: "monthly", day: 99 },
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/templates/generate", () => {
  it("creates the occurrences the templates call for", async () => {
    const schedules = await seedSchedules();

    await harness.db.prisma.template.createMany({
      data: [
        {
          householdId,
          name: "Dax's pay",
          kind: "paycheque",
          defaultCents: 175_000n,
          withdrawal: "auto",
          scheduleType: "biweekly",
          scheduleJson: { type: "biweekly", payScheduleId: schedules.dax.id },
        },
        {
          householdId,
          name: "Mortgage",
          kind: "bill",
          defaultCents: 98_765n,
          withdrawal: "auto",
          scheduleType: "relative_to_pay",
          scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
        },
        {
          householdId,
          name: "Power",
          kind: "bill",
          defaultCents: 12_345n,
          withdrawal: "flexible",
          scheduleType: "flexible",
          scheduleJson: { type: "flexible", frequency: "monthly" },
        },
      ],
    });

    const response = await generate();
    expect(response.statusCode).toBe(200);

    const generation = response.json().generation;
    expect(generation.created).toBeGreaterThan(0);

    const occurrences = await harness.db.prisma.occurrence.findMany({
      select: { name: true, kind: true, withdrawal: true, date: true, periodKey: true, cents: true },
    });

    expect(occurrences.some((row) => row.name === "Dax's pay" && row.kind === "paycheque")).toBe(true);
    expect(occurrences.some((row) => row.name === "Mortgage" && row.withdrawal === "auto")).toBe(true);

    // The flexible bill is undated and hangs off a cheque.
    const power = occurrences.find((row) => row.name === "Power");
    expect(power?.withdrawal).toBe("flexible");
    expect(power?.date).toBeNull();

    // Bills leave the account; paycheques arrive.
    expect(occurrences.find((row) => row.name === "Mortgage")?.cents).toBe(-98_765n);
    expect(occurrences.find((row) => row.name === "Dax's pay")?.cents).toBe(175_000n);
  });

  it("anchors a flexible bill to a real paycheque row", async () => {
    const schedules = await seedSchedules();

    await harness.db.prisma.template.createMany({
      data: [
        {
          householdId,
          name: "Dax's pay",
          kind: "paycheque",
          defaultCents: 175_000n,
          withdrawal: "auto",
          scheduleType: "biweekly",
          scheduleJson: { type: "biweekly", payScheduleId: schedules.dax.id },
        },
        {
          householdId,
          name: "Power",
          kind: "bill",
          defaultCents: 12_345n,
          withdrawal: "flexible",
          scheduleType: "flexible",
          scheduleJson: { type: "flexible", frequency: "monthly" },
        },
      ],
    });

    await generate();

    const power = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { name: "Power" },
      include: { anchor: true },
    });

    expect(power.anchorOccurrenceId).not.toBeNull();
    expect(power.anchor?.kind).toBe("paycheque");
  });

  it("creates nothing the second time", async () => {
    const schedules = await seedSchedules();
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    const first = await generate();
    const countAfterFirst = await harness.db.prisma.occurrence.count();
    expect(first.json().generation.created).toBeGreaterThan(0);

    const second = await generate();
    expect(second.json().generation.created).toBe(0);
    expect(second.json().generation.existing).toBeGreaterThan(0);
    expect(await harness.db.prisma.occurrence.count()).toBe(countAfterFirst);
  });

  it("never undoes an edit, a verification or a move", async () => {
    const schedules = await seedSchedules();
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    await generate();

    const occurrence = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { name: "Mortgage" },
      orderBy: { date: "asc" },
    });

    // Carol types the real amount and verifies it.
    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${occurrence.id}`,
      headers: { cookie, "if-match": `"${occurrence.version}"`, "idempotency-key": randomUUID() },
      payload: { cents: "-1012.40", verified: true },
    });
    expect(patched.statusCode).toBe(200);

    await generate();

    const after = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });

    // The edit and the verification survive. This is the whole point.
    expect(after.cents).toBe(-101_240n);
    expect(after.verifiedAt).not.toBeNull();
  });

  it("does not resurrect something that was marked paid", async () => {
    const schedules = await seedSchedules();
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    await generate();
    const countAfterFirst = await harness.db.prisma.occurrence.count();

    const occurrence = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { name: "Mortgage" },
    });
    await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${occurrence.id}`,
      headers: { cookie, "if-match": `"${occurrence.version}"`, "idempotency-key": randomUUID() },
      payload: { cleared: true },
    });

    await generate();

    // The cleared row is still the row for that period, so no second copy.
    expect(await harness.db.prisma.occurrence.count()).toBe(countAfterFirst);
    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    expect(reread.clearedAt).not.toBeNull();
  });

  it("skips a template that is turned off", async () => {
    const schedules = await seedSchedules();
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Subscriptions (on the Visa)",
        kind: "bill",
        defaultCents: 7_500n,
        withdrawal: "flexible",
        scheduleType: "flexible",
        scheduleJson: { type: "flexible", frequency: "monthly" },
        active: false,
      },
    });
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Dax's pay",
        kind: "paycheque",
        defaultCents: 175_000n,
        withdrawal: "auto",
        scheduleType: "biweekly",
        scheduleJson: { type: "biweekly", payScheduleId: schedules.dax.id },
      },
    });

    await generate();

    expect(
      await harness.db.prisma.occurrence.count({ where: { name: "Subscriptions (on the Visa)" } }),
    ).toBe(0);
  });

  it("reports a template whose schedule is malformed, without failing the run", async () => {
    const schedules = await seedSchedules();

    // Written straight to the database, bypassing the route's validation, to
    // stand in for a bad row that got in some other way.
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Broken",
        kind: "bill",
        defaultCents: 1_000n,
        withdrawal: "auto",
        scheduleType: "monthly",
        scheduleJson: { type: "monthly", day: "the third" },
      },
    });
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Dax's pay",
        kind: "paycheque",
        defaultCents: 175_000n,
        withdrawal: "auto",
        scheduleType: "biweekly",
        scheduleJson: { type: "biweekly", payScheduleId: schedules.dax.id },
      },
    });

    const response = await generate();

    expect(response.statusCode).toBe(200);
    const generation = response.json().generation;
    // The good template still generated.
    expect(generation.created).toBeGreaterThan(0);
    expect(generation.skipped.length).toBeGreaterThan(0);
    expect(generation.skipped[0].reason).toMatch(/not valid/);
  });

  it("creates no duplicates when two runs race", async () => {
    const schedules = await seedSchedules();
    await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    // Different idempotency keys, so neither is a replay: these are two
    // genuine, simultaneous generation runs.
    const [a, b] = await Promise.all([generate(), generate()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const rows = await harness.db.prisma.occurrence.findMany({
      where: { name: "Mortgage" },
      select: { periodKey: true },
    });

    const keys = rows.map((row) => row.periodKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("puts the generated occurrences straight onto the timeline", async () => {
    const schedules = await seedSchedules();

    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId: (await harness.db.prisma.account.findFirstOrThrow({ where: { householdId } })).id,
        cents: 41_000n,
        asOf: new Date(),
        enteredById: carolId,
      },
    });

    await harness.db.prisma.template.createMany({
      data: [
        {
          householdId,
          name: "Dax's pay",
          kind: "paycheque",
          defaultCents: 175_000n,
          withdrawal: "auto",
          scheduleType: "biweekly",
          scheduleJson: { type: "biweekly", payScheduleId: schedules.dax.id },
        },
        {
          householdId,
          name: "Carol's pay",
          kind: "paycheque",
          defaultCents: 180_000n,
          withdrawal: "auto",
          scheduleType: "biweekly",
          scheduleJson: { type: "biweekly", payScheduleId: schedules.carol.id },
        },
        {
          householdId,
          name: "Mortgage",
          kind: "bill",
          defaultCents: 98_765n,
          withdrawal: "auto",
          scheduleType: "relative_to_pay",
          scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
        },
      ],
    });

    await generate();

    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(timeline.rows.length).toBeGreaterThan(0);
    // The running balance is derived, so it is present on every row.
    for (const row of timeline.rows) {
      expect(typeof row.runningCents).toBe("string");
    }

    const periods = await harness.app
      .inject({ method: "GET", url: "/api/pay-periods", headers: { cookie } })
      .then((response) => response.json());
    expect(periods.periods.length).toBeGreaterThan(0);
  });
});

describe("PATCH /api/templates/:id", () => {
  it("changes the template without touching occurrences already generated", async () => {
    const schedules = await seedSchedules();
    const template = await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    await generate();
    const before = await harness.db.prisma.occurrence.findMany({
      where: { templateId: template.id },
      select: { cents: true },
    });

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${template.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { defaultCents: "105000" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().template.defaultCents).toBe("105000");

    // Existing occurrences keep their amounts: changing the usual amount is
    // not the same as rewriting what is already on the timeline.
    const after = await harness.db.prisma.occurrence.findMany({
      where: { templateId: template.id },
      select: { cents: true },
    });
    expect(after).toEqual(before);
  });

  it("needs a version, like every other change", async () => {
    const template = await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Power",
        kind: "bill",
        defaultCents: 12_345n,
        withdrawal: "flexible",
        scheduleType: "flexible",
        scheduleJson: { type: "flexible", frequency: "monthly" },
      },
    });

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${template.id}`,
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { name: "Power bill" },
    });

    expect(response.statusCode).toBe(428);
  });

  it("can turn a template off, which stops it generating", async () => {
    const schedules = await seedSchedules();
    const template = await harness.db.prisma.template.create({
      data: {
        householdId,
        name: "Mortgage",
        kind: "bill",
        defaultCents: 98_765n,
        withdrawal: "auto",
        scheduleType: "relative_to_pay",
        scheduleJson: { type: "relative_to_pay", payScheduleId: schedules.dax.id, offsetDays: 1 },
      },
    });

    const off = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${template.id}`,
      headers: { cookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);

    await generate();
    expect(await harness.db.prisma.occurrence.count({ where: { templateId: template.id } })).toBe(0);
  });
});
