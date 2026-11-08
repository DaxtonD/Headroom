/**
 * Budget, Goals and Net worth over HTTP, against a real Postgres.
 *
 * The arithmetic already has golden tests in the engine against both seeds, so
 * these check the things only the API can get wrong: that the right rows reach
 * the engine, that shares are of the section rather than of income, that
 * amounts stay integer cents on the wire, and that editing goes through the
 * same versioned, idempotent path as everything else.
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
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

const headers = () => ({ cookie, "idempotency-key": randomUUID() });

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /api/budget", () => {
  async function seedBudget() {
    await harness.app.inject({
      method: "PUT",
      url: "/api/settings/income",
      headers: { ...headers(), "if-match": '"1"' },
      payload: { netMonthlyCents: "900000", netYearlyCents: "10850000" },
    });

    for (const line of [
      { name: "Mortgage", section: "fixed", monthlyCents: "200000" },
      { name: "Saving", section: "fixed", monthlyCents: "200000" },
      { name: "Power", section: "fixed", monthlyCents: "15000" },
      { name: "Food", section: "variable", monthlyCents: "140000" },
      { name: "Gas", section: "variable", monthlyCents: "12000" },
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/budget-lines",
        headers: headers(),
        payload: line,
      });
      expect(response.statusCode, line.name).toBe(201);
    }
  }

  it("totals each section and what is left after everything", async () => {
    await seedBudget();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(body.fixed.monthlyCents).toBe("415000");
    expect(body.variable.monthlyCents).toBe("152000");
    expect(body.totalMonthlyCents).toBe("567000");
    expect(body.balanceMonthlyCents).toBe("333000");

    // Line items are multiplied by twelve...
    expect(body.fixed.yearlyCents).toBe("4980000");
    // ...but the yearly income is Carol's stated figure, which is NOT the
    // monthly one times twelve (section 14 q2).
    expect(body.income.netYearlyCents).toBe("10850000");
    // Fixed 415000 and variable 152000 a month, so 6,804,000 a year, against
    // a stated yearly income of 10,850,000.
    expect(body.variable.yearlyCents).toBe("1824000");
    expect(body.totalYearlyCents).toBe("6804000");
    expect(body.balanceYearlyCents).toBe("4046000");
  });

  it("gives each line its share of its own section, not of income", async () => {
    await seedBudget();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    const mortgage = body.fixed.lines.find((line: { name: string }) => line.name === "Mortgage");
    // 200000 of 415000 fixed is 48%. Of income it would be 22%, which is the
    // mistake this guards against.
    expect(mortgage.sharePct).toBe(48);

    const food = body.variable.lines.find((line: { name: string }) => line.name === "Food");
    expect(food.sharePct).toBe(92);

    // Each section's shares are computed against that section's total.
    const fixedShares = body.fixed.lines.reduce(
      (total: number, line: { sharePct: number }) => total + line.sharePct,
      0,
    );
    expect(fixedShares).toBeGreaterThanOrEqual(99);
  });

  it("carries the id and version of each line, so the UI can edit it", async () => {
    await seedBudget();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    for (const line of [...body.fixed.lines, ...body.variable.lines]) {
      expect(line.id, line.name).toBeTruthy();
      expect(line.version, line.name).toBe(1);
    }
  });

  it("sends every amount as integer cents in a string", async () => {
    await seedBudget();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    for (const value of [
      body.totalMonthlyCents,
      body.totalYearlyCents,
      body.balanceMonthlyCents,
      body.fixed.monthlyCents,
      body.variable.yearlyCents,
      body.income.netMonthlyCents,
    ]) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^-?\d+$/);
    }
  });

  it("is all zeroes for a household that has entered nothing", async () => {
    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(body.totalMonthlyCents).toBe("0");
    expect(body.balanceMonthlyCents).toBe("0");
    expect(body.fixed.lines).toEqual([]);
  });

  it("uses a yearly override where twelve times monthly is wrong", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/budget-lines",
      headers: headers(),
      payload: {
        name: "Property tax",
        section: "fixed",
        monthlyCents: "30000",
        yearlyCentsOverride: "350000",
      },
    });
    expect(created.statusCode).toBe(201);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());

    expect(body.fixed.monthlyCents).toBe("30000");
    expect(body.fixed.yearlyCents).toBe("350000");
  });
});

describe("budget line editing", () => {
  it("changes an amount under the usual version check", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/budget-lines",
        headers: headers(),
        payload: { name: "Power", section: "fixed", monthlyCents: "15000" },
      })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/budget-lines/${created.line.id}`,
      headers: { ...headers(), "if-match": '"1"' },
      payload: { monthlyCents: "17250" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().line.monthlyCents).toBe("17250");
    expect(patched.json().line.version).toBe(2);
  });

  it("refuses an edit with no version", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/budget-lines",
        headers: headers(),
        payload: { name: "Power", section: "fixed", monthlyCents: "15000" },
      })
      .then((response) => response.json());

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/budget-lines/${created.line.id}`,
      headers: headers(),
      payload: { monthlyCents: "17250" },
    });

    expect(patched.statusCode).toBe(428);
  });

  it("refuses a decimal amount, like every other money field", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/budget-lines",
      headers: headers(),
      payload: { name: "Power", section: "fixed", monthlyCents: "150.00" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/integer cents/);
  });

  it("removes a line without erasing it, and drops it from the totals", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/budget-lines",
        headers: headers(),
        payload: { name: "Netflix", section: "fixed", monthlyCents: "2000" },
      })
      .then((response) => response.json());

    const deleted = await harness.app.inject({
      method: "DELETE",
      url: `/api/budget-lines/${created.line.id}`,
      headers: { ...headers(), "if-match": '"1"' },
    });
    expect(deleted.statusCode).toBe(200);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/budget", headers: { cookie } })
      .then((response) => response.json());
    expect(body.fixed.lines).toEqual([]);

    // Soft delete: the row and its history survive (section 8).
    const row = await harness.db.prisma.budgetLine.findUniqueOrThrow({
      where: { id: created.line.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedById).toBe(carolId);
  });
});

/* -------------------------------------------------------------------------- */
/* Goals, reimbursements, banked hours                                        */
/* -------------------------------------------------------------------------- */

describe("GET /api/goals-overview", () => {
  it("reports progress on a goal", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Trip", targetCents: "240000", savedCents: "180000" },
    });
    expect(created.statusCode).toBe(201);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    expect(body.goals[0].remainingCents).toBe("60000");
    expect(body.goals[0].pct).toBe(75);
  });

  it("refuses a target of zero, which is different from having none", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Nothing", targetCents: "0" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts a goal with no target at all", async () => {
    // The trip case. Dax, 2026-11-08: "Trips never have a set date or set
    // cost." Nothing to be a fraction of, so no remaining and no percentage -
    // and null rather than "0", because they mean different things.
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Trip", savedCents: "438215" },
    });
    expect(created.statusCode).toBe(201);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    const goal = body.goals.find((candidate: { name: string }) => candidate.name === "Trip");
    expect(goal.targetCents).toBeNull();
    expect(goal.remainingCents).toBeNull();
    expect(goal.pct).toBeNull();
    expect(goal.savedCents).toBe("438215");
    expect(goal.isMet).toBe(false);
  });

  it("accepts an explicit null target, so a client can clear one", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/goals",
        headers: headers(),
        payload: { name: "Open ended", targetCents: null, savedCents: "1000" },
      })
      .then((response) => response.json());

    const cleared = await harness.app.inject({
      method: "PATCH",
      url: `/api/goals/${created.goal.id}`,
      headers: { ...headers(), "if-match": `"${String(created.goal.version)}"` },
      payload: { targetCents: "50000" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().goal.targetCents).toBe("50000");

    const reopened = await harness.app.inject({
      method: "PATCH",
      url: `/api/goals/${created.goal.id}`,
      headers: { ...headers(), "if-match": `"${String(cleared.json().goal.version)}"` },
      payload: { targetCents: null },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().goal.targetCents).toBeNull();
  });

  it("marks a goal met once it reaches its target, and never goes past 100% of nothing", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Overshot", targetCents: "10000", savedCents: "12000" },
    });
    expect(created.statusCode).toBe(201);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    const goal = body.goals.find((candidate: { name: string }) => candidate.name === "Overshot");
    // Clamped at zero: "met" is what a screen wants to say, and how far past is
    // still recoverable from the two amounts.
    expect(goal.remainingCents).toBe("0");
    expect(goal.isMet).toBe(true);
    expect(goal.pct).toBe(120);
  });

  it("carries a purpose, so the savings screen can find the mortgage pot", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Lump sum", purpose: "mortgage_lump_sum", savedCents: "0" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().goal.purpose).toBe("mortgage_lump_sum");
  });

  it("defaults the purpose to general", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: headers(),
      payload: { name: "Something else", savedCents: "0" },
    });

    expect(created.json().goal.purpose).toBe("general");
  });

  it("tracks a work expense from bought to submitted to paid back", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/reimbursements",
        headers: headers(),
        payload: { purchase: "Drill bits", cents: "12000", boughtOn: "2026-11-03" },
      })
      .then((response) => response.json());

    expect(created.reimbursement.status).toBe("bought");

    const submitted = await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${created.reimbursement.id}`,
      headers: { ...headers(), "if-match": '"1"' },
      payload: { submitted: true },
    });
    expect(submitted.json().reimbursement.status).toBe("submitted");

    const paid = await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${created.reimbursement.id}`,
      headers: { ...headers(), "if-match": '"2"' },
      payload: { paid: true },
    });
    expect(paid.json().reimbursement.status).toBe("paid");

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    // Paid back, so nothing is outstanding.
    expect(body.reimbursements.outstandingCents).toBe("0");
    expect(body.reimbursements.paidCents).toBe("12000");
    expect(body.reimbursements.totalCents).toBe("12000");
  });

  it("totals what the employer still owes", async () => {
    for (const item of [
      { purchase: "Cable", cents: "5000", boughtOn: "2026-11-01" },
      { purchase: "Fittings", cents: "8000", boughtOn: "2026-11-02" },
    ]) {
      await harness.app.inject({
        method: "POST",
        url: "/api/reimbursements",
        headers: headers(),
        payload: item,
      });
    }

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    expect(body.reimbursements.outstandingCents).toBe("13000");
  });

  it("re-marking an expense is a no-op", async () => {
    const created = await harness.app
      .inject({
        method: "POST",
        url: "/api/reimbursements",
        headers: headers(),
        payload: { purchase: "Cable", cents: "5000", boughtOn: "2026-11-01" },
      })
      .then((response) => response.json());

    await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${created.reimbursement.id}`,
      headers: { ...headers(), "if-match": '"1"' },
      payload: { submitted: true },
    });

    const again = await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${created.reimbursement.id}`,
      headers: { ...headers(), "if-match": '"2"' },
      payload: { submitted: true },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json().noop).toBe(true);
    expect(again.json().reimbursement.version).toBe(2);
  });

  it("keeps banked hours per person, in hours and never in money", async () => {
    const dax = await harness.db.prisma.user.findFirstOrThrow({
      where: { householdId, email: "dax@example.test" },
    });

    for (const entry of [
      { userId: carolId, hours: "7.5" },
      { userId: carolId, hours: "0.25" },
      { userId: dax.id, hours: "4" },
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/banked-hours",
        headers: headers(),
        payload: entry,
      });
      expect(response.statusCode).toBe(201);
    }

    const body = await harness.app
      .inject({ method: "GET", url: "/api/goals-overview", headers: { cookie } })
      .then((response) => response.json());

    expect(body.bankedHours.total).toBe("11.75");

    const carol = body.bankedHours.perPerson.find((p: { initial: string }) => p.initial === "C");
    expect(carol.hours).toBe("7.75");
    const daxHours = body.bankedHours.perPerson.find((p: { initial: string }) => p.initial === "D");
    expect(daxHours.hours).toBe("4.00");
  });

  it("refuses hours for someone outside the household", async () => {
    const other = await harness.db.prisma.household.create({ data: { name: "Elsewhere" } });
    const stranger = await harness.db.prisma.user.create({
      data: {
        householdId: other.id,
        name: "Stranger",
        initial: "S",
        email: "stranger@example.test",
        passwordHash: "x",
      },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/banked-hours",
      headers: headers(),
      payload: { userId: stranger.id, hours: "1" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses hours that are not hours", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/banked-hours",
      headers: headers(),
      payload: { userId: carolId, hours: "seven and a half" },
    });

    expect(response.statusCode).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Net worth and retirement                                                   */
/* -------------------------------------------------------------------------- */

describe("GET /api/net-worth", () => {
  async function seedAssets() {
    for (const entry of [
      { kind: "asset", name: "Home", cents: "40000000" },
      { kind: "asset", name: "RRSPs", cents: "15000000" },
      { kind: "liability", name: "Mortgage", cents: "14000000" },
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/assets",
        headers: headers(),
        payload: entry,
      });
      expect(response.statusCode, entry.name).toBe(201);
    }
  }

  it("subtracts what is owed from what is owned", async () => {
    await seedAssets();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/net-worth", headers: { cookie } })
      .then((response) => response.json());

    expect(body.assetsCents).toBe("55000000");
    expect(body.liabilitiesCents).toBe("14000000");
    expect(body.netWorthCents).toBe("41000000");
    expect(body.assets).toHaveLength(2);
    expect(body.liabilities).toHaveLength(1);
  });

  it("insists both sides are entered without a minus sign", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/assets",
      headers: headers(),
      payload: { kind: "liability", name: "Mortgage", cents: "-14000000" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/without a minus/);
  });

  it("has no retirement figures until the assumptions are set", async () => {
    await seedAssets();

    const body = await harness.app
      .inject({ method: "GET", url: "/api/net-worth", headers: { cookie } })
      .then((response) => response.json());

    expect(body.retirement).toBeNull();
  });

  it("reproduces the retirement chain once the assumptions are set", async () => {
    await seedAssets();

    const saved = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/retirement",
      headers: headers(),
      payload: {
        rrspCurrentPlusContribCents: "30000000",
        mortgageMonthlyCents: "200000",
        redirectYears: 16,
        flatGrowthPct: 10,
        drawdownYears: 25,
        govPensionAnnualCents: "2000000",
        retirementExpensesAnnualCents: "2200000",
      },
    });
    expect(saved.statusCode).toBe(201);

    const body = await harness.app
      .inject({ method: "GET", url: "/api/net-worth", headers: { cookie } })
      .then((response) => response.json());

    const retirement = body.retirement;
    // 200000 x 12 x 16 redirected, grown once by a flat 10%.
    expect(retirement.mortgageRedirectCents).toBe("38400000");
    expect(retirement.baseBeforeGrowthCents).toBe("68400000");
    expect(retirement.rrspAt65Cents).toBe("75240000");
    expect(retirement.annualDrawCents).toBe("3009600");
    expect(retirement.extraPerMonthCents).toBe("234133");
    // Net worth plus the RRSPs at 65.
    expect(retirement.totalForRetirementCents).toBe((41_000_000n + 75_240_000n).toString());
  });

  it("every assumption is editable, and compounding is off by default", async () => {
    await harness.app.inject({
      method: "PUT",
      url: "/api/settings/retirement",
      headers: headers(),
      payload: {
        rrspCurrentPlusContribCents: "30000000",
        mortgageMonthlyCents: "200000",
        redirectYears: 16,
        flatGrowthPct: 10,
        drawdownYears: 25,
        govPensionAnnualCents: "2000000",
        retirementExpensesAnnualCents: "2200000",
      },
    });

    const before = await harness.app
      .inject({ method: "GET", url: "/api/net-worth", headers: { cookie } })
      .then((response) => response.json());
    expect(before.retirement.inputs.compoundYearly).toBe(false);

    const updated = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/retirement",
      headers: { ...headers(), "if-match": `"${before.retirement.inputs.version}"` },
      payload: {
        rrspCurrentPlusContribCents: "30000000",
        mortgageMonthlyCents: "200000",
        redirectYears: 16,
        flatGrowthPct: 10,
        compoundYearly: true,
        drawdownYears: 25,
        govPensionAnnualCents: "2000000",
        retirementExpensesAnnualCents: "2200000",
      },
    });
    expect(updated.statusCode).toBe(200);

    const after = await harness.app
      .inject({ method: "GET", url: "/api/net-worth", headers: { cookie } })
      .then((response) => response.json());

    expect(after.retirement.inputs.compoundYearly).toBe(true);
    // Compounding for sixteen years is a much larger number than one flat 10%.
    expect(BigInt(after.retirement.rrspAt65Cents) > BigInt(before.retirement.rrspAt65Cents)).toBe(true);
  });

  it("refuses a drawdown of zero years rather than dividing by it", async () => {
    const response = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/retirement",
      headers: headers(),
      payload: {
        rrspCurrentPlusContribCents: "30000000",
        mortgageMonthlyCents: "200000",
        redirectYears: 16,
        flatGrowthPct: 10,
        drawdownYears: 0,
        govPensionAnnualCents: "2000000",
        retirementExpensesAnnualCents: "2200000",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("needs a version once the assumptions already exist", async () => {
    const payload = {
      rrspCurrentPlusContribCents: "30000000",
      mortgageMonthlyCents: "200000",
      redirectYears: 16,
      flatGrowthPct: 10,
      drawdownYears: 25,
      govPensionAnnualCents: "2000000",
      retirementExpensesAnnualCents: "2200000",
    };

    // The first write has nothing to conflict with.
    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: "/api/settings/retirement",
          headers: headers(),
          payload,
        })
      ).statusCode,
    ).toBe(201);

    // The second does.
    const second = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/retirement",
      headers: headers(),
      payload: { ...payload, redirectYears: 20 },
    });
    expect(second.statusCode).toBe(428);
  });
});

describe("these routes all need a session", () => {
  it("refuses every one of them when signed out", async () => {
    for (const [method, url] of [
      ["GET", "/api/budget"],
      ["GET", "/api/budget-lines"],
      ["GET", "/api/goals-overview"],
      ["GET", "/api/net-worth"],
    ] as const) {
      expect((await harness.app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});
