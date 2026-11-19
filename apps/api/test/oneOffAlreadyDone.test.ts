/**
 * A one-off that has already happened arrives with its tick on.
 *
 * Reported from use: "When I add a one-off, it's placed on the ledger. I then
 * have to open it again to mark it as paid." Which is two steps to say one
 * thing, and the wrong two: a one-off is nearly always typed in *after* the
 * fact - a bill paid at the counter, a payment made to a card on the bank's
 * own app - so the row being added is a record, not a plan.
 *
 * ## What this is careful about
 *
 * `paid` on create had to mean exactly what `paid` on a PATCH means, and not
 * a second kind of state that every figure then has to know about. So the
 * test that matters most here is the one comparing the two routes: a row
 * created paid and a row created and then ticked have to be the same row.
 * That is what keeps `settledMoment` the only thing the engine reads.
 *
 * It is also the one place a date and a tick can contradict each other. A
 * settled row is left out of the forecast, so "already done" on a date in the
 * future would be a payment that quietly stopped counting towards anything.
 * The screen refuses that combination; these tests pin down what the API does
 * with it, which is to take it, because the same thing has always been
 * reachable by ticking a future row by hand and inventing a second rule here
 * would make the two routes disagree.
 *
 * Dates are relative to today, because every figure in Headroom is built from
 * "today" and a hardcoded one tests a single arrangement of it and then goes
 * red by the calendar. Every amount is invented.
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
let alexId: string;
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
  alexId = seeded.alex.id;
  chequingId = seeded.account.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

function post(url: string, payload: unknown, key = randomUUID()) {
  return harness.app.inject({
    method: "POST",
    url,
    headers: { cookie, "idempotency-key": key },
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
 * Let the clock move on, so what happens next is strictly later than this.
 *
 * Every test here types in a balance and then adds a row that settled after
 * it, and "after" is the whole comparison: a settled row counts toward a
 * typed figure only when it settled strictly later, and a tie goes to the
 * snapshot - the safe direction, because a balance read off the bank after
 * the money left already contains it.
 *
 * In real time two consecutive requests are milliseconds apart and the order
 * is never in doubt. Under `PIN_DATE` it is: `pinclock.ts` fakes `Date` and
 * advances it in 20ms steps, so two requests inside one step read the exact
 * same instant and the tick is correctly ignored. That is the harness being
 * coarse, not the app being wrong, so the test says what it depends on rather
 * than the rule being loosened to suit it.
 *
 * `setTimeout` is not faked - only `Date` is - so this really does wait, and
 * the fake clock really does move while it does.
 */
const letTheClockMove = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 30);
  });

async function setBalance(cents: string, accountId?: string) {
  const response = await post("/api/balance", {
    cents,
    ...(accountId ? { accountId } : {}),
  });
  expect(response.statusCode).toBe(201);
  await letTheClockMove();
}

interface WireOccurrence {
  readonly id: string;
  readonly version: number;
  readonly cents: string;
  readonly paid: boolean;
  readonly paidAt: string | null;
  readonly paidById: string | null;
  readonly verified: boolean;
  readonly date: string | null;
  readonly withdrawal: string;
}

async function addOneOff(payload: Record<string, unknown>): Promise<WireOccurrence> {
  const response = await post("/api/occurrences", payload);
  expect(response.statusCode).toBe(201);
  return response.json().occurrence as WireOccurrence;
}

async function chequingCents(): Promise<string> {
  const response = await get("/api/dashboard");
  expect(response.statusCode).toBe(200);
  return response.json().balance.cents as string;
}

async function timelineRow(name: string) {
  const response = await get("/api/timeline");
  expect(response.statusCode).toBe(200);
  const found = (
    response.json().rows as readonly {
      name: string;
      deltaCents: string;
      paid: boolean;
      settled: boolean;
    }[]
  ).find((row) => row.name === name);
  if (!found) throw new Error(`no row named ${name} on the ledger`);
  return found;
}

describe("creating a one-off that has already happened", () => {
  it("comes back ticked, by whoever is signed in", async () => {
    const row = await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });

    expect(row.paid).toBe(true);
    expect(row.paidAt).not.toBeNull();
    // Whoever is signed in on this phone, exactly as a tick on the row does.
    expect(row.paidById).toBe(alexId);
  });

  it("moves the balance from the one request", async () => {
    await setBalance("240000");
    expect(await chequingCents()).toBe("240000");

    await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });

    // The whole point. No second request, no going back to find the row.
    expect(await chequingCents()).toBe("221500");
  });

  it("leaves the balance alone when it has not happened yet", async () => {
    await setBalance("240000");

    await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(4),
    });

    // Still to come: it is on the ledger and in the forecast, and the figure
    // off the bank has not changed.
    expect(await chequingCents()).toBe("240000");
    expect((await timelineRow("Dentist")).paid).toBe(false);
  });

  it("is the same row as one created and then ticked", async () => {
    await setBalance("240000");

    const atOnce = await addOneOff({
      name: "Paid on create",
      cents: "5000",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });
    expect(atOnce.paid).toBe(true);

    const inTwoSteps = await addOneOff({
      name: "Ticked after",
      cents: "5000",
      kind: "bill",
      date: inDays(0),
    });
    const ticked = await patch(`/api/occurrences/${inTwoSteps.id}`, inTwoSteps.version, {
      paid: true,
    });
    expect(ticked.statusCode).toBe(200);

    /*
     * The claim this file exists to make. If these two ever diverged, `paid`
     * on create would be a second kind of state and every figure in the
     * engine would need to know about both.
     */
    const one = await timelineRow("Paid on create");
    const two = await timelineRow("Ticked after");
    expect(one.settled).toBe(two.settled);
    expect(one.paid).toBe(two.paid);
    expect(one.deltaCents).toBe(two.deltaCents);

    // And both of them came off the balance, once each.
    expect(await chequingCents()).toBe("230000");
  });

  it("stops counting towards the forecast, because it has already counted", async () => {
    await setBalance("240000");

    await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });

    /*
     * Settled, so its delta is zero and the running balance walks past it.
     * The money is inside the figure at the top instead - which is the only
     * way for it to be counted exactly once.
     */
    const row = await timelineRow("Dentist");
    expect(row.settled).toBe(true);
    expect(row.deltaCents).toBe("0");
  });

  it("does not claim anybody verified the amount", async () => {
    /*
     * Two different statements. "Paid" is what happened to the money;
     * "verified" is somebody having confirmed the figure against a bill. A
     * settled row is left out of the estimate count anyway - the money is
     * gone, so "still an estimate" is no longer the useful fact about it - so
     * there is nothing to gain by quietly asserting the second one.
     */
    const row = await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });

    expect(row.verified).toBe(false);

    const dashboard = await get("/api/dashboard");
    expect(dashboard.json().estimatesCount).toBe(0);
  });

  it("works for money coming in", async () => {
    await setBalance("240000");

    const row = await addOneOff({
      name: "Rebate",
      cents: "7250",
      kind: "deposit",
      date: inDays(0),
      paid: true,
    });

    expect(row.paid).toBe(true);
    // Signed by the kind, as every one-off is, and already in the balance.
    expect(row.cents).toBe("7250");
    expect(await chequingCents()).toBe("247250");
  });

  it("moves both balances when it is a payment toward a card", async () => {
    const created = await post("/api/accounts", { name: "Visa", kind: "credit_card" });
    expect(created.statusCode).toBe(201);
    const visa = created.json().account.id as string;

    await setBalance("240000");
    await setBalance("84200", visa);

    await addOneOff({
      name: "Visa payment",
      cents: "40000",
      kind: "bill",
      date: inDays(0),
      paidFromAccountId: chequingId,
      transferToAccountId: visa,
      paid: true,
    });

    // One request: out of chequing, and off what the card owes.
    expect(await chequingCents()).toBe("200000");

    const dashboard = await get("/api/dashboard");
    const card = (dashboard.json().accounts as readonly { id: string; cents: string }[]).find(
      (account) => account.id === visa,
    );
    expect(card?.cents).toBe("44200");
  });

  it("is still one row when the request is retried", async () => {
    await setBalance("240000");

    const key = randomUUID();
    const payload = {
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    };

    const first = await post("/api/occurrences", payload, key);
    const again = await post("/api/occurrences", payload, key);

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json().occurrence.id).toBe(first.json().occurrence.id);

    // The thing a replayed create has to not do twice.
    expect(await chequingCents()).toBe("221500");
  });

  it("records the tick in the activity log", async () => {
    await addOneOff({
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: true,
    });

    const response = await get("/api/activity");
    expect(response.statusCode).toBe(200);

    const entries = response.json().entries as readonly {
      entity: string;
      action: string;
      after: Record<string, unknown> | null;
    }[];
    const creation = entries.find(
      (entry) => entry.entity === "occurrence" && entry.action === "create",
    );

    // Append-only, and it has to say the row arrived already paid - otherwise
    // the log reads as though nobody ever marked it.
    expect(creation?.after?.["paid"]).toBe(true);
  });

  it("takes a tick on a date still to come, rather than inventing a rule", async () => {
    /*
     * The screen will not offer this: a settled row is out of the forecast, so
     * a future payment marked done stops counting towards anything, and that
     * is worth catching where the date is on screen and can be corrected.
     *
     * The API takes it, because the same state has always been reachable by
     * ticking a future row by hand. A rule here and not there would mean two
     * routes to one field that disagreed - which is worse than the thing it
     * would be guarding against.
     */
    await setBalance("240000");

    const row = await addOneOff({
      name: "Next week",
      cents: "5000",
      kind: "bill",
      date: inDays(7),
      paid: true,
    });

    expect(row.paid).toBe(true);
    expect(await chequingCents()).toBe("235000");
  });

  it("refuses anything that is not a boolean", async () => {
    const response = await post("/api/occurrences", {
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      date: inDays(0),
      paid: "yes",
    });

    expect(response.statusCode).toBe(400);
  });
});
