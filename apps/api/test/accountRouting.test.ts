/**
 * The two ends of a move, end to end against real Postgres.
 *
 * ## What the household reported
 *
 * Two things, on 2026-11-19, and the second is the serious one:
 *
 *  1. The water bill is an expense whose planned account shows in Manage, and
 *     opening that row on the ledger gave no way to say that this month it went
 *     on the Visa.
 *
 *  2. **"A one-off payment to savings doesn't increase the savings amount."**
 *
 * The second was money disappearing. The sheet offered "Into savings", sent
 * `kind: "transfer"`, and sent no destination - so the row was a transfer with
 * nowhere to go. `accountDelta` reads that correctly as money spent rather
 * than money moved, so chequing fell by the amount and nothing received it.
 *
 * Neither was an engine fault or an API fault. Both ends have been in the
 * schema, the engine and the routes since cards arrived; the screens simply
 * never set them. So the fix is almost entirely web-side, which is exactly the
 * kind of fix that needs a test down here: these prove that what the forms now
 * send produces the figures the household expected, rather than proving the
 * forms contain the right strings.
 *
 * The dates are all relative to today, because every figure in Headroom is
 * built from "today" and a hardcoded date tests one arrangement of it and then
 * goes red by the calendar.
 *
 * Every amount is invented.
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
let householdId: string;
let savingsId: string;
let visaId: string;
let alexId: string;

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
  alexId = seeded.alex.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);

  savingsId = await addAccount("Savings", "savings");
  visaId = await addAccount("Visa", "credit_card");
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

/**
 * A day of the month that is still ahead, so generation reaches it.
 *
 * Off the household's own today, like `inDays` - reading the day out of a UTC
 * date is wrong for the six hours a day when UTC has rolled over and Regina
 * has not.
 */
function dayInAFewDays(): number {
  return Number(inDays(3).slice(8, 10));
}

async function addAccount(name: string, kind: string): Promise<string> {
  const response = await post("/api/accounts", { name, kind });
  expect(response.statusCode).toBe(201);
  return response.json().account.id as string;
}

/** A typed balance, which is the authority every derived figure starts from. */
async function setBalance(cents: string, accountId?: string) {
  const response = await post("/api/balance", {
    cents,
    ...(accountId === undefined ? {} : { accountId }),
  });
  expect(response.statusCode).toBe(201);
}

/**
 * Every account's derived balance, which is what the home screen shows.
 *
 * Off the dashboard rather than a list endpoint, because the dashboard is
 * where these figures are actually read - and because a test that proves the
 * number the household looks at is worth more than one proving a field.
 */
async function balanceOf(name: string): Promise<string> {
  const response = await get("/api/dashboard");
  expect(response.statusCode).toBe(200);
  const accounts = response.json().accounts as readonly { name: string; cents: string }[];
  const found = accounts.find((account) => account.name === name);
  expect(found, `no account called ${name} on the dashboard`).toBeDefined();
  return found?.cents ?? "";
}

async function chequing(): Promise<string> {
  const response = await get("/api/dashboard");
  expect(response.statusCode).toBe(200);
  return response.json().balance.cents as string;
}

async function markPaid(row: { id: string; version: number }) {
  const response = await patch(`/api/occurrences/${row.id}`, row.version, { paid: true });
  expect(response.statusCode).toBe(200);
  return response.json().occurrence.version as number;
}

interface Row {
  readonly id: string;
  readonly version: number;
}

function rowOf(response: { json(): { occurrence: { id: string; version: number } } }): Row {
  const row = response.json().occurrence;
  return { id: row.id, version: row.version };
}

describe("a one-off payment into savings", () => {
  beforeEach(async () => {
    await setBalance("240000");
    await setBalance("600000", savingsId);
  });

  it("increases savings and decreases chequing by the same amount", async () => {
    /*
     * The report, as a test. This is what the sheet now sends and what it did
     * not send before: a destination.
     */
    const created = await post("/api/occurrences", {
      name: "Extra into savings",
      cents: "25000",
      kind: "transfer",
      date: inDays(0),
      transferToAccountId: savingsId,
    });
    expect(created.statusCode).toBe(201);
    await markPaid(rowOf(created));

    expect(await chequing()).toBe("215000");
    expect(await balanceOf("Savings")).toBe("625000");
  });

  it("is refused outright when it does not say where the money goes", async () => {
    /*
     * The old sheet's payload, exactly. It used to be accepted: the row was
     * stored as a transfer with a null destination, chequing fell by the
     * amount, and savings never moved.
     *
     * Refused at the integrity layer rather than only in the form, because the
     * engine already refuses a row with no SOURCE for this reason and a
     * missing destination is the same mistake with the ends swapped.
     */
    const created = await post("/api/occurrences", {
      name: "Extra into savings",
      cents: "25000",
      kind: "transfer",
      date: inDays(0),
    });

    expect(created.statusCode).toBe(400);
    expect(created.json().error).toBe("invalid_request");
    expect(created.json().message).toMatch(/which account it goes into/);
  });

  it("leaves an ordinary bill alone, which names no destination on purpose", async () => {
    // Money going out to somewhere Headroom does not track is a bill, not a
    // transfer. The guard must not catch that - it is most of the ledger.
    const created = await post("/api/occurrences", {
      name: "Dentist",
      cents: "18000",
      kind: "bill",
      date: inDays(0),
    });
    expect(created.statusCode).toBe(201);
    await markPaid(rowOf(created));

    expect(await chequing()).toBe("222000");
    expect(await balanceOf("Savings")).toBe("600000");
  });
});

describe("changing which account one row came out of", () => {
  beforeEach(async () => {
    await setBalance("240000");
    await setBalance("84200", visaId);
  });

  it("moves the money off chequing and onto the card", async () => {
    /*
     * The water bill. Planned to come out of chequing, and this month it went
     * on the Visa - a decision about this month, which is why it is edited on
     * the row rather than on the template.
     */
    const created = await post("/api/occurrences", {
      name: "Water",
      cents: "18600",
      kind: "bill",
      date: inDays(0),
    });
    expect(created.statusCode).toBe(201);
    const version = await markPaid(rowOf(created));

    expect(await chequing()).toBe("221400");
    expect(await balanceOf("Visa")).toBe("84200");

    const moved = await patch(`/api/occurrences/${rowOf(created).id}`, version, {
      paidFromAccountId: visaId,
    });
    expect(moved.statusCode).toBe(200);

    // Chequing never paid it after all, and the card owes it instead.
    expect(await chequing()).toBe("240000");
    expect(await balanceOf("Visa")).toBe("102800");
  });

  it("moves it back, because a correction has to be correctable", async () => {
    const created = await post("/api/occurrences", {
      name: "Water",
      cents: "18600",
      kind: "bill",
      date: inDays(0),
      paidFromAccountId: visaId,
    });
    expect(created.statusCode).toBe(201);
    const version = await markPaid(rowOf(created));
    expect(await balanceOf("Visa")).toBe("102800");

    const moved = await patch(`/api/occurrences/${rowOf(created).id}`, version, {
      paidFromAccountId: null,
    });
    expect(moved.statusCode).toBe(200);

    expect(await chequing()).toBe("221400");
    expect(await balanceOf("Visa")).toBe("84200");
  });

  it("refuses to move it into the account it came from", async () => {
    const created = await post("/api/occurrences", {
      name: "Visa payment",
      cents: "40000",
      kind: "transfer",
      date: inDays(0),
      transferToAccountId: visaId,
    });
    expect(created.statusCode).toBe(201);

    const moved = await patch(`/api/occurrences/${rowOf(created).id}`, rowOf(created).version, {
      paidFromAccountId: visaId,
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().message).toMatch(/into itself/);
  });
});

describe("turning a row into a payment toward an account", () => {
  beforeEach(async () => {
    await setBalance("240000");
    await setBalance("600000", savingsId);
  });

  it("credits savings from then on, which is how a lost row is repaired", async () => {
    /*
     * The rows already saved by the old sheet are sitting in the household's
     * database as transfers with nowhere to go. The create path now refuses
     * that shape, so this test builds one the way the old sheet did - directly
     * - and then repairs it the way the ledger's new picker does.
     *
     * This is why the guard is on create only. A PATCH has to go through on a
     * row that is already in the bad state, or the damage is locked in.
     */
    const broken = await harness.db.prisma.occurrence.create({
      data: {
        householdId,
        name: "Into savings",
        cents: -25000n,
        kind: "transfer",
        withdrawal: "auto",
        date: new Date(`${inDays(0)}T00:00:00Z`),
        isOneOff: true,
        // The constraint is who-and-when together or not at all, like the
        // other two pairs. A row ticked by nobody is not a state the app can
        // produce, so the insert must not produce one either.
        paidAt: new Date(),
        paidById: alexId,
        updatedById: alexId,
      },
      select: { id: true, version: true },
    });

    // The money has left chequing and arrived nowhere. The bug, reproduced.
    expect(await chequing()).toBe("215000");
    expect(await balanceOf("Savings")).toBe("600000");

    const repaired = await patch(`/api/occurrences/${broken.id}`, broken.version, {
      transferToAccountId: savingsId,
    });
    expect(repaired.statusCode).toBe(200);

    expect(await chequing()).toBe("215000");
    expect(await balanceOf("Savings")).toBe("625000");
  });
});

describe("a scheduled transfer set up as an expense", () => {
  it("lands in savings when its occurrence is ticked", async () => {
    /*
     * The third hole, found while reading the code for the other two: no
     * screen could set a destination on a TEMPLATE either, so a planned
     * monthly savings payment had the same fault as the one-off.
     *
     * Dated rather than flexible, which is not how the household runs their
     * savings line - the schema's note says they decide when and how much each
     * period - but a flexible template is placed against a PAY PERIOD, and
     * this harness seeds no pay schedules, so a flexible one generates
     * nothing. The thing under test is that the money lands in savings, and a
     * dated schedule reaches that in a straight line. Flexible placement has
     * its own tests in the engine.
     */
    await setBalance("240000");
    await setBalance("600000", savingsId);

    const template = await post("/api/templates", {
      name: "Monthly savings",
      kind: "transfer",
      defaultCents: "50000",
      withdrawal: "auto",
      schedule: { type: "monthly", day: dayInAFewDays() },
      section: "fixed",
      transferToAccountId: savingsId,
    });
    expect(template.statusCode).toBe(201);

    const generated = await post("/api/templates/generate", {});
    expect(generated.statusCode).toBe(200);

    const rows = await get("/api/timeline");
    expect(rows.statusCode).toBe(200);
    const row = (rows.json().rows as readonly (Row & { name: string })[]).find(
      (candidate) => candidate.name === "Monthly savings",
    );
    expect(row, "the template generated no row").toBeDefined();
    if (!row) return;

    await markPaid(row);

    expect(await chequing()).toBe("190000");
    expect(await balanceOf("Savings")).toBe("650000");
  });

  it("is refused if it says it is a transfer and names nowhere", async () => {
    const template = await post("/api/templates", {
      name: "Monthly savings",
      kind: "transfer",
      defaultCents: "50000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly" },
      section: "fixed",
    });
    expect(template.statusCode).toBe(400);
    expect(template.json().error).toBe("invalid_request");
    expect(template.json().message).toMatch(/which account it goes into/);
  });
});
