/**
 * Credit cards, and which account each row's money actually leaves.
 *
 * Reported by the household: one bill is charged automatically to a Visa,
 * along with half a dozen subscriptions. The bill was modelled as a chequing
 * withdrawal, so marking it paid took the money out of chequing - where it had
 * never been - and left no way to record the real payment toward the card when
 * it came out of chequing days later.
 *
 * Three things were wrong with that row and only one of them was new. Its date
 * was the day the card was charged rather than the day chequing moved, its
 * account was chequing rather than the card, and the real chequing outflow is
 * the whole statement rather than that one bill. None of it showed while "paid"
 * was a tick that moved no figure; all of it showed the moment the balance
 * started following a tick.
 *
 * So: a charge leaves the card, a payment leaves chequing and arrives at the
 * card, and one engine projects every account. The dates here are all relative
 * to today, because every figure in Headroom is built from "today" and a
 * hardcoded date tests one arrangement of it and then goes red by the calendar.
 *
 * Every amount is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let chequingId: string;

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
  chequingId = seeded.account.id;
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

function patch(url: string, version: number, payload: unknown) {
  return harness.app.inject({
    method: "PATCH",
    url,
    headers: { cookie, "idempotency-key": randomUUID(), "if-match": `"${String(version)}"` },
    payload,
  });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

/** A day of the month that is still ahead, so generation reaches it. */
function dayInAFewDays(): number {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 3);
  return date.getUTCDate();
}

/** A date inside the horizon, whatever today happens to be. */
function inDays(days: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface WireAccount {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly cents: string;
  readonly horizonCents: string;
  readonly extremeCents: string;
  readonly scheduledInCents: string;
  readonly needsPayment: boolean;
}

interface WireRow {
  readonly id: string;
  readonly name: string;
  readonly cents: string;
  readonly deltaCents: string;
  readonly runningCents: string;
  readonly paidFromAccountId: string | null;
  readonly transferToAccountId: string | null;
  readonly requiresCoverage: boolean;
}

async function dashboard() {
  const response = await get("/api/dashboard");
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return {
    chequingCents: body.balance.cents as string,
    leftThisCycleCents: body.leftThisCycleCents as string,
    autoWithdrawalCount: body.coverage.autoWithdrawalCount as number,
    estimatesCount: body.estimatesCount as number,
    accounts: body.accounts as readonly WireAccount[],
  };
}

async function accountNamed(name: string): Promise<WireAccount> {
  const found = (await dashboard()).accounts.find((entry) => entry.name === name);
  if (!found) throw new Error(`no account named ${name} on the dashboard`);
  return found;
}

async function ledgerRows(): Promise<readonly WireRow[]> {
  const response = await get("/api/timeline");
  expect(response.statusCode).toBe(200);
  return response.json().rows as readonly WireRow[];
}

async function rowNamed(name: string): Promise<WireRow> {
  const found = (await ledgerRows()).find((row) => row.name === name);
  if (!found) throw new Error(`no row named ${name} on the ledger`);
  return found;
}

async function addCard(name: string): Promise<string> {
  const response = await post("/api/accounts", { name, kind: "credit_card" });
  expect(response.statusCode).toBe(201);
  return response.json().account.id as string;
}

/** A charge: it leaves the card and arrives nowhere. */
async function addCharge(
  name: string,
  cents: string,
  days: number,
  paidFromAccountId: string,
): Promise<{ id: string; version: number }> {
  const response = await post("/api/occurrences", {
    name,
    cents,
    kind: "bill",
    date: inDays(days),
    paidFromAccountId,
  });
  expect(response.statusCode).toBe(201);
  const row = response.json().occurrence;
  return { id: row.id as string, version: row.version as number };
}

/** A payment: it leaves one account and arrives in another. */
async function addPayment(
  name: string,
  cents: string,
  days: number,
  from: string | null,
  to: string,
): Promise<{ id: string; version: number }> {
  const response = await post("/api/occurrences", {
    name,
    cents,
    kind: "bill",
    date: inDays(days),
    ...(from === null ? {} : { paidFromAccountId: from }),
    transferToAccountId: to,
  });
  expect(response.statusCode).toBe(201);
  const row = response.json().occurrence;
  return { id: row.id as string, version: row.version as number };
}

/** An ordinary chequing bill: no routing at all, as every row used to be. */
async function addChequingBill(
  name: string,
  cents: string,
  days: number,
): Promise<{ id: string; version: number }> {
  const response = await post("/api/occurrences", {
    name,
    cents,
    kind: "bill",
    date: inDays(days),
  });
  expect(response.statusCode).toBe(201);
  const row = response.json().occurrence;
  return { id: row.id as string, version: row.version as number };
}

async function setBalance(cents: string, accountId?: string) {
  const response = await post("/api/balance", {
    cents,
    ...(accountId ? { accountId } : {}),
  });
  expect(response.statusCode).toBe(201);
}

async function markPaid(row: { id: string; version: number }) {
  const response = await patch(`/api/occurrences/${row.id}`, row.version, { paid: true });
  expect(response.statusCode).toBe(200);
}

describe("a charge on a credit card", () => {
  it("raises what the card owes and leaves chequing exactly where it was", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);

    const charge = await addCharge("Wireless", "9500", 1, visa);

    // Nothing has moved yet: the charge is still ahead.
    expect((await dashboard()).chequingCents).toBe("240000");
    expect((await accountNamed("Visa")).cents).toBe("84200");

    await markPaid(charge);

    /*
     * The whole point. Chequing does not move, because none of its money did,
     * and the card owes $95.00 more - which is what the household said should
     * happen and what the old model could not express.
     */
    expect((await dashboard()).chequingCents).toBe("240000");
    expect((await accountNamed("Visa")).cents).toBe("93700");
  });

  it("stays on the ledger, with nothing in its running balance", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await addCharge("Wireless", "9500", 1, visa);

    const row = await rowNamed("Wireless");

    // Shown - a bill that vanishes is a bill nobody can check - and the
    // chequing balance carries straight through it.
    expect(row.cents).toBe("-9500");
    expect(row.deltaCents).toBe("0");
    expect(row.runningCents).toBe("240000");
    expect(row.paidFromAccountId).toBe(visa);
  });

  it("is not something chequing has to have the money waiting for", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await addCharge("Wireless", "9500", 1, visa);

    const summary = await dashboard();

    expect(summary.autoWithdrawalCount).toBe(0);
    expect(summary.leftThisCycleCents).toBe("240000");
    // It is still an unconfirmed amount, but it is the card's, not chequing's.
    expect(summary.estimatesCount).toBe(0);
  });

  it("lowers nothing in chequing even when it is bigger than the balance", async () => {
    const visa = await addCard("Visa");
    await setBalance("5000");
    await addCharge("Something large", "900000", 2, visa);

    const summary = await dashboard();

    // Before this, a charge could put the chequing forecast under water and
    // raise a shortfall over money that was never going to leave chequing.
    expect(summary.leftThisCycleCents).toBe("5000");
    // Nothing typed on the card, so the charge is the whole of it.
    expect(summary.accounts.find((entry) => entry.name === "Visa")?.horizonCents).toBe("900000");
  });
});

describe("a payment toward a credit card", () => {
  it("comes out of chequing and off the card from the one tick", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);

    const payment = await addPayment("Visa payment", "40000", 2, chequingId, visa);
    await markPaid(payment);

    expect((await dashboard()).chequingCents).toBe("200000");
    expect((await accountNamed("Visa")).cents).toBe("44200");
  });

  it("lowers the chequing forecast on the day it is planned for", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await addPayment("Visa payment", "40000", 2, chequingId, visa);

    const summary = await dashboard();

    expect(summary.leftThisCycleCents).toBe("200000");
    expect((await rowNamed("Visa payment")).deltaCents).toBe("-40000");
  });

  it("can be paid out of savings instead, leaving chequing alone", async () => {
    const visa = await addCard("Visa");
    const savings = await post("/api/accounts", { name: "Savings", kind: "savings" });
    expect(savings.statusCode).toBe(201);
    const savingsId = savings.json().account.id as string;

    await setBalance("240000");
    await setBalance("600000", savingsId);
    await setBalance("84200", visa);

    const payment = await addPayment("Visa payment", "40000", 2, savingsId, visa);
    await markPaid(payment);

    expect((await dashboard()).chequingCents).toBe("240000");
    expect((await accountNamed("Savings")).cents).toBe("560000");
    expect((await accountNamed("Visa")).cents).toBe("44200");
  });

  it("is not counted in the budget, because the charges already are", async () => {
    const visa = await addCard("Visa");

    // A charge is a real monthly cost and keeps its section.
    const charge = await post("/api/templates", {
      name: "Wireless",
      kind: "bill",
      defaultCents: "9500",
      withdrawal: "auto",
      schedule: { type: "monthly", day: dayInAFewDays() },
      section: "fixed",
      paidFromAccountId: visa,
    });
    expect(charge.statusCode).toBe(201);

    // Paying the card is the household settling those costs, not a new one.
    const payment = await post("/api/templates", {
      name: "Visa payment",
      kind: "transfer",
      defaultCents: "40000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "per_pay_period" },
      section: "fixed",
      paidFromAccountId: chequingId,
      transferToAccountId: visa,
    });
    expect(payment.statusCode).toBe(201);

    const budget = await get("/api/budget").then((response) => response.json());
    const names = [...budget.fixed.lines, ...budget.variable.lines].map(
      (line: { name: string }) => line.name,
    );

    expect(names).toContain("Wireless");
    expect(names).not.toContain("Visa payment");
  });
});

describe("the warning about a card nobody is paying", () => {
  /*
   * The one thing that got riskier. A charge correctly stops draining the
   * chequing forecast, so the debt can grow while safe-to-spend looks healthy.
   * The household chose to keep safe-to-spend a pure chequing figure - it is
   * the one number whose working fits in a sentence - and to make this
   * impossible to miss instead. So it has to be right.
   */
  it("fires for a card that owes money with nothing coming to pay it", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);

    const card = await accountNamed("Visa");
    expect(card.needsPayment).toBe(true);
    expect(card.scheduledInCents).toBe("0");
  });

  it("stops once a payment is scheduled", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);
    await addPayment("Visa payment", "40000", 2, chequingId, visa);

    const card = await accountNamed("Visa");
    expect(card.needsPayment).toBe(false);
    expect(card.scheduledInCents).toBe("40000");
  });

  it("fires for charges heading at a card whose balance nobody has typed", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await addCharge("Wireless", "9500", 1, visa);

    const card = await accountNamed("Visa");
    // Nothing typed, so it owes nothing yet - but it will.
    expect(card.cents).toBe("0");
    expect(card.horizonCents).toBe("9500");
    expect(card.needsPayment).toBe(true);
  });

  it("does not fire for a card that is paid off and quiet", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("0", visa);

    expect((await accountNamed("Visa")).needsPayment).toBe(false);
  });

  it("never fires for chequing or savings, which are not owed to anybody", async () => {
    const savings = await post("/api/accounts", { name: "Savings", kind: "savings" });
    expect(savings.statusCode).toBe(201);

    await setBalance("240000");
    await setBalance("600000", savings.json().account.id as string);

    expect((await accountNamed("Chequing")).needsPayment).toBe(false);
    expect((await accountNamed("Savings")).needsPayment).toBe(false);
  });
});

describe("the balance checklist", () => {
  it("offers only the things that come out of the account being updated", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);

    await addChequingBill("Power", "14000", 0);
    await addCharge("Wireless", "9500", 0, visa);

    const forChequing = await get("/api/balance/clearable").then((r) => r.json());
    expect(forChequing.candidates.map((row: { name: string }) => row.name)).toEqual(["Power"]);

    const forVisa = await get(`/api/balance/clearable?accountId=${visa}`).then((r) => r.json());
    expect(forVisa.candidates.map((row: { name: string }) => row.name)).toEqual(["Wireless"]);
    expect(forVisa.accountName).toBe("Visa");
  });

  it("says what ticking each one would do to that account's balance", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);

    await addCharge("Wireless", "9500", 0, visa);
    await addPayment("Visa payment", "40000", 0, chequingId, visa);

    const forVisa = await get(`/api/balance/clearable?accountId=${visa}`).then((r) => r.json());
    const byName = new Map(
      forVisa.candidates.map((row: { name: string; cents: string; deltaCents: string }) => [
        row.name,
        row,
      ]),
    );

    /*
     * The amount and the effect are not the same number, and the payment is
     * where that bites. It is stored as money leaving chequing, so its amount
     * is negative - and on the card it REDUCES what is owed.
     */
    expect(byName.get("Wireless")).toMatchObject({ cents: "-9500", deltaCents: "-9500" });
    expect(byName.get("Visa payment")).toMatchObject({ cents: "-40000", deltaCents: "40000" });
  });

  it("refuses to tick a chequing bill off against a card statement", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    const power = await addChequingBill("Power", "14000", 0);

    const response = await post("/api/balance", {
      cents: "84200",
      accountId: visa,
      clearedOccurrenceIds: [power.id],
    });

    // Otherwise the bill leaves the forecast on the strength of a figure that
    // never contained it, and the money leaves the app without leaving a bank.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  it("clears a charge against the card it was charged to", async () => {
    const visa = await addCard("Visa");
    await setBalance("240000");
    await setBalance("84200", visa);
    const charge = await addCharge("Wireless", "9500", 0, visa);

    const response = await post("/api/balance", {
      cents: "93700",
      accountId: visa,
      clearedOccurrenceIds: [charge.id],
    });
    expect(response.statusCode).toBe(201);

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: charge.id },
    });
    expect(row.clearedAt).not.toBeNull();

    // Typed figure stands alone: the charge settled at the same moment, and
    // ties go to the snapshot.
    expect((await accountNamed("Visa")).cents).toBe("93700");
  });

  it("refuses a clearing list against savings, which has no such list", async () => {
    const savings = await post("/api/accounts", { name: "Savings", kind: "savings" });
    const savingsId = savings.json().account.id as string;
    await setBalance("240000");
    const power = await addChequingBill("Power", "14000", 0);

    const response = await post("/api/balance", {
      cents: "600000",
      accountId: savingsId,
      clearedOccurrenceIds: [power.id],
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("where a row says its money moves", () => {
  it("refuses an account belonging to another household", async () => {
    const other = await harness.db.prisma.household.create({ data: { name: "Someone else" } });
    const theirs = await harness.db.prisma.account.create({
      data: { householdId: other.id, name: "Their Visa", kind: "credit_card" },
    });

    const response = await post("/api/occurrences", {
      name: "Not ours",
      cents: "9500",
      kind: "bill",
      date: inDays(1),
      paidFromAccountId: theirs.id,
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses money moving from an account into itself", async () => {
    const visa = await addCard("Visa");

    const response = await post("/api/occurrences", {
      name: "Nowhere",
      cents: "9500",
      kind: "bill",
      date: inDays(1),
      paidFromAccountId: visa,
      transferToAccountId: visa,
    });

    // It would net to zero on every figure: a payment that silently does
    // nothing is worse than one that is refused.
    expect(response.statusCode).toBe(400);
  });

  it("refuses an account that does not exist at all", async () => {
    const response = await post("/api/occurrences", {
      name: "Nowhere",
      cents: "9500",
      kind: "bill",
      date: inDays(1),
      paidFromAccountId: randomUUID(),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("a recurring charge", () => {
  it("passes its card on to every row it generates", async () => {
    const visa = await addCard("Visa");

    const created = await post("/api/templates", {
      name: "Wireless",
      kind: "bill",
      defaultCents: "9500",
      withdrawal: "auto",
      schedule: { type: "monthly", day: dayInAFewDays() },
      section: "fixed",
      paidFromAccountId: visa,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().template.paidFromAccountId).toBe(visa);

    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);

    const rows = await harness.db.prisma.occurrence.findMany({
      where: { householdId, name: "Wireless", deletedAt: null },
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.paidFromAccountId).toBe(visa);
    }
  });

  it("moves its untouched rows with it when the card changes", async () => {
    const visa = await addCard("Visa");

    const created = await post("/api/templates", {
      name: "Wireless",
      kind: "bill",
      defaultCents: "9500",
      withdrawal: "auto",
      schedule: { type: "monthly", day: dayInAFewDays() },
      section: "fixed",
    });
    const template = created.json().template as { id: string; version: number };
    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);

    // Everything it generated came out of chequing, as it always did.
    const before = await harness.db.prisma.occurrence.findMany({
      where: { householdId, name: "Wireless", deletedAt: null },
    });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((row) => row.paidFromAccountId === null)).toBe(true);

    const moved = await patch(`/api/templates/${template.id}`, template.version, {
      paidFromAccountId: visa,
    });
    expect(moved.statusCode).toBe(200);

    const after = await harness.db.prisma.occurrence.findMany({
      where: { householdId, name: "Wireless", deletedAt: null },
    });
    expect(after.every((row) => row.paidFromAccountId === visa)).toBe(true);
  });

  it("leaves a row somebody has made their own where they put it", async () => {
    const visa = await addCard("Visa");

    const created = await post("/api/templates", {
      name: "Wireless",
      kind: "bill",
      defaultCents: "9500",
      withdrawal: "auto",
      schedule: { type: "monthly", day: dayInAFewDays() },
      section: "fixed",
      paidFromAccountId: visa,
    });
    expect(created.statusCode).toBe(201);
    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);

    const rows = await harness.db.prisma.occurrence.findMany({
      where: { householdId, name: "Wireless", deletedAt: null },
      orderBy: { date: "asc" },
    });
    const first = rows[0];
    if (!first) throw new Error("nothing generated");

    // One month paid straight out of chequing instead.
    const own = await patch(`/api/occurrences/${first.id}`, first.version, {
      paidFromAccountId: null,
    });
    expect(own.statusCode).toBe(200);

    // Generation runs again and must not put it back on the card.
    expect((await post("/api/templates/generate", {})).statusCode).toBe(200);

    const after = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(after.paidFromAccountId).toBeNull();
    expect(after.customisedAt).not.toBeNull();
  });
});
