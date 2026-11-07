/**
 * The database's own integrity guards (HANDOFF section 16.1 rule 9).
 *
 * These assert what Postgres refuses, not what the application refuses. A bug
 * in a route must not be able to rewrite a balance snapshot, erase history, or
 * store an occurrence that the timeline cannot order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, type Harness } from "./helpers/harness.js";

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe("balance_snapshot is insert-only", () => {
  it("accepts new snapshots", async () => {
    const { account, carol } = await seedHousehold(harness);

    await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 53_000n, asOf: new Date(), enteredById: carol.id },
    });

    expect(await harness.db.prisma.balanceSnapshot.count()).toBe(1);
  });

  it("refuses an UPDATE: a correction is a new snapshot", async () => {
    const { account, carol } = await seedHousehold(harness);
    const snapshot = await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 53_000n, asOf: new Date(), enteredById: carol.id },
    });

    await expect(
      harness.db.pool.query(`UPDATE "balance_snapshot" SET "cents" = 1 WHERE "id" = $1`, [
        snapshot.id,
      ]),
    ).rejects.toThrow(/insert-only/i);
  });

  it("refuses a DELETE", async () => {
    const { account, carol } = await seedHousehold(harness);
    const snapshot = await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 53_000n, asOf: new Date(), enteredById: carol.id },
    });

    await expect(
      harness.db.pool.query(`DELETE FROM "balance_snapshot" WHERE "id" = $1`, [snapshot.id]),
    ).rejects.toThrow(/insert-only/i);
  });

  it("keeps the latest as_of as the one that counts", async () => {
    const { account, carol } = await seedHousehold(harness);

    const earlier = new Date("2026-11-07T09:58:00-06:00");
    const later = new Date("2026-11-07T18:30:00-06:00");

    await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 53_000n, asOf: earlier, enteredById: carol.id },
    });
    await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 61_250n, asOf: later, enteredById: carol.id },
    });

    const latest = await harness.db.prisma.balanceSnapshot.findFirst({
      where: { accountId: account.id },
      orderBy: { asOf: "desc" },
    });

    expect(latest?.cents).toBe(61_250n);
    // Both rows survive: the history is the audit trail.
    expect(await harness.db.prisma.balanceSnapshot.count()).toBe(2);
  });
});

describe("activity is append-only", () => {
  it("refuses an UPDATE or a DELETE", async () => {
    const { household, carol } = await seedHousehold(harness);

    const activity = await harness.db.prisma.activity.create({
      data: {
        householdId: household.id,
        userId: carol.id,
        action: "create",
        entity: "occurrence",
        entityId: carol.id,
        versionAfter: 1,
        fields: ["cents"],
      },
    });

    await expect(
      harness.db.pool.query(`UPDATE "activity" SET "entity" = 'x' WHERE "id" = $1`, [activity.id]),
    ).rejects.toThrow(/insert-only/i);

    await expect(
      harness.db.pool.query(`DELETE FROM "activity" WHERE "id" = $1`, [activity.id]),
    ).rejects.toThrow(/insert-only/i);
  });
});

describe("occurrence shape", () => {
  it("accepts a dated automatic withdrawal", async () => {
    const { household } = await seedHousehold(harness);

    const occurrence = await harness.db.prisma.occurrence.create({
      data: {
        householdId: household.id,
        name: "Home insurance",
        cents: -24_260n,
        kind: "bill",
        withdrawal: "auto",
        date: new Date("2026-11-17"),
      },
    });

    expect(occurrence.date).not.toBeNull();
  });

  it("accepts an undated flexible bill", async () => {
    const { household } = await seedHousehold(harness);

    const occurrence = await harness.db.prisma.occurrence.create({
      data: {
        householdId: household.id,
        name: "Power",
        cents: -18_600n,
        kind: "bill",
        withdrawal: "flexible",
      },
    });

    expect(occurrence.date).toBeNull();
  });

  it("refuses an automatic withdrawal with no date, which could not be ordered", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.prisma.occurrence.create({
        data: {
          householdId: household.id,
          name: "Mortgage",
          cents: -115_887n,
          kind: "bill",
          withdrawal: "auto",
        },
      }),
    ).rejects.toThrow(/occurrence_dated_xor_flexible/);
  });

  it("refuses a flexible item that also carries a date", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.prisma.occurrence.create({
        data: {
          householdId: household.id,
          name: "Water",
          cents: -18_000n,
          kind: "bill",
          withdrawal: "flexible",
          date: new Date("2026-11-19"),
        },
      }),
    ).rejects.toThrow(/occurrence_dated_xor_flexible/);
  });

  it("refuses a blank name", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.prisma.occurrence.create({
        data: {
          householdId: household.id,
          name: "   ",
          cents: -100n,
          kind: "bill",
          withdrawal: "flexible",
        },
      }),
    ).rejects.toThrow(/occurrence_name_present/);
  });

  it("refuses a half-recorded verification", async () => {
    const { household } = await seedHousehold(harness);
    const occurrence = await harness.db.prisma.occurrence.create({
      data: {
        householdId: household.id,
        name: "Power",
        cents: -18_600n,
        kind: "bill",
        withdrawal: "flexible",
      },
    });

    // "Who verified this?" must always have an answer.
    await expect(
      harness.db.pool.query(`UPDATE "occurrence" SET "verifiedAt" = now() WHERE "id" = $1`, [
        occurrence.id,
      ]),
    ).rejects.toThrow(/occurrence_verified_pair/);
  });

  it("stops the same recurrence being generated twice", async () => {
    const { household } = await seedHousehold(harness);

    const template = await harness.db.prisma.template.create({
      data: {
        householdId: household.id,
        kind: "bill",
        name: "Power",
        defaultCents: 18_600n,
        withdrawal: "flexible",
        scheduleType: "flexible",
        scheduleJson: { frequency: "monthly" },
      },
    });

    const row = {
      householdId: household.id,
      templateId: template.id,
      periodKey: "2026-11",
      name: "Power",
      cents: -18_600n,
      kind: "bill" as const,
      withdrawal: "flexible" as const,
    };

    await harness.db.prisma.occurrence.create({ data: row });

    // This is what protects recurrence generation from running concurrently
    // (HANDOFF section 16.8).
    await expect(harness.db.prisma.occurrence.create({ data: row })).rejects.toThrow();
    expect(await harness.db.prisma.occurrence.count()).toBe(1);
  });
});

describe("value guards", () => {
  it("refuses a version of zero, which would make If-Match meaningless", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.pool.query(`UPDATE "household" SET "version" = 0 WHERE "id" = $1`, [household.id]),
    ).rejects.toThrow(/household_version_positive/);
  });

  it("refuses a negative cushion", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.pool.query(`UPDATE "household" SET "cushionCents" = -1 WHERE "id" = $1`, [
        household.id,
      ]),
    ).rejects.toThrow(/household_cushion_non_negative/);
  });

  it("refuses a goal with no target", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.prisma.goal.create({
        data: { householdId: household.id, name: "Trip fund", targetCents: 0n },
      }),
    ).rejects.toThrow(/goal_amounts_sane/);
  });

  it("refuses a drawdown of zero years, which the engine would divide by", async () => {
    const { household } = await seedHousehold(harness);

    await expect(
      harness.db.prisma.retirementSettings.create({
        data: {
          householdId: household.id,
          rrspCurrentPlusContribCents: 1n,
          mortgageMonthlyCents: 1n,
          redirectYears: 16,
          flatGrowthPct: 10,
          drawdownYears: 0,
          govPensionAnnualCents: 1n,
          retirementExpensesAnnualCents: 1n,
        },
      }),
    ).rejects.toThrow(/retirement_settings_sane/);
  });

  it("keeps money as exact integer cents past the float limit", async () => {
    const { household } = await seedHousehold(harness);

    // Far beyond Number.MAX_SAFE_INTEGER: a float column would round this.
    const huge = 9_007_199_254_740_993n;
    const asset = await harness.db.prisma.asset.create({
      data: { householdId: household.id, kind: "asset", name: "Exactness check", cents: huge },
    });

    const reread = await harness.db.prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.cents).toBe(huge);
    expect(typeof reread.cents).toBe("bigint");
  });
});
