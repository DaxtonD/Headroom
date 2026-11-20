/**
 * The Year screen's four extras over HTTP, against a real Postgres.
 *
 * Asked for on 2026-11-20: the bills that only come once a year, what to put
 * aside for them, which extra paycheque pays for which extra payment, and
 * where the balance ends each month.
 *
 * The arithmetic is pinned down in `packages/core/test/yearAhead.test.ts` with
 * synthetic dates, which is the only place it CAN be pinned down - this
 * endpoint starts from the real clock, so which month holds the insurance
 * depends on what today is. What is tested here is everything only the API can
 * get wrong: that the right templates are picked out as irregular, that the
 * balance projection and the ledger start from the same figure, that the two
 * halves of the window join up rather than double-counting the seam, and that
 * every amount is integer cents on the wire.
 *
 * Dates are built from today, because every figure in Headroom is and a
 * hardcoded one tests a single arrangement of today before going red by the
 * calendar. Every amount is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  inDays,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let accountId: string;
let alexId: string;
let jordanId: string;

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
  accountId = seeded.account.id;
  alexId = seeded.alex.id;
  jordanId = seeded.jordan.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

function post(url: string, payload: unknown) {
  return harness.app.inject({
    method: "POST",
    url,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload,
  });
}

function get(url = "/api/year") {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

/**
 * Two people paid every fortnight, a week apart, starting today.
 *
 * Through the API rather than straight into Prisma, because adding a payday
 * is also what creates the paycheque TEMPLATE - and a payday without one puts
 * no money on any timeline at all. That is a real distinction the household
 * has hit in production, and a test that wrote the schedules directly would
 * have been projecting a year of outgoings against no income without ever
 * saying so.
 */
async function seedPay() {
  for (const [userId, days, cents] of [
    [jordanId, 0, "175000"],
    [alexId, 7, "180000"],
  ] as const) {
    const response = await post("/api/pay-schedules", {
      userId,
      anchorDate: inDays(days),
      defaultCents: cents,
    });
    expect(response.statusCode).toBe(201);
  }
}

/** A figure somebody typed in, so there is a balance to project from. */
async function seedBalance(cents: bigint) {
  await harness.db.prisma.balanceSnapshot.create({
    data: { accountId, cents, asOf: new Date(), enteredById: alexId },
  });
}

/** A month and day a few days out, so it is inside the horizon too. */
function soon(days = 5): { month: number; day: number; date: string } {
  const date = inDays(days);
  const [, month, day] = date.split("-");
  return { month: Number(month), day: Number(day), date };
}

interface Lump {
  name: string;
  date: string;
  cents: string;
  cadence: string;
}

interface Month {
  label: string;
  start: string;
  end: string;
  netExtraCents: string;
  inCents: string;
  outCents: string;
  endBalanceCents: string;
  lumpTotalCents: string;
  lumps: Lump[];
}

interface Body {
  today: string;
  monthCount: number;
  months: Month[];
  hasBalance: boolean;
  startBalanceCents: string;
  ledgerThrough: string;
  lowestStart: string | null;
  setAside: {
    monthCount: number;
    totalCents: string;
    billCount: number;
    evenCents: string;
    levelCents: string;
    bindingStart: string | null;
    bindingLabel: string | null;
  };
  pairs: {
    windfallStart: string;
    windfallLabel: string;
    squeezeStart: string;
    squeezeLabel: string;
    coveredCents: string;
    squeezeFirst: boolean;
  }[];
  uncoveredCents: string;
  spareCents: string;
}

const body = async (): Promise<Body> => (await get()).json() as Body;

/* -------------------------------------------------------------------------- */
/* The bills that skip months                                                 */
/* -------------------------------------------------------------------------- */

describe("the bills that only come once a year", () => {
  it("lists a yearly expense in the month it lands", async () => {
    await seedPay();
    const when = soon();

    const created = await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });
    expect(created.statusCode).toBe(201);

    const found = (await body()).months.flatMap((month) =>
      month.lumps.filter((lump) => lump.name === "House insurance").map((lump) => ({ month, lump })),
    );

    // Fourteen months can hold the same anniversary twice.
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.length).toBeLessThanOrEqual(2);

    for (const { month, lump } of found) {
      expect(lump.cents).toBe("120000");
      expect(lump.cadence).toBe("yearly");
      // Filed in the month its own date falls in.
      expect(lump.date >= month.start && lump.date <= month.end).toBe(true);
    }
  });

  /**
   * The list is "what is coming for you". A monthly bill is already in the
   * household's rhythm, and putting rent in here would bury the one thing
   * this section exists to surface.
   */
  it("leaves out anything that comes every month", async () => {
    await seedPay();
    await post("/api/templates", {
      name: "Rent",
      kind: "bill",
      defaultCents: "150000",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 1 },
      section: "fixed",
    });

    const all = (await body()).months.flatMap((month) => month.lumps);
    expect(all.map((lump) => lump.name)).not.toContain("Rent");
  });

  it("leaves out an archived yearly bill", async () => {
    await seedPay();
    const when = soon();
    const created = await post("/api/templates", {
      name: "Old subscription",
      kind: "bill",
      defaultCents: "9900",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });
    const id = (created.json() as { template: { id: string } }).template.id;
    await harness.db.prisma.template.update({ where: { id }, data: { active: false } });

    const all = (await body()).months.flatMap((month) => month.lumps);
    expect(all.map((lump) => lump.name)).not.toContain("Old subscription");
  });

  it("sums each month's lumps into its own total", async () => {
    await seedPay();
    const when = soon();
    await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });

    for (const month of (await body()).months) {
      const sum = month.lumps.reduce((total, lump) => total + BigInt(lump.cents), 0n);
      expect(BigInt(month.lumpTotalCents)).toBe(sum);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* What to set aside                                                          */
/* -------------------------------------------------------------------------- */

describe("what to set aside", () => {
  it("is nothing at all when no bill skips a month", async () => {
    await seedPay();
    const { setAside } = await body();

    expect(setAside.totalCents).toBe("0");
    expect(setAside.billCount).toBe(0);
    expect(setAside.levelCents).toBe("0");
    expect(setAside.bindingLabel).toBe(null);
  });

  it("totals every lump in the window, and never asks for less than the even share", async () => {
    await seedPay();
    const when = soon();
    await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });

    const { months, setAside } = await body();
    const total = months.reduce((sum, month) => sum + BigInt(month.lumpTotalCents), 0n);

    expect(BigInt(setAside.totalCents)).toBe(total);
    expect(setAside.monthCount).toBe(months.length);
    // The level figure is a maximum over the same months, so it can never be
    // the smaller of the two.
    expect(BigInt(setAside.levelCents)).toBeGreaterThanOrEqual(BigInt(setAside.evenCents));
  });

  /**
   * A bill five days from now cannot be paid for by a twelfth of itself. This
   * is the case the plain division gets wrong, and the reason there are two
   * figures rather than one.
   */
  it("asks for the whole of a bill that lands almost immediately", async () => {
    await seedPay();
    const when = soon();
    await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });

    const { months, setAside } = await body();
    const first = months[0];

    // Only when it really did land in the first month - near the end of a
    // month, five days out is next month, and then there is time to save.
    if (first && BigInt(first.lumpTotalCents) > 0n) {
      expect(BigInt(setAside.levelCents)).toBeGreaterThanOrEqual(BigInt(first.lumpTotalCents));
      expect(setAside.bindingStart).toBe(first.start);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Where the balance goes                                                     */
/* -------------------------------------------------------------------------- */

describe("the projected balance", () => {
  it("starts from the same figure the ledger is showing", async () => {
    await seedPay();
    await seedBalance(657_80n);

    const year = await body();
    const ledger = (await get("/api/dashboard").then((response) => response.json())) as {
      balance: { cents: string };
    };

    expect(year.hasBalance).toBe(true);
    // `balance.cents` on the home screen is the typed figure plus everything
    // settled since it - the same `effectiveCents` the projection opens with,
    // because both come from `loadTimelineContext`. This is the assertion
    // that keeps the Year screen's first month equal to the ledger's.
    expect(year.startBalanceCents).toBe(ledger.balance.cents);
  });

  it("carries each month's end into the next", async () => {
    await seedPay();
    await seedBalance(500_00n);

    const { months, startBalanceCents } = await body();
    let running = BigInt(startBalanceCents);

    for (const month of months) {
      running += BigInt(month.inCents) - BigInt(month.outCents);
      expect(BigInt(month.endBalanceCents)).toBe(running);
    }
  });

  it("brings in the pay, so the balance is not simply falling", async () => {
    await seedPay();
    await seedBalance(0n);

    const { months } = await body();
    const arriving = months.reduce((sum, month) => sum + BigInt(month.inCents), 0n);

    // Two people at $1,750 and $1,800 a fortnight, over fourteen months: a
    // good deal more than zero, and every month should see some of it.
    expect(arriving).toBeGreaterThan(5_000_000n);
    for (const month of months.slice(1)) expect(BigInt(month.inCents)).toBeGreaterThan(0n);
  });

  /**
   * The seam again, from the income side and with a hard number. Two people
   * paid a fortnight apart bring in 2 x $1,750 and 2 x $1,800 in an ordinary
   * month, and 3 of one of them in an unusual one - so no whole month may
   * exceed three of each. Four of anything would be the two halves of the
   * window overlapping.
   */
  it("pays each person no more than three times in any month", async () => {
    await seedPay();
    await seedBalance(0n);

    const { months } = await body();
    const mostPerMonth = 3n * 175_000n + 3n * 180_000n;

    for (const month of months.slice(1)) {
      expect(BigInt(month.inCents)).toBeLessThanOrEqual(mostPerMonth);
    }
  });

  /**
   * The seam. Up to the horizon the figures come from the ledger's own rows;
   * past it they are generated from the templates. If the two ranges
   * overlapped by so much as a day, every bill on that day would leave the
   * account twice - and it would look like an ordinary bad month rather than
   * like a bug.
   */
  it("joins the ledger to the projection without counting the seam twice", async () => {
    await seedPay();
    await seedBalance(500_00n);

    await post("/api/templates", {
      name: "Rent",
      kind: "bill",
      defaultCents: "150000",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 12 },
      section: "fixed",
    });

    const { months, ledgerThrough, today } = await body();
    expect(ledgerThrough >= today).toBe(true);

    // Rent is $1,500 a month and nothing else goes out, so no month may spend
    // more than one rent plus a little - two would be the double count.
    for (const month of months.slice(1)) {
      expect(BigInt(month.outCents)).toBeLessThanOrEqual(160_000n);
    }
  });

  it("names the month the balance ends lowest", async () => {
    await seedPay();
    await seedBalance(500_00n);

    const { months, lowestStart } = await body();
    const lowest = months.reduce((worst, month) =>
      BigInt(month.endBalanceCents) < BigInt(worst.endBalanceCents) ? month : worst,
    );

    expect(lowestStart).toBe(lowest.start);
  });

  /** A household with nothing entered must get a page, not a 500. */
  it("answers for a household with no pay, no balance and no bills", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);

    const empty = response.json() as Body;
    expect(empty.months).toHaveLength(14);
    expect(empty.setAside.totalCents).toBe("0");
    expect(empty.pairs).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Which windfall pays for which squeeze                                      */
/* -------------------------------------------------------------------------- */

describe("pairing the unusual months", () => {
  it("never promises more cover than the squeeze is worth", async () => {
    await seedPay();
    const { months, pairs, uncoveredCents } = await body();

    const squeezes = new Map(
      months
        .filter((month) => BigInt(month.netExtraCents) < 0n)
        .map((month) => [month.start, -BigInt(month.netExtraCents)]),
    );

    const covered = new Map<string, bigint>();
    for (const pair of pairs) {
      covered.set(pair.squeezeStart, (covered.get(pair.squeezeStart) ?? 0n) + BigInt(pair.coveredCents));
    }

    for (const [start, owed] of squeezes) {
      expect(covered.get(start) ?? 0n).toBeLessThanOrEqual(owed);
    }

    // Everything owed is either covered by a windfall or counted as not.
    const totalOwed = [...squeezes.values()].reduce((sum, owed) => sum + owed, 0n);
    const totalCovered = [...covered.values()].reduce((sum, amount) => sum + amount, 0n);
    expect(totalCovered + BigInt(uncoveredCents)).toBe(totalOwed);
  });

  it("never spends a windfall twice", async () => {
    await seedPay();
    const { months, pairs, spareCents } = await body();

    const windfalls = new Map(
      months
        .filter((month) => BigInt(month.netExtraCents) > 0n)
        .map((month) => [month.start, BigInt(month.netExtraCents)]),
    );

    const spent = new Map<string, bigint>();
    for (const pair of pairs) {
      spent.set(pair.windfallStart, (spent.get(pair.windfallStart) ?? 0n) + BigInt(pair.coveredCents));
    }

    for (const [start, available] of windfalls) {
      expect(spent.get(start) ?? 0n).toBeLessThanOrEqual(available);
    }

    const totalAvailable = [...windfalls.values()].reduce((sum, amount) => sum + amount, 0n);
    const totalSpent = [...spent.values()].reduce((sum, amount) => sum + amount, 0n);
    expect(totalSpent + BigInt(spareCents)).toBe(totalAvailable);
  });

  it("says which pairings have the squeeze arriving first", async () => {
    await seedPay();
    const { pairs } = await body();

    for (const pair of pairs) {
      expect(pair.squeezeFirst).toBe(pair.squeezeStart < pair.windfallStart);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* On the wire                                                                */
/* -------------------------------------------------------------------------- */

describe("on the wire", () => {
  it("sends every amount as integer cents, never a decimal", async () => {
    await seedPay();
    await seedBalance(657_80n);
    const when = soon();
    await post("/api/templates", {
      name: "House insurance",
      kind: "bill",
      defaultCents: "120000",
      withdrawal: "auto",
      schedule: { type: "yearly", month: when.month, day: when.day },
      section: "fixed",
    });

    const sent = await body();
    const integer = /^-?\d+$/;

    expect(sent.startBalanceCents).toMatch(integer);
    expect(sent.uncoveredCents).toMatch(integer);
    expect(sent.spareCents).toMatch(integer);
    expect(sent.setAside.totalCents).toMatch(integer);
    expect(sent.setAside.evenCents).toMatch(integer);
    expect(sent.setAside.levelCents).toMatch(integer);

    for (const month of sent.months) {
      expect(month.inCents).toMatch(integer);
      expect(month.outCents).toMatch(integer);
      expect(month.endBalanceCents).toMatch(integer);
      expect(month.lumpTotalCents).toMatch(integer);
      for (const lump of month.lumps) expect(lump.cents).toMatch(integer);
    }

    for (const pair of sent.pairs) expect(pair.coveredCents).toMatch(integer);
  });

  /** Both lists describe the same fourteen months, in the same order. */
  it("puts the new figures on the months that were already there", async () => {
    await seedPay();
    const sent = await body();

    expect(sent.months).toHaveLength(14);
    for (const month of sent.months) {
      expect(month.inCents).not.toBe(null);
      expect(month.endBalanceCents).not.toBe(null);
      expect(Array.isArray(month.lumps)).toBe(true);
    }
  });
});
