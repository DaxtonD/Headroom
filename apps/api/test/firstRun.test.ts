/**
 * Setting a household up from nothing, over HTTP.
 *
 * Every other test in this suite starts from `seedHousehold`, which inserts an
 * account and sometimes pay schedules directly. That is convenient, and it hid
 * the one path nobody had walked: a real household on its first evening, with
 * the people created by `create-user` and **nothing else in the database**.
 *
 * Walking it found that the chequing account - the one the ledger reads its
 * balance from, without which nothing on the home screen works - could only be
 * created while the household had zero accounts. Adding the savings account
 * first therefore made it unreachable from the app entirely, and the Manage
 * checklist said "account" was missing while offering no way to fix it.
 *
 * So this test exists to be run before anyone types a real figure in: it is the
 * first-run setup, in the order someone would actually do it.
 *
 * Every amount and date here is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let daxId: string;
let carolId: string;

const PASSWORD = "correct-horse-battery-staple";

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/**
 * Exactly what `node dist/cli.js create-user` leaves behind, run twice: a
 * household, two people, and nothing else at all. No account, no pay schedule,
 * no settings.
 */
beforeEach(async () => {
  await harness.reset();
  const { hashPassword } = await import("../src/auth/password.js");
  const passwordHash = await hashPassword(PASSWORD);

  const household = await harness.db.prisma.household.create({
    data: { name: "Our household" },
  });
  householdId = household.id;

  const first = await harness.db.prisma.user.create({
    data: {
      householdId,
      name: "Alex",
      initial: "A",
      email: "alex@example.test",
      passwordHash,
      colorFg: "#7A4A00",
      colorBg: "#F3E6CF",
    },
  });
  const second = await harness.db.prisma.user.create({
    data: {
      householdId,
      name: "Blair",
      initial: "B",
      email: "blair@example.test",
      passwordHash,
      colorFg: "#2A3C8F",
      colorBg: "#E3E7F7",
    },
  });
  daxId = first.id;
  carolId = second.id;

  cookie = await signIn(harness, "alex@example.test", PASSWORD);
});

const headers = () => ({ cookie, "idempotency-key": randomUUID() });
const match = (version: number) => ({ ...headers(), "if-match": `"${String(version)}"` });

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

function post(url: string, payload: unknown) {
  return harness.app.inject({ method: "POST", url, headers: headers(), payload });
}

describe("a household with nothing in it", () => {
  it("says what is missing rather than looking broken", async () => {
    const setup = await get("/api/setup").then((response) => response.json());

    expect(setup.missing).toContain("account");
    expect(setup.missing).toContain("pay_schedule");
    expect(setup.missing).toContain("income");
    expect(setup.accounts).toEqual([]);
    expect(setup.members).toHaveLength(2);
  });

  it("serves every screen without a 500, with nothing entered", async () => {
    // The first thing anyone does is look around. None of it should fall over
    // just because the database is empty.
    for (const url of [
      "/api/dashboard",
      "/api/pay-periods",
      "/api/timeline",
      "/api/budget",
      "/api/goals-overview",
      "/api/net-worth",
      "/api/savings",
      "/api/year",
      "/api/setup",
    ]) {
      const response = await get(url);
      expect(response.statusCode, `${url} should answer`).toBe(200);
    }
  });

  it("refuses a balance until there is somewhere to put it, and says why", async () => {
    const response = await post("/api/balance", { cents: "100000" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("no_account");
  });
});

describe("the whole first-run path, in order", () => {
  it("can be completed entirely over the API", async () => {
    /* ---- 1. The chequing account ---- */
    const chequing = await post("/api/accounts", { name: "Chequing", kind: "chequing" });
    expect(chequing.statusCode).toBe(201);
    expect(chequing.json().account.kind).toBe("chequing");

    /* ---- 2. Paydays, one each ---- */
    for (const [userId, anchorDate, cents] of [
      [daxId, "2026-11-05", "212500"],
      [carolId, "2026-11-12", "177500"],
    ] as const) {
      const response = await post("/api/pay-schedules", {
        userId,
        anchorDate,
        defaultCents: cents,
      });
      expect(response.statusCode).toBe(201);
    }

    /* ---- 3. The stated income figures ---- */
    const household = (await get("/api/setup").then((r) => r.json())).household;
    const income = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/income",
      headers: match(household.version as number),
      payload: { netMonthlyCents: "880000", netYearlyCents: "10500000" },
    });
    expect(income.statusCode).toBe(200);

    /* ---- 4. The pay is already on the ledger ---- */
    /**
     * There used to be a step here, and leaving it out was the whole problem.
     *
     * The paydays above set the dates; a separate paycheque template was what
     * actually put money on the timeline, and nothing said so. A real setup
     * stopped after the paydays and got a ledger of nothing but bills. So the
     * payday now brings its cheque, and this step is gone.
     */
    const ready = await get("/api/setup").then((response) => response.json());
    expect(ready.missing).toEqual([]);

    const cheques = await harness.db.prisma.template.findMany({
      where: { householdId, kind: "paycheque", deletedAt: null },
      select: { defaultCents: true },
    });
    expect(cheques).toHaveLength(2);
    expect(new Set(cheques.map((row) => row.defaultCents))).toEqual(
      new Set([212_500n, 177_500n]),
    );

    /* ---- 5. An expense, biweekly on its own dates ---- */
    const mortgage = await post("/api/templates", {
      name: "Mortgage",
      kind: "bill",
      defaultCents: "103450",
      withdrawal: "auto",
      schedule: { type: "biweekly", anchorDate: "2026-11-06" },
      section: "fixed",
    });
    expect(mortgage.statusCode).toBe(201);

    /* ---- 6. A monthly one, and a budget-only category ---- */
    expect(
      (
        await post("/api/templates", {
          name: "Home insurance",
          kind: "bill",
          defaultCents: "19875",
          withdrawal: "auto",
          schedule: { type: "monthly", day: 10 },
          section: "fixed",
        })
      ).statusCode,
    ).toBe(201);

    expect(
      (
        await post("/api/budget-lines", {
          name: "Groceries",
          section: "variable",
          monthlyCents: "132000",
        })
      ).statusCode,
    ).toBe(201);

    /* ---- 7. The upcoming items already exist ---- */
    // There is no step here any more. Each template write generated its own
    // occurrences, so the explicit endpoint has nothing left to create - which
    // is the whole point of removing the button that used to call it.
    const timelineNow = await get("/api/timeline").then((response) => response.json());
    expect(
      (timelineNow.rows as { name: string }[]).map((row) => row.name),
    ).toContain("Mortgage");

    const generated = await post("/api/templates/generate", {});
    expect(generated.statusCode).toBe(200);
    expect(generated.json().generation.created).toBe(0);

    /* ---- 8. The balance, which now has somewhere to go ---- */
    const balance = await post("/api/balance", { cents: "147300" });
    expect(balance.statusCode).toBe(201);

    /* ---- 9. The ledger works ---- */
    const dashboard = await get("/api/dashboard").then((response) => response.json());
    expect(dashboard.balance.cents).toBe("147300");
    expect(dashboard.nextAutoWithdrawals.length).toBeGreaterThan(0);

    const periods = await get("/api/pay-periods").then((response) => response.json());
    expect(periods.periods.length).toBeGreaterThan(0);

    // Every generated row landed in a window.
    const grouped = (periods.periods as { rows: { id: string }[] }[]).flatMap((period) =>
      period.rows.map((row) => row.id),
    );
    const timeline = await get("/api/timeline").then((response) => response.json());
    for (const row of timeline.rows as { id: string; name: string }[]) {
      expect(grouped, `${row.name} should be in a window`).toContain(row.id);
    }

    /* ---- 10. Savings: its own account, a balance, an earmark ---- */
    const savings = await post("/api/accounts", { name: "Savings", kind: "savings" });
    // The bug this file was written for: this used to be the point of no
    // return, because the chequing account could only be added while there
    // were no accounts at all.
    expect(savings.statusCode).toBe(201);

    expect(
      (await post("/api/balance", { accountId: savings.json().account.id, cents: "438215" }))
        .statusCode,
    ).toBe(201);

    expect((await post("/api/goals", { name: "Trip", savedCents: "300000" })).statusCode).toBe(201);

    /* ---- 11. The mortgage terms, for the payoff projection ---- */
    const terms = await post("/api/mortgage", {
      balanceCents: "17250000",
      asOf: "2026-11-06",
      rateBasisPoints: 449,
      paymentCents: "103450",
      anchorDate: "2026-11-06",
      prepaymentCapCents: "3000000",
    });
    expect(terms.statusCode).toBe(201);

    /* ---- 12. And every screen now has something to say ---- */
    const savingsScreen = await get("/api/savings").then((response) => response.json());
    expect(savingsScreen.balanceCents).toBe("438215");
    expect(savingsScreen.unallocatedCents).toBe("138215");
    expect(savingsScreen.mortgage.plan.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const year = await get("/api/year").then((response) => response.json());
    expect(year.hasMortgage).toBe(true);
    expect((year.months as { isUnusual: boolean }[]).some((month) => month.isUnusual)).toBe(true);

    const budget = await get("/api/budget").then((response) => response.json());
    expect(budget.fixed.lines.length).toBeGreaterThan(0);
    expect(budget.variable.lines.length).toBeGreaterThan(0);
  });

  it("cannot be left with paydays entered and no income on the ledger", async () => {
    /**
     * The state a real setup landed in, and the one that produced a confident
     * wrong answer: paydays entered, bills entered - and a ledger of nothing
     * but bills, every one reported as uncovered, because a pay schedule set
     * DATES and never put money on the timeline.
     *
     * This test used to reproduce that state and check the checklist
     * complained about it. The state is now unreachable over the API, so it
     * checks that instead: the same steps, and nothing to complain about.
     */
    await post("/api/accounts", { name: "Chequing", kind: "chequing" });
    await post("/api/pay-schedules", {
      userId: daxId,
      anchorDate: "2026-11-12",
      defaultCents: "212500",
    });
    await post("/api/templates", {
      name: "Hydro",
      kind: "bill",
      defaultCents: "9800",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 17 },
      section: "fixed",
    });
    // Less in the account than the bill, so being covered has to come from
    // the pay arriving and not from a generous opening balance.
    await post("/api/balance", { cents: "2000" });

    const setup = await get("/api/setup").then((response) => response.json());
    expect(setup.missing).not.toContain("income_on_ledger");

    const dashboard = await get("/api/dashboard").then((response) => response.json());
    expect(dashboard.coverage.allCovered).toBe(true);
    // The figure that was thousands negative in the report.
    expect(BigInt(dashboard.safeToSpendNowCents as string)).toBeGreaterThan(0n);
  });

  it("still says so if the paycheque is archived afterwards", async () => {
    // The one way back into the broken state, and the checklist has to name
    // it - otherwise archiving a cheque silently breaks every figure.
    await post("/api/accounts", { name: "Chequing", kind: "chequing" });
    await post("/api/pay-schedules", {
      userId: daxId,
      anchorDate: "2026-11-12",
      defaultCents: "212500",
    });
    await harness.db.prisma.template.updateMany({
      where: { householdId, kind: "paycheque" },
      data: { active: false },
    });

    const setup = await get("/api/setup").then((response) => response.json());
    expect(setup.missing).toContain("income_on_ledger");
    // And not the wrong diagnosis: a payday DOES exist.
    expect(setup.missing).not.toContain("pay_schedule");
  });

  it("puts an arriving paycheque before the bills that follow it", async () => {
    // The order the ledger reads. A deposit on the 12th belongs above bills
    // dated the 13th onwards, and the running balance has to count it.
    await post("/api/accounts", { name: "Chequing", kind: "chequing" });
    await post("/api/pay-schedules", {
      userId: daxId,
      anchorDate: "2026-11-12",
      defaultCents: "212500",
    });
    await post("/api/templates", {
      name: "Pay",
      kind: "paycheque",
      defaultCents: "212500",
      withdrawal: "auto",
      schedule: { type: "biweekly", anchorDate: "2026-11-12" },
      section: "income",
    });
    for (const [name, day] of [
      ["Hydro", 13],
      ["Phone", 17],
      ["Water", 18],
      ["Internet", 19],
    ] as const) {
      await post("/api/templates", {
        name,
        kind: "bill",
        defaultCents: "9800",
        withdrawal: "auto",
        schedule: { type: "monthly", day },
        section: "fixed",
      });
    }
    await post("/api/templates/generate", {});
    await post("/api/balance", { cents: "20000" });

    const timeline = await get("/api/timeline").then((response) => response.json());
    const dated = (timeline.rows as { name: string; date: string | null }[]).filter(
      (row) => row.date !== null,
    );

    // Dates ascend, whatever the names are.
    for (let index = 1; index < dated.length; index += 1) {
      expect(
        (dated[index]!.date as string) >= (dated[index - 1]!.date as string),
        `${dated[index]!.name} should not come before ${dated[index - 1]!.name}`,
      ).toBe(true);
    }

    // And the pay is above at least one of the bills that follow it.
    const payAt = dated.findIndex((row) => row.name === "Pay");
    const hydroAt = dated.findIndex((row) => row.name === "Hydro");
    if (payAt !== -1 && hydroAt !== -1) {
      expect(payAt).toBeLessThan(hydroAt);
    }
  });

  it("can add the chequing account after the savings one", async () => {
    // The order that used to be a dead end. Nothing makes this an odd way
    // round: someone might well enter savings first.
    const savings = await post("/api/accounts", { name: "Savings", kind: "savings" });
    expect(savings.statusCode).toBe(201);

    const setup = await get("/api/setup").then((response) => response.json());
    // One account exists, and the household is still not set up.
    expect(setup.accounts).toHaveLength(1);
    expect(setup.missing).toContain("account");

    const chequing = await post("/api/accounts", { name: "Chequing", kind: "chequing" });
    expect(chequing.statusCode).toBe(201);

    expect((await get("/api/setup").then((r) => r.json())).missing).not.toContain("account");

    // And the balance goes to the chequing one, not to whichever came first.
    await post("/api/balance", { cents: "147300" });
    expect((await get("/api/dashboard").then((r) => r.json())).balance.cents).toBe("147300");
  });
});
