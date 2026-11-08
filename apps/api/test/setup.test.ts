/**
 * Setting the household up, and the expense model behind it.
 *
 * Two things are being pinned down here:
 *
 *  1. Pay schedules can be created and changed through the API at all. They
 *     had no routes before, which meant the app could not be set up: the
 *     horizon, the pay periods, where flexible bills anchor and any
 *     "day after payday" bill all depend on them.
 *  2. An expense entered ONCE as a recurring bill appears on the Budget page
 *     with the right monthly figure, derived from its cadence. That is what
 *     removes the double entry, so it is worth testing hard.
 *
 * Amounts are invented.
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

const headers = () => ({ cookie, "idempotency-key": randomUUID() });

/* -------------------------------------------------------------------------- */
/* GET /api/setup                                                             */
/* -------------------------------------------------------------------------- */

describe("GET /api/setup", () => {
  it("says what still has to be filled in", async () => {
    const body = await harness.app
      .inject({ method: "GET", url: "/api/setup", headers: { cookie } })
      .then((response) => response.json());

    // seedHousehold makes an account but no pay schedule and no income.
    expect(body.missing).toContain("pay_schedule");
    expect(body.missing).toContain("income");
    expect(body.missing).not.toContain("account");
    expect(body.paySchedules).toEqual([]);
    expect(body.members).toHaveLength(2);
  });

  it("stops reporting something once it is set", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
    });

    const body = await harness.app
      .inject({ method: "GET", url: "/api/setup", headers: { cookie } })
      .then((response) => response.json());

    expect(body.missing).not.toContain("pay_schedule");
    expect(body.paySchedules).toHaveLength(1);
    expect(body.paySchedules[0].user.name).toBe("Dax");
  });

  it("carries the household settings with their version, so they can be edited", async () => {
    const body = await harness.app
      .inject({ method: "GET", url: "/api/setup", headers: { cookie } })
      .then((response) => response.json());

    expect(body.household.cushionCents).toBe("0");
    expect(body.household.horizonPaychequeCount).toBe(4);
    expect(body.household.weekendWithdrawalRule).toBe("as_scheduled");
    expect(body.household.version).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Pay schedules                                                              */
/* -------------------------------------------------------------------------- */

describe("pay schedules", () => {
  it("can be created, which was impossible before", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().paySchedule.anchorDate).toBe("2026-11-12");
    expect(response.json().paySchedule.defaultCents).toBe("175000");
    expect(response.json().paySchedule.cadence).toBe("biweekly");
  });

  it("makes the pay periods and the horizon work", async () => {
    // With no schedule there is nothing to anchor two-week windows on.
    const before = await harness.app
      .inject({ method: "GET", url: "/api/pay-periods", headers: { cookie } })
      .then((response) => response.json());
    expect(before.periods).toEqual([]);

    await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
    });
    await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: carolId, anchorDate: "2026-11-19", defaultCents: "180000" },
    });

    const after = await harness.app
      .inject({ method: "GET", url: "/api/pay-periods", headers: { cookie } })
      .then((response) => response.json());

    expect(after.periods.length).toBeGreaterThan(0);
    // Each window holds one cheque from each person, so each counts two.
    const full = after.periods.find((period: { isCurrentPartial: boolean }) => !period.isCurrentPartial);
    expect(full.projectedPaycheques.length).toBe(2);
  });

  it("allows only one schedule per person", async () => {
    const payload = { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" };

    expect(
      (await harness.app.inject({ method: "POST", url: "/api/pay-schedules", headers: headers(), payload }))
        .statusCode,
    ).toBe(201);

    // Two would make "every 14 days from an anchor" ambiguous and would
    // double-count every pay period.
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("already_exists");
  });

  it("can have its anchor and amount changed", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/pay-schedules",
        headers: headers(),
        payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
      })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/pay-schedules/${created.paySchedule.id}`,
      headers: { ...headers(), "if-match": '"1"' },
      payload: { anchorDate: "2026-11-13", defaultCents: "182500" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().paySchedule.anchorDate).toBe("2026-11-13");
    expect(patched.json().paySchedule.defaultCents).toBe("182500");
    expect(patched.json().paySchedule.version).toBe(2);
  });

  it("refuses a date that is not a real date", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: daxId, anchorDate: "2026-02-30", defaultCents: "175000" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses someone outside the household", async () => {
    const other = await harness.db.prisma.household.create({ data: { name: "Elsewhere" } });
    const stranger = await harness.db.prisma.user.create({
      data: {
        householdId: other.id,
        name: "Stranger",
        initial: "S",
        email: "stranger2@example.test",
        passwordHash: "x",
      },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: stranger.id, anchorDate: "2026-11-12", defaultCents: "1" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("needs a version to change, like everything else", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/pay-schedules",
        headers: headers(),
        payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
      })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/pay-schedules/${created.paySchedule.id}`,
      headers: headers(),
      payload: { defaultCents: "1" },
    });

    expect(patched.statusCode).toBe(428);
  });
});

/* -------------------------------------------------------------------------- */
/* Household settings                                                        */
/* -------------------------------------------------------------------------- */

describe("household settings", () => {
  it("changes the cushion, and that changes what is safe to spend", async () => {
    const account = await harness.db.prisma.account.findFirstOrThrow({ where: { householdId } });
    await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 41_000n, asOf: new Date(), enteredById: carolId },
    });

    const before = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());
    expect(before.safeToSpendNowCents).toBe("41000");

    const patched = await harness.app.inject({
      method: "PATCH",
      url: "/api/settings/household",
      headers: { ...headers(), "if-match": '"1"' },
      payload: { cushionCents: "10000" },
    });
    expect(patched.statusCode).toBe(200);

    const after = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    // Spending now lowers every later balance, so the cushion comes straight
    // off what is safe to spend.
    expect(after.safeToSpendNowCents).toBe("31000");
    expect(after.cushionCents).toBe("10000");
  });

  it("changes the horizon, and that changes how far ahead things run", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/pay-schedules",
      headers: headers(),
      payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
    });

    const before = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: "/api/settings/household",
      headers: { ...headers(), "if-match": '"1"' },
      payload: { horizonPaychequeCount: 2 },
    });
    expect(patched.statusCode).toBe(200);

    const after = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })
      .then((response) => response.json());

    // A shorter horizon ends sooner.
    expect(after.horizonEnd < before.horizonEnd).toBe(true);
  });

  it("changes the weekend rule", async () => {
    const patched = await harness.app.inject({
      method: "PATCH",
      url: "/api/settings/household",
      headers: { ...headers(), "if-match": '"1"' },
      payload: { weekendWithdrawalRule: "friday_before" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().household.weekendWithdrawalRule).toBe("friday_before");
  });

  it("refuses a negative cushion and a nonsensical horizon", async () => {
    for (const payload of [{ cushionCents: "-1" }, { horizonPaychequeCount: 0 }, { horizonPaychequeCount: 99 }]) {
      const response = await harness.app.inject({
        method: "PATCH",
        url: "/api/settings/household",
        headers: { ...headers(), "if-match": '"1"' },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* One entry, two screens                                                     */
/* -------------------------------------------------------------------------- */

describe("an expense entered once as a recurring bill", () => {
  async function addBill(overrides: Record<string, unknown> = {}) {
    const schedule = await harness.app
      .inject({
        method: "POST",
        url: "/api/pay-schedules",
        headers: headers(),
        payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
      })
      .then((response) => response.json());

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: headers(),
      payload: {
        name: "Mortgage",
        kind: "bill",
        defaultCents: "100000",
        withdrawal: "auto",
        section: "fixed",
        schedule: { type: "relative_to_pay", payScheduleId: schedule.paySchedule.id, offsetDays: 1 },
        ...overrides,
      },
    });

    expect(response.statusCode).toBe(201);
    return response.json().template;
  }

  it("appears on the Budget page with its monthly cost worked out", async () => {
    await addBill();

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    const mortgage = budget.fixed.lines.find((line: { name: string }) => line.name === "Mortgage");
    expect(mortgage).toBeDefined();
    // Biweekly, so 26 times a year: 100000 * 26 / 12 = 216666.67 -> 216667.
    expect(mortgage.monthlyCents).toBe("216667");
    // Not twice the amount, which is the classic mistake.
    expect(mortgage.monthlyCents).not.toBe("200000");
    expect(mortgage.source).toBe("bill");
    expect(mortgage.overridden).toBe(false);
  });

  it("counts toward the section total and what is left", async () => {
    await addBill();

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(budget.fixed.monthlyCents).toBe("216667");
    expect(budget.totalMonthlyCents).toBe("216667");
  });

  it("uses a stated monthly figure where one is given", async () => {
    await addBill({ monthlyBudgetOverrideCents: "215000" });

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    const mortgage = budget.fixed.lines.find((line: { name: string }) => line.name === "Mortgage");
    expect(mortgage.monthlyCents).toBe("215000");
    expect(mortgage.overridden).toBe(true);
    // The derived figure is still reported, so the difference is visible.
    expect(mortgage.derivedMonthlyCents).toBe("216667");
  });

  it("is still on the timeline, so one entry really does serve both", async () => {
    await addBill();

    const generated = await harness.app.inject({
      method: "POST",
      url: "/api/templates/generate",
      headers: headers(),
      payload: {},
    });
    expect(generated.statusCode).toBe(200);

    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie } })
      .then((response) => response.json());

    expect(timeline.rows.some((row: { name: string }) => row.name === "Mortgage")).toBe(true);
  });

  it("leaves the Budget page when it is archived, and its history stays", async () => {
    const bill = await addBill();

    await harness.app.inject({
      method: "POST",
      url: "/api/templates/generate",
      headers: headers(),
      payload: {},
    });
    const occurrencesBefore = await harness.db.prisma.occurrence.count({
      where: { templateId: bill.id },
    });
    expect(occurrencesBefore).toBeGreaterThan(0);

    const archived = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${bill.id}`,
      headers: { ...headers(), "if-match": `"${bill.version}"` },
      payload: { active: false },
    });
    expect(archived.statusCode).toBe(200);

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());
    expect(budget.fixed.lines).toEqual([]);
    expect(budget.totalMonthlyCents).toBe("0");

    // Archived, not deleted: the past occurrences are all still there.
    expect(await harness.db.prisma.occurrence.count({ where: { templateId: bill.id } })).toBe(
      occurrencesBefore,
    );
    // And it is still listed, so it can be brought back.
    const templates = await harness.app
      .inject({ method: "GET", url: "/api/templates", headers: { cookie } })
      .then((response) => response.json());
    expect(templates.templates.some((t: { id: string }) => t.id === bill.id)).toBe(true);
  });

  it("can be brought back out of the archive", async () => {
    const bill = await addBill();

    await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${bill.id}`,
      headers: { ...headers(), "if-match": `"${bill.version}"` },
      payload: { active: false },
    });

    const restored = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${bill.id}`,
      headers: { ...headers(), "if-match": '"2"' },
      payload: { active: true },
    });
    expect(restored.statusCode).toBe(200);

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());
    expect(budget.fixed.monthlyCents).toBe("216667");
  });

  it("sits alongside budget-only categories without double counting", async () => {
    await addBill();

    // Food has no due date and no recurrence; it is a category, not a bill.
    await harness.app.inject({
      method: "POST",
      url: "/api/budget-lines",
      headers: headers(),
      payload: { name: "Food", section: "variable", monthlyCents: "140000" },
    });

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(budget.fixed.monthlyCents).toBe("216667");
    expect(budget.variable.monthlyCents).toBe("140000");
    expect(budget.totalMonthlyCents).toBe("356667");

    const food = budget.variable.lines.find((line: { name: string }) => line.name === "Food");
    expect(food.source).toBe("category");
  });

  it("keeps a bill and a category apart even when they share a name", async () => {
    // Easily done: a recurring "Mortgage" bill and a budget category also
    // called "Mortgage". Matching the engine's output back by name labelled
    // the category as a bill and handed the UI the bill's id to edit, so this
    // is pinned down.
    await addBill();
    await harness.app.inject({
      method: "POST",
      url: "/api/budget-lines",
      headers: headers(),
      payload: { name: "Mortgage", section: "fixed", monthlyCents: "200000" },
    });

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    const mortgages = budget.fixed.lines.filter(
      (line: { name: string }) => line.name === "Mortgage",
    );
    expect(mortgages).toHaveLength(2);

    // Exactly one of each, each with its own id.
    const sources = mortgages.map((line: { source: string }) => line.source).sort();
    expect(sources).toEqual(["bill", "category"]);

    const bill = mortgages.find((line: { source: string }) => line.source === "bill");
    const category = mortgages.find((line: { source: string }) => line.source === "category");
    expect(bill.id).not.toBe(category.id);
    // The derived figure belongs to the bill, not to the category.
    expect(bill.monthlyCents).toBe("216667");
    expect(category.monthlyCents).toBe("200000");
    expect(category.derivedMonthlyCents).toBeNull();

    // And both still count toward the section.
    expect(budget.fixed.monthlyCents).toBe((216_667n + 200_000n).toString());
  });

  it("a monthly bill needs no conversion at all", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: headers(),
      payload: {
        name: "Home insurance",
        kind: "bill",
        defaultCents: "21500",
        withdrawal: "auto",
        section: "fixed",
        schedule: { type: "monthly", day: 17 },
      },
    });

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    const insurance = budget.fixed.lines.find((line: { name: string }) => line.name === "Home insurance");
    expect(insurance.monthlyCents).toBe("21500");
  });

  it("a paycheque is not an expense and never reaches the budget sections", async () => {
    const schedule = await harness.app
      .inject({
        method: "POST",
        url: "/api/pay-schedules",
        headers: headers(),
        payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "175000" },
      })
      .then((response) => response.json());

    await harness.app.inject({
      method: "POST",
      url: "/api/templates",
      headers: headers(),
      payload: {
        name: "Dax's pay",
        kind: "paycheque",
        defaultCents: "175000",
        withdrawal: "auto",
        section: "income",
        schedule: { type: "biweekly", payScheduleId: schedule.paySchedule.id },
      },
    });

    const budget = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(budget.fixed.lines).toEqual([]);
    expect(budget.variable.lines).toEqual([]);
    expect(budget.totalMonthlyCents).toBe("0");
  });
});

describe("the setup routes need a session", () => {
  it("refuses them when signed out", async () => {
    expect((await harness.app.inject({ method: "GET", url: "/api/setup" })).statusCode).toBe(401);
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/pay-schedules",
          headers: { "idempotency-key": randomUUID() },
          payload: { userId: daxId, anchorDate: "2026-11-12", defaultCents: "1" },
        })
      ).statusCode,
    ).toBe(401);
  });
});
