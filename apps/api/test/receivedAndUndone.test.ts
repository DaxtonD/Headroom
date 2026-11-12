/**
 * Marking a cheque received, and getting back out of it.
 *
 * Reported from a real session, in this order: a paycheque was showing on the
 * ledger, it was marked as received, and after that the row could not be
 * opened, edited or undone at all. The income entry was deleted under Manage
 * to get rid of it, and the ledger went on showing it anyway.
 *
 * Three separate faults, one seam. A paycheque that is not on the timeline is
 * PROJECTED from the payday instead - which is right when the cheque simply
 * has not been generated yet, and wrong in the two cases here:
 *
 *  1. **It already arrived.** Clearing a row takes it off the timeline and
 *     folds the money into the balance (section 6.1). The payday then looked
 *     unplaced, so a cheque was projected for it: the same pay counted twice
 *     in the window's "coming in", and an uneditable "Expected" row standing
 *     where the real one had been.
 *  2. **It was turned off on purpose.** Archiving the paycheque left the
 *     payday projecting cheques forever, which is why deleting the entry
 *     under Manage did not remove it from the ledger. Nothing could have:
 *     the row was not coming from the thing that was deleted.
 *  3. **There was no way back.** The API has always accepted
 *     `cleared: false`, but clearing a row removes it from the only screen
 *     that lists rows, so nothing in the app could reach it. An accidental
 *     tap on "Mark as received" was unrecoverable without SQL.
 *
 * Every amount here is invented; the dates are the structure under test.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let memberId: string;

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
  memberId = seeded.carol.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
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

/** A payday that has already happened, so its cheque can plausibly be received. */
function lastThursday(): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 3) % 7));
  return date.toISOString().slice(0, 10);
}

interface Window {
  readonly label: string;
  readonly inCents: string;
  readonly rows: readonly { readonly id: string; readonly name: string }[];
  readonly projectedPaycheques: readonly { readonly date: string; readonly cents: string }[];
}

async function windows(): Promise<readonly Window[]> {
  const body = await get("/api/pay-periods").then((response) => response.json());
  return body.periods as readonly Window[];
}

async function addPayday(): Promise<{ id: string; version: number }> {
  const response = await post("/api/pay-schedules", {
    userId: memberId,
    anchorDate: lastThursday(),
    defaultCents: "210000",
  });
  expect(response.statusCode).toBe(201);
  return response.json().paySchedule as { id: string; version: number };
}

function paychequeTemplate() {
  return harness.db.prisma.template.findFirstOrThrow({
    where: { householdId, kind: "paycheque", deletedAt: null },
  });
}

function cheques() {
  return harness.db.prisma.occurrence.findMany({
    where: { householdId, kind: "paycheque", deletedAt: null },
    orderBy: { date: "asc" },
  });
}

describe("marking a cheque as received", () => {
  it("does not leave a projected copy of it behind", async () => {
    await addPayday();

    const before = await cheques();
    expect(before.length).toBeGreaterThan(0);
    const received = before[0] as { id: string; version: number };

    // Nothing is projected while the real cheque is on the ledger.
    expect((await windows()).flatMap((window) => window.projectedPaycheques)).toEqual([]);
    const inBefore = (await windows())[0]?.inCents;

    const marked = await patch(`/api/occurrences/${received.id}`, received.version, {
      cleared: true,
    });
    expect(marked.statusCode).toBe(200);

    const after = await windows();

    /*
     * The money is in the balance now, so projecting the cheque as well counts
     * the same pay twice in "coming in" - and puts an "Expected" row on the
     * ledger that cannot be opened, exactly where the real row used to be.
     */
    expect(after.flatMap((window) => window.projectedPaycheques)).toEqual([]);
    expect(after[0]?.inCents).toBe(inBefore);
  });

  it("is not how a row is ticked off any more", async () => {
    /*
     * Clearing is now only what the balance-update checklist does. The gesture
     * on a row is a tick that moves nothing - see the describe below - because
     * one flag doing both jobs is what let a bill be subtracted twice: once
     * inside the figure read off the bank, and once again by marking it paid.
     */
    await addPayday();
    const cheque = (await cheques())[0] as { id: string; version: number };
    await patch(`/api/occurrences/${cheque.id}`, cheque.version, { cleared: true });

    // The way back is still there for the balance flow to use.
    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: cheque.id },
    });
    const undone = await patch(`/api/occurrences/${cheque.id}`, reread.version, {
      cleared: false,
    });
    expect(undone.statusCode).toBe(200);

    const after = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: cheque.id },
    });
    expect(after.clearedAt).toBeNull();
    expect(after.clearedById).toBeNull();

    const rows = (await windows()).flatMap((window) => window.rows);
    expect(rows.some((row) => row.id === cheque.id)).toBe(true);
  });
});

describe("ticking a row as dealt with", () => {
  /*
   * What "mark as paid" means now, decided with Dax after he found that it
   * moved the balance: a tick for the two of them and nothing else.
   *
   *   "I actually didn't realize that marking a bill paid actually moved the
   *    balance until now."
   *
   * Two things follow, and both are tested here. The row stays on the ledger,
   * because a ledger whose lines disappear is the complaint this answers. And
   * no figure moves, which makes the double subtraction impossible rather than
   * merely fixed: the balance changes only when somebody types one in.
   */
  async function figures(): Promise<{
    balance: string;
    safe: string;
    lowest: string;
    left: string;
  }> {
    const body = await get("/api/dashboard").then((response) => response.json());
    return {
      balance: body.balance.cents,
      safe: body.safeToSpendNowCents,
      lowest: body.lowest.cents,
      left: body.leftThisCycleCents,
    };
  }

  async function bill(): Promise<{ id: string; version: number }> {
    const soon = new Date();
    soon.setUTCHours(0, 0, 0, 0);
    soon.setUTCDate(soon.getUTCDate() + 3);

    const created = await post("/api/templates", {
      name: "Power",
      kind: "bill",
      section: "fixed",
      defaultCents: "18600",
      withdrawal: "auto",
      schedule: { type: "monthly", day: soon.getUTCDate() },
    });
    expect(created.statusCode).toBe(201);

    const row = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { householdId, name: "Power" },
      orderBy: { date: "asc" },
      select: { id: true, version: true },
    });
    return row;
  }

  it("moves no figure at all", async () => {
    await addPayday();
    expect((await post("/api/balance", { cents: "80000" })).statusCode).toBe(201);
    const target = await bill();

    const before = await figures();
    const ticked = await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json().occurrence.paid).toBe(true);

    // The whole point. The bank balance is what moves money, not a tick.
    expect(await figures()).toEqual(before);
  });

  it("leaves the row on the ledger, marked", async () => {
    await addPayday();
    const target = await bill();
    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    const rows = (await windows()).flatMap((window) => window.rows);
    const found = rows.find((row) => row.id === target.id) as
      | { paid: boolean; paidBy: { name: string } | null }
      | undefined;

    expect(found).toBeDefined();
    expect(found?.paid).toBe(true);
    // Who ticked it, because on the other phone the question is "did you
    // already pay this?".
    expect(found?.paidBy?.name).toBe("Carol");
  });

  it("can be untapped", async () => {
    await addPayday();
    const target = await bill();
    const ticked = await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    const undone = await patch(
      `/api/occurrences/${target.id}`,
      (ticked.json().occurrence as { version: number }).version,
      { paid: false },
    );
    expect(undone.statusCode).toBe(200);
    expect(undone.json().occurrence.paid).toBe(false);

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.paidAt).toBeNull();
    expect(row.paidById).toBeNull();
  });

  it("says nothing happened when it is already ticked", async () => {
    await addPayday();
    const target = await bill();
    const first = await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });
    const version = (first.json().occurrence as { version: number }).version;

    const again = await patch(`/api/occurrences/${target.id}`, version, { paid: true });
    expect(again.statusCode).toBe(200);
    expect(again.json().noop).toBe(true);
  });

  it("does not carry over to the next cycle", async () => {
    // What Dax asked for, and it holds by construction: each cycle is its own
    // row, so ticking one says nothing about the next.
    await addPayday();
    const target = await bill();
    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    const later = await harness.db.prisma.occurrence.findMany({
      where: { householdId, name: "Power", id: { not: target.id } },
      select: { paidAt: true },
    });
    expect(later.length).toBeGreaterThan(0);
    for (const row of later) expect(row.paidAt).toBeNull();
  });

  it("survives the next generation pass", async () => {
    await addPayday();
    const target = await bill();
    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    await post("/api/templates/generate", {});

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.paidAt).not.toBeNull();
  });

  it("is ticked for them on the balance checklist", async () => {
    /*
     * The two gestures answer different questions, but somebody who has said
     * "we paid this" will almost always mean "and it is inside the figure I am
     * about to read off the bank". Making them say it twice is how a bill
     * ends up counted twice.
     */
    await addPayday();
    const target = await bill();

    const before = await get("/api/balance/clearable").then((response) => response.json());
    const unticked = before.candidates.find(
      (candidate: { id: string }) => candidate.id === target.id,
    );
    // Dated a few days out, so not a candidate until its day arrives.
    expect(unticked).toBeUndefined();

    /*
     * A row dated today is, and that is the one worth checking.
     *
     * The date comes from the server rather than from `new Date()` here: the
     * household's today is in America/Regina and a UTC date is already
     * tomorrow there for the last six hours of every day, which would date
     * this row into the future and quietly take it out of the candidates.
     */
    const added = await post("/api/occurrences", {
      name: "Water",
      cents: "-14400",
      kind: "bill",
      date: before.today as string,
    });
    expect(added.statusCode).toBe(201);
    const water = added.json().occurrence as { id: string; version: number };

    await patch(`/api/occurrences/${water.id}`, water.version, { paid: true });

    const after = await get("/api/balance/clearable").then((response) => response.json());
    const candidate = after.candidates.find(
      (one: { id: string }) => one.id === water.id,
    ) as { paid: boolean } | undefined;
    expect(candidate?.paid).toBe(true);
  });

  it("cannot subtract a bill the typed-in balance already covered", async () => {
    /*
     * The bug this design removes. Before, the tick cleared the row, and
     * clearing subtracted it from the balance - so a bill that had come out
     * BEFORE the bank was read got taken off twice: once by the bank and once
     * by the tick. The household was short by the amount of the bill, with
     * nothing on screen to say why.
     */
    await addPayday();
    const target = await bill();

    // The figure read off the bank, which already accounts for the bill.
    expect((await post("/api/balance", { cents: "61400" })).statusCode).toBe(201);
    const before = await figures();

    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    expect((await figures()).balance).toBe(before.balance);
  });
});

describe("a bill the balance has already accounted for", () => {
  /*
   * The last state in the life of a row, and the one Dax asked to be able to
   * see: ticked as paid, then taken into a typed-in balance by the update
   * checklist. Before this it vanished from the ledger at that point, which is
   * the disappearing act Carol objected to - just moved one step later.
   *
   * So it stays, shown and counted in nothing, with a way back.
   */
  async function paidAndSettled(): Promise<{ id: string }> {
    const soon = new Date();
    soon.setUTCHours(0, 0, 0, 0);
    soon.setUTCDate(soon.getUTCDate() + 2);

    const created = await post("/api/templates", {
      name: "Power",
      kind: "bill",
      section: "fixed",
      defaultCents: "18600",
      withdrawal: "auto",
      schedule: { type: "monthly", day: soon.getUTCDate() },
    });
    expect(created.statusCode).toBe(201);

    const row = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { householdId, name: "Power" },
      orderBy: { date: "asc" },
      select: { id: true, version: true },
    });

    const ticked = await patch(`/api/occurrences/${row.id}`, row.version, { paid: true });
    expect(ticked.statusCode).toBe(200);

    // What the balance-update checklist does: "this is inside the figure I
    // just read off the bank".
    const settled = await post("/api/balance", {
      cents: "61400",
      clearedOccurrenceIds: [row.id],
    });
    expect(settled.statusCode).toBe(201);

    return { id: row.id };
  }

  it("is still on the ledger, marked paid", async () => {
    await addPayday();
    const row = await paidAndSettled();

    const found = (await windows())
      .flatMap((window) => window.rows)
      .find((one) => one.id === row.id) as
      | { paid: boolean; settled: boolean; name: string }
      | undefined;

    expect(found).toBeDefined();
    expect(found?.settled).toBe(true);
    expect(found?.paid).toBe(true);
  });

  it("is counted in nothing", async () => {
    await addPayday();
    const row = await paidAndSettled();

    const body = await get("/api/dashboard").then((response) => response.json());

    // The typed-in balance already has the bill in it, and nothing has changed
    // it since.
    expect(body.balance.cents).toBe("61400");

    // By id, not by name: next month's Power is a different row and is still
    // very much coming.
    expect(
      body.nextAutoWithdrawals.some((one: { id: string }) => one.id === row.id),
    ).toBe(false);

    // Nothing to confirm the amount of, either. It is over.
    const settledRow = (await windows())
      .flatMap((window) => window.rows)
      .find((one) => one.id === row.id) as { requiresCoverage: boolean } | undefined;
    expect(settledRow?.requiresCoverage).toBe(false);
  });

  it("can be undone, and counts again", async () => {
    await addPayday();
    const row = await paidAndSettled();

    /*
     * "Left this cycle" is the figure to watch rather than safe-to-spend: it
     * is the running balance at the end, so every row that counts is in it,
     * whereas the lowest point can sit at the opening balance and not move at
     * all when a bill comes out after a cheque lands.
     */
    const before = await get("/api/dashboard").then((response) => response.json());

    const current = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: row.id },
    });
    const undone = await patch(`/api/occurrences/${row.id}`, current.version, {
      cleared: false,
      paid: false,
    });
    expect(undone.statusCode).toBe(200);

    // "That is not inside my balance after all": it goes back to counting.
    const after = await get("/api/dashboard").then((response) => response.json());
    expect(BigInt(after.leftThisCycleCents as string)).toBe(
      BigInt(before.leftThisCycleCents as string) - 18_600n,
    );

    const found = (await windows())
      .flatMap((window) => window.rows)
      .find((one) => one.id === row.id) as { settled: boolean; paid: boolean } | undefined;
    expect(found?.settled).toBe(false);
    expect(found?.paid).toBe(false);
  });

  it("drops off the ledger once it is old", async () => {
    await addPayday();
    const row = await paidAndSettled();

    // A month on, it is history rather than something to look back over, and
    // the ledger is not an archive.
    await harness.db.prisma.occurrence.update({
      where: { id: row.id },
      data: { date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    const found = (await windows()).flatMap((window) => window.rows).find((one) => one.id === row.id);
    expect(found).toBeUndefined();
  });
});

describe("archiving a paycheque", () => {
  it("stops the payday projecting a replacement for it", async () => {
    await addPayday();
    const template = await paychequeTemplate();

    const archived = await patch(`/api/templates/${template.id}`, template.version, {
      active: false,
    });
    expect(archived.statusCode).toBe(200);

    /*
     * The reason deleting the entry under Manage did not clear it from the
     * ledger: the row left behind was projected from the PAYDAY, not produced
     * by the template that was deleted. Turning the pay off has to turn off
     * what is expected from it too.
     */
    const after = await windows();
    expect(after.flatMap((window) => window.projectedPaycheques)).toEqual([]);
    expect(await cheques()).toEqual([]);
  });

  it("still says the payday has no pay on the ledger", async () => {
    await addPayday();
    const template = await paychequeTemplate();
    await patch(`/api/templates/${template.id}`, template.version, { active: false });

    // Silently showing no income at all would be worse than the ghost row.
    const setup = await get("/api/setup").then((response) => response.json());
    expect(setup.missing).toContain("income_on_ledger");
  });

  it("brings the cheques back when it is restored", async () => {
    await addPayday();
    const template = await paychequeTemplate();

    const off = await patch(`/api/templates/${template.id}`, template.version, { active: false });
    const on = await patch(
      `/api/templates/${template.id}`,
      (off.json().template as { version: number }).version,
      { active: true },
    );
    expect(on.statusCode).toBe(200);

    expect((await cheques()).length).toBeGreaterThan(0);
    expect((await windows()).flatMap((window) => window.projectedPaycheques)).toEqual([]);
  });
});
