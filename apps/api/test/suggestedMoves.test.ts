/**
 * "Move Hydro to Dec 9 and it clears", end to end.
 *
 * Whether a suggestion is *right* is tested as behaviour in
 * `packages/core/test/suggestMoves.test.ts`, which applies each one and runs
 * the whole timeline again. This file exists for the one thing a core test
 * cannot reach: **what the API feeds the engine.**
 *
 * Three inputs decide every suggestion, and a mistake in any of them produces
 * confident, wrong advice rather than an error:
 *
 *  - the **events**, which must be the household's real occurrences;
 *  - the **starting balance**, which must be the effective one - the figure
 *    somebody typed in, plus anything settled since - and not the raw
 *    snapshot;
 *  - the **account**, which must be chequing, or a card's charges would read
 *    as money that could be moved out of the way.
 *
 * Nothing here hardcodes a calendar date. Every figure in this app is built
 * from "today", and a fixture pinned to a particular November would pass in
 * one week and fail in the next - which is what `PIN_DATE` exists to catch.
 * So the dates are built relative to the `today` the server reports.
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
});

interface DashboardBody {
  readonly today: string;
  readonly coverage: { readonly allCovered: boolean };
  readonly suggestedMoves: readonly {
    readonly eventId: string;
    readonly name: string;
    readonly toDate: string;
    readonly toAnchorId: string;
    readonly clearsName: string;
    readonly cents: string;
    readonly lowestAfterCents: string;
  }[];
}

async function dashboard(): Promise<DashboardBody> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as DashboardBody;
}

/** A plain date `days` after `from`, with no timezone in it. */
function plus(from: string, days: number): string {
  const at = new Date(`${from}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

const asDate = (plain: string): Date => new Date(`${plain}T00:00:00.000Z`);

/**
 * A fortnight that cannot cover its rent, and one flexible bill in the way.
 *
 * Opening 500.00, pay of 1,000.00, a 600.00 Visa payment hanging off that
 * cheque, then rent of 1,000.00 taken automatically the next day - which
 * leaves it 100.00 short. A second cheque a fortnight later is somewhere for
 * the Visa payment to go.
 */
async function arrangeShortfall(): Promise<{ today: string; visaId: string; secondPayId: string }> {
  const { today } = await dashboard();
  const householdId = seeded.household.id;

  /*
   * An hour ago, not "now", and that is not cosmetic.
   *
   * The effective balance is the typed-in figure plus everything settled
   * SINCE it was typed, so a row cleared in the same millisecond as the
   * snapshot does not count. With both at `new Date()` the settled-money test
   * below passed or failed on a race of milliseconds - it failed once in a
   * run pinned to a later date, which looked like a calendar bug and was not.
   * The database clock is not faked by `PIN_DATE`, so the fix is an explicit
   * ordering rather than a pinned instant.
   */
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await harness.db.prisma.balanceSnapshot.create({
    data: {
      accountId: seeded.account.id,
      cents: 50_000n,
      asOf: anHourAgo,
      enteredById: seeded.alex.id,
    },
  });

  await harness.db.prisma.paySchedule.create({
    data: { userId: seeded.alex.id, anchorDate: asDate(plus(today, 4)), defaultCents: 100_000n },
  });

  const firstPay = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Pay",
      cents: 100_000n,
      kind: "paycheque",
      withdrawal: "auto",
      date: asDate(plus(today, 4)),
      sortIndex: 0,
    },
  });

  const secondPay = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Pay",
      cents: 100_000n,
      kind: "paycheque",
      withdrawal: "auto",
      date: asDate(plus(today, 18)),
      sortIndex: 0,
    },
  });

  const visa = await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Visa payment",
      cents: -60_000n,
      kind: "bill",
      withdrawal: "flexible",
      anchorOccurrenceId: firstPay.id,
      sortIndex: 1,
    },
  });

  await harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name: "Rent",
      cents: -100_000n,
      kind: "bill",
      withdrawal: "auto",
      date: asDate(plus(today, 5)),
      sortIndex: 2,
    },
  });

  return { today, visaId: visa.id, secondPayId: secondPay.id };
}

describe("a fortnight that cannot cover its rent", () => {
  it("says which bill to move, and to which payday", async () => {
    const { today, visaId, secondPayId } = await arrangeShortfall();
    const view = await dashboard();

    expect(view.coverage.allCovered).toBe(false);
    expect(view.suggestedMoves).toHaveLength(1);

    const [move] = view.suggestedMoves;
    expect(move?.eventId).toBe(visaId);
    expect(move?.name).toBe("Visa payment");
    expect(move?.clearsName).toBe("Rent");
    expect(move?.toAnchorId).toBe(secondPayId);
    expect(move?.toDate).toBe(plus(today, 18));
  });

  it("sends the figures as strings, like every other amount", async () => {
    // `bigint` cannot be serialised, so cents cross the wire as decimal
    // strings. A number here would be a precision bug waiting for a big one.
    await arrangeShortfall();
    const [move] = (await dashboard()).suggestedMoves;

    expect(move?.cents).toBe("60000");
    expect(typeof move?.lowestAfterCents).toBe("string");
  });

  it("is actually true: making the move clears the warning", async () => {
    /*
     * The assertion that makes this whole feature trustworthy. The suggestion
     * is applied through the real PATCH route - the same one the button
     * opens - and coverage is asked again.
     *
     * It also proves the simulation matches the write: anchoring a row drops
     * its planned date, and the engine refuses a row that has both, so a
     * mismatch here would surface as a 500 rather than as a wrong figure.
     */
    const { visaId } = await arrangeShortfall();
    const [move] = (await dashboard()).suggestedMoves;

    const existing = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: visaId },
      select: { version: true },
    });

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${visaId}`,
      headers: {
        cookie,
        "if-match": String(existing.version),
        "idempotency-key": randomUUID(),
      },
      payload: { anchorOccurrenceId: move?.toAnchorId },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const after = await dashboard();
    expect(after.coverage.allCovered).toBe(true);
    expect(after.suggestedMoves).toEqual([]);
  });
});

describe("a fortnight with nothing wrong with it", () => {
  it("suggests nothing", async () => {
    // The common case. The first timeline run answers it, so this costs
    // nothing on an ordinary load of the screen.
    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId: seeded.account.id,
        cents: 500_000n,
        asOf: new Date(),
        enteredById: seeded.alex.id,
      },
    });

    const view = await dashboard();
    expect(view.coverage.allCovered).toBe(true);
    expect(view.suggestedMoves).toEqual([]);
  });
});

describe("what it is fed", () => {
  it("counts money already settled, not just the typed-in figure", async () => {
    /*
     * The starting balance has to be the EFFECTIVE one. A deposit that has
     * been ticked off since the balance was typed is already in the account,
     * and a suggestion built from the stale snapshot would claim a shortfall
     * the household does not have - then name a bill to move for no reason.
     */
    const { today } = await arrangeShortfall();

    await harness.db.prisma.occurrence.create({
      data: {
        householdId: seeded.household.id,
        name: "Transfer in",
        cents: 200_000n,
        kind: "deposit",
        withdrawal: "auto",
        date: asDate(plus(today, 1)),
        clearedAt: new Date(),
        clearedById: seeded.alex.id,
        sortIndex: 0,
      },
    });

    const view = await dashboard();
    expect(view.coverage.allCovered).toBe(true);
    expect(view.suggestedMoves).toEqual([]);
  });

  it("leaves a charge on a card out of it", async () => {
    /*
     * A charge on a card is flexible and never touched chequing, so moving
     * it puts nothing back. Offering it would be advice that cannot work.
     */
    const { today } = await arrangeShortfall();
    const visa = await harness.db.prisma.account.create({
      data: { householdId: seeded.household.id, name: "Visa", kind: "credit_card" },
    });
    await harness.db.prisma.occurrence.create({
      data: {
        householdId: seeded.household.id,
        name: "Groceries",
        cents: -40_000n,
        kind: "bill",
        withdrawal: "flexible",
        date: asDate(plus(today, 4)),
        paidFromAccountId: visa.id,
        sortIndex: 5,
      },
    });

    const names = (await dashboard()).suggestedMoves.map((move) => move.name);
    expect(names).not.toContain("Groceries");
  });
});
