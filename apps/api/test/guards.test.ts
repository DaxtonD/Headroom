/**
 * The database's own integrity guards (HANDOFF section 16.1 rule 9).
 *
 * These assert what Postgres refuses, not what the application refuses. A bug
 * in a route must not be able to rewrite a balance snapshot, erase history, or
 * store an occurrence that the timeline cannot order.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VERSIONED_ENTITIES } from "../src/lib/versioning.js";
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
      data: { accountId: account.id, cents: 41_000n, asOf: new Date(), enteredById: carol.id },
    });

    expect(await harness.db.prisma.balanceSnapshot.count()).toBe(1);
  });

  it("refuses an UPDATE: a correction is a new snapshot", async () => {
    const { account, carol } = await seedHousehold(harness);
    const snapshot = await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 41_000n, asOf: new Date(), enteredById: carol.id },
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
      data: { accountId: account.id, cents: 41_000n, asOf: new Date(), enteredById: carol.id },
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
      data: { accountId: account.id, cents: 41_000n, asOf: earlier, enteredById: carol.id },
    });
    await harness.db.prisma.balanceSnapshot.create({
      data: { accountId: account.id, cents: 52_750n, asOf: later, enteredById: carol.id },
    });

    const latest = await harness.db.prisma.balanceSnapshot.findFirst({
      where: { accountId: account.id },
      orderBy: { asOf: "desc" },
    });

    expect(latest?.cents).toBe(52_750n);
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
        cents: -21_500n,
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
        cents: -12_345n,
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
          cents: -98_765n,
          kind: "bill",
          withdrawal: "auto",
        },
      }),
    ).rejects.toThrow(/occurrence_placed_one_way/);
  });

  it("accepts a flexible item on the day it is planned for", async () => {
    // "Monthly, but I choose when to pay it" with a day chosen. The household
    // decides the date, so it is still flexible - but it belongs on that day
    // of the ledger, against the balance it will come out of.
    const { household } = await seedHousehold(harness);

    const occurrence = await harness.db.prisma.occurrence.create({
      data: {
        householdId: household.id,
        name: "Water",
        cents: -14_400n,
        kind: "bill",
        withdrawal: "flexible",
        date: new Date("2026-11-19"),
      },
    });

    expect(occurrence.withdrawal).toBe("flexible");
    expect(occurrence.date).not.toBeNull();
  });

  it("refuses a flexible item placed on a date and a payday at once", async () => {
    const { household } = await seedHousehold(harness);

    const payday = await harness.db.prisma.occurrence.create({
      data: {
        householdId: household.id,
        name: "Pay",
        cents: 200_000n,
        kind: "paycheque",
        withdrawal: "auto",
        date: new Date("2026-11-12"),
      },
    });

    // One or the other. Both would leave the running balance with no answer
    // to where this row goes.
    await expect(
      harness.db.prisma.occurrence.create({
        data: {
          householdId: household.id,
          name: "Water",
          cents: -14_400n,
          kind: "bill",
          withdrawal: "flexible",
          date: new Date("2026-11-19"),
          anchorOccurrenceId: payday.id,
        },
      }),
    ).rejects.toThrow(/occurrence_placed_one_way/);
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
        cents: -12_345n,
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
        defaultCents: 12_345n,
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
      cents: -12_345n,
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

/* -------------------------------------------------------------------------- */
/* Every versioned entity can actually be locked                              */
/* -------------------------------------------------------------------------- */

/**
 * A guard on the concurrency machinery itself.
 *
 * `applyVersionedChange` locks a row with `SELECT ... FOR UPDATE`, and it finds
 * the table through a hand-written map keyed by a plain string. Nothing in the
 * type system connects the two, so a new versioned model compiles, creates
 * fine, and then fails on its first edit with "no lockable table registered" -
 * which is exactly what the mortgage did.
 *
 * So this reads the schema instead of trusting anyone to remember: any model
 * carrying a `version` column is one that gets edited, and must be lockable.
 */
describe("the versioned-entity map", () => {
  const schema = readFileSync(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );

  const versionedTables = [...schema.matchAll(/model\s+\w+\s*\{([\s\S]*?)\n\}/g)]
    .map((match) => match[1] as string)
    .filter((block) => /^\s*version\s+Int/m.test(block))
    .map((block) => /@@map\("([^"]+)"\)/.exec(block)?.[1])
    .filter((table): table is string => table !== undefined);

  it("finds the versioned models in the schema", () => {
    // If this ever reads nothing, the regex has stopped matching and the whole
    // guard would pass silently.
    expect(versionedTables.length).toBeGreaterThan(8);
    expect(versionedTables).toContain("mortgage");
  });

  it("can lock every model that carries a version", () => {
    const registered = new Set(
      Object.values(VERSIONED_ENTITIES).map((target) => target.table),
    );
    const missing = versionedTables.filter((table) => !registered.has(table));

    expect(missing).toEqual([]);
  });

  it("registers nothing that is not a real table", () => {
    const inSchema = new Set(
      [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((match) => match[1] as string),
    );
    const unknown = Object.values(VERSIONED_ENTITIES)
      .map((target) => target.table)
      .filter((table) => !inSchema.has(table));

    expect(unknown).toEqual([]);
  });
});
