/**
 * The balance somebody just typed is the balance the app shows.
 *
 * Found in production, not by a test. One snapshot carried an `asOf` almost
 * four hours in the future - written while the host clock was wrong, and
 * since corrected. Every screen picks the snapshot with the latest `asOf`,
 * so that one row outranked everything entered afterwards: the household
 * could type the right figure, get a 201 back, and watch Home go on showing
 * the old one.
 *
 * It would have cleared itself once real time caught up, which is the part
 * that makes it dangerous. A bug that fixes itself overnight is a bug nobody
 * can reproduce in the morning, and the only visible symptom - "I typed it
 * and nothing happened" - reads as the app having lost the entry.
 *
 * The write path now guarantees the ordering instead of hoping for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

async function post(cookie: string, accountId: string, cents: string): Promise<number> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/balance",
    headers: { cookie, "idempotency-key": crypto.randomUUID() },
    payload: { accountId, cents },
  });
  return response.statusCode;
}

async function shown(cookie: string): Promise<string> {
  const response = await harness.app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { balance: { cents: string } }).balance.cents;
}

describe("a new balance always wins", () => {
  it("beats one dated in the future by a clock that was wrong", async () => {
    const { alex, account } = await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    // The shape of the production row: written now, stamped four hours
    // ahead. The amount is invented - a real one may not reach this repo.
    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId: account.id,
        cents: 43210n,
        asOf: new Date(Date.now() + 4 * 60 * 60 * 1000),
        enteredById: alex.id,
      },
    });
    expect(await shown(cookie)).toBe("43210");

    expect(await post(cookie, account.id, "111111")).toBe(201);
    expect(await shown(cookie), "the figure just typed is not the one on screen").toBe("111111");
  });

  it("keeps winning, entry after entry, while the clock is still ahead", async () => {
    // One correction is not the case that matters. Typing a figure, spotting
    // a typo and typing it again is, and the second must beat the first.
    const { alex, account } = await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId: account.id,
        cents: 1n,
        asOf: new Date(Date.now() + 4 * 60 * 60 * 1000),
        enteredById: alex.id,
      },
    });

    for (const cents of ["111111", "222222", "333333"]) {
      expect(await post(cookie, account.id, cents)).toBe(201);
      expect(await shown(cookie)).toBe(cents);
    }
  });

  it("leaves the ordinary case alone - no future dates out of nowhere", async () => {
    /*
     * The nudge applies only when the newest snapshot is genuinely ahead of
     * the clock. With a healthy clock, `asOf` is the moment it was entered,
     * which is what the screen means when it says "as of".
     */
    const { account } = await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const before = Date.now();
    expect(await post(cookie, account.id, "5000")).toBe(201);
    const after = Date.now();

    const row = await harness.db.prisma.balanceSnapshot.findFirstOrThrow({
      where: { accountId: account.id },
      orderBy: { asOf: "desc" },
    });

    expect(row.asOf.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.asOf.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("does not let one account's bad clock push another's forward", async () => {
    const { household, alex, account } = await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const savings = await harness.db.prisma.account.create({
      data: { householdId: household.id, name: "Savings", kind: "savings" },
    });

    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId: account.id,
        cents: 1n,
        asOf: new Date(Date.now() + 4 * 60 * 60 * 1000),
        enteredById: alex.id,
      },
    });

    expect(await post(cookie, savings.id, "7000")).toBe(201);

    const row = await harness.db.prisma.balanceSnapshot.findFirstOrThrow({
      where: { accountId: savings.id },
      orderBy: { asOf: "desc" },
    });
    expect(row.asOf.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
