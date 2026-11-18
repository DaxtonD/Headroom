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
  memberId = seeded.alex.id;
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

    // A balance has to exist for clearing to have anywhere to put the money:
    // the effective balance is the snapshot plus what cleared after it, and
    // with no snapshot there is nothing to add to. Every real household has
    // typed one in.
    expect((await post("/api/balance", { cents: "50000" })).statusCode).toBe(201);

    const before = await cheques();
    expect(before.length).toBeGreaterThan(0);
    const received = before[0] as { id: string; version: number };

    // Nothing is projected while the real cheque is on the ledger.
    expect((await windows()).flatMap((window) => window.projectedPaycheques)).toEqual([]);

    /*
     * The figure to hold steady is the end of the horizon, not a window's
     * "coming in".
     *
     * Clearing moves money from a row into the opening balance, so which
     * window's total changes depends on whether the cheque fell in the first
     * window - which depends on what day it is. What must never change is the
     * total: money is not created or destroyed by saying it has arrived.
     */
    const endBefore = await get("/api/dashboard")
      .then((response) => response.json())
      .then((body) => BigInt(body.leftThisCycleCents as string));

    const marked = await patch(`/api/occurrences/${received.id}`, received.version, {
      cleared: true,
    });
    expect(marked.statusCode).toBe(200);

    /*
     * The money is in the balance now, so projecting the cheque as well counts
     * the same pay twice - and puts an "Expected" row on the ledger that
     * cannot be opened, exactly where the real row used to be.
     */
    expect((await windows()).flatMap((window) => window.projectedPaycheques)).toEqual([]);

    const endAfter = await get("/api/dashboard")
      .then((response) => response.json())
      .then((body) => BigInt(body.leftThisCycleCents as string));
    expect(endAfter).toBe(endBefore);
  });

  it("does not leave one behind when it is marked received either", async () => {
    /*
     * The same guarantee for the other gesture, and the one that was easy to
     * miss: the engine used to decide a cheque had landed by looking at
     * `clearedAt` alone.
     *
     * Once a tick settles a row, a cheque marked received is in the balance -
     * but with only `clearedAt` consulted it still looked unarrived, so the
     * schedule projected a second copy of the same pay. That overstates the
     * account, which is the one direction that is not safe.
     */
    await addPayday();
    expect((await post("/api/balance", { cents: "50000" })).statusCode).toBe(201);

    const received = (await cheques())[0] as { id: string; version: number };
    const endBefore = await get("/api/dashboard")
      .then((response) => response.json())
      .then((body) => BigInt(body.leftThisCycleCents as string));

    const marked = await patch(`/api/occurrences/${received.id}`, received.version, {
      paid: true,
    });
    expect(marked.statusCode).toBe(200);

    expect((await windows()).flatMap((window) => window.projectedPaycheques)).toEqual([]);

    // Saying the pay has arrived does not create any.
    const endAfter = await get("/api/dashboard")
      .then((response) => response.json())
      .then((body) => BigInt(body.leftThisCycleCents as string));
    expect(endAfter).toBe(endBefore);
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
   * What "mark as paid" means, revised with the household on 2026-11-17.
   *
   * It was a tick that moved nothing, because one flag doing both jobs is
   * what let a bill be subtracted twice - once inside the figure read off the
   * bank, once again by the tick. Moving nothing made that impossible rather
   * than merely fixed, and it was the right call at the time.
   *
   * The household then asked for the balance to follow the tick, and gave
   * the reasoning: they pay the bill and then tell the app they have, so
   * between one typed balance and the next, the honest figure at the top is
   * the last one less what they know has gone.
   *
   * The double subtraction is kept out by a different guard instead. A row
   * settles ONCE, at the earlier of `paidAt` and `clearedAt`, and only counts
   * when that moment is strictly after the newest snapshot - so the instant
   * somebody types what the bank actually says, every earlier tick drops out
   * and the typed figure stands alone.
   *
   * Three things are tested here: the row stays on the ledger, because a
   * ledger whose lines disappear is the complaint this all started from; the
   * balance comes down by the bill exactly once; and a typed figure
   * supersedes a tick rather than stacking with it.
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

  async function bill(): Promise<{ id: string; version: number; cents: bigint }> {
    const soon = new Date();
    soon.setUTCHours(0, 0, 0, 0);
    soon.setUTCDate(soon.getUTCDate() + 3);

    const created = await post("/api/templates", {
      name: "Power",
      kind: "bill",
      section: "fixed",
      defaultCents: "14700",
      withdrawal: "auto",
      schedule: { type: "monthly", day: soon.getUTCDate() },
    });
    expect(created.statusCode).toBe(201);

    const row = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { householdId, name: "Power" },
      orderBy: { date: "asc" },
      select: { id: true, version: true, cents: true },
    });
    return row;
  }

  it("stays on the ledger for a fortnight, then ages out", async () => {
    /*
     * The tail, and why it is this short.
     *
     * It only has to answer "is that one paid?" for the cycle you paid it
     * in. It does not have to bridge the gap to the next one: the horizon
     * runs four paycheques ahead, so next month's instance of a monthly bill
     * has been on screen for weeks before this month's goes. A bill never
     * disappears from the ledger - one month of it does, once its successor
     * is already there.
     *
     * Measured from the tick rather than from the row's date, because a
     * flexible row has no date of its own and would otherwise never age out.
     * Back-dated here in the database: the alternative is waiting a
     * fortnight, and the server clock is what decides.
     */
    await addPayday();
    expect((await post("/api/balance", { cents: "80000" })).statusCode).toBe(201);
    const target = await bill();
    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    const onLedger = async (): Promise<boolean> =>
      (await windows()).flatMap((window) => window.rows).some((row) => row.id === target.id);

    expect(await onLedger(), "just ticked, so plainly still there").toBe(true);

    const daysAgo = (days: number): Date => {
      const when = new Date();
      when.setUTCDate(when.getUTCDate() - days);
      return when;
    };

    await harness.db.prisma.occurrence.update({
      where: { id: target.id },
      data: { paidAt: daysAgo(5) },
    });
    expect(await onLedger(), "inside the fortnight, still checkable").toBe(true);

    await harness.db.prisma.occurrence.update({
      where: { id: target.id },
      data: { paidAt: daysAgo(20) },
    });
    expect(await onLedger(), "past the fortnight, quietly gone").toBe(false);
  });

  it("takes the bill off the balance at the top", async () => {
    /*
     * This asserted the opposite until 2026-11-17: a tick moved no figure,
     * and the bank balance was the only thing that could.
     *
     * The household asked for the other behaviour and the reasoning is
     * theirs: they pay a bill and then tell the app they have, so between
     * typing one balance and typing the next, the honest figure is the last
     * one less what they know has gone. The app suggests; the typed figure
     * still decides, and the test below pins that.
     */
    await addPayday();
    expect((await post("/api/balance", { cents: "80000" })).statusCode).toBe(201);
    const target = await bill();

    const before = await figures();
    const ticked = await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json().occurrence.paid).toBe(true);

    const after = await figures();
    const moved = BigInt(before.balance as string) - BigInt(after.balance as string);
    expect(moved, "the balance comes down by the bill, exactly once").toBe(
      -BigInt(target.cents),
    );
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
    expect(found?.paidBy?.name).toBe("Alex");
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
    // What was asked for, and it holds by construction: each cycle is its own
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

  it("drops off the balance checklist once it is ticked", async () => {
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

    // Before the tick it is a candidate: dated today, nobody has said what
    // happened to it.
    const offered = await get("/api/balance/clearable").then((response) => response.json());
    expect(offered.candidates.map((one: { id: string }) => one.id)).toContain(water.id);

    await patch(`/api/occurrences/${water.id}`, water.version, { paid: true });

    /*
     * After the tick it is gone from the checklist, and that is the fix.
     *
     * It used to arrive PRE-TICKED instead, on the reasoning that somebody
     * who has said "we paid this" means "it is inside the figure I am about
     * to type" as well. Sound, and it meant one Save cleared those rows off
     * the ledger with nothing on screen to say it would - which is how a bill
     * disappeared in ordinary use on 2026-11-17.
     *
     * Now a settled row is already inside the figure at the top, so this list
     * has nothing left to do with it. What it still asks about is the genuine
     * remainder: things that came out without anybody ticking them.
     */
    const after = await get("/api/balance/clearable").then((response) => response.json());
    expect(after.candidates.map((one: { id: string }) => one.id)).not.toContain(water.id);
  });

  it("cannot subtract a bill the typed-in balance already counted", async () => {
    /*
     * The bug this design has to keep out: the same bill taken off twice,
     * once by the bank and once by the app, leaving the household short with
     * nothing on screen to say why.
     *
     * The guard is that a row settles ONCE, at the earlier of its two
     * timestamps. Here the checklist clears it as part of the snapshot, so it
     * carries that snapshot's own `asOf`; ticking it paid afterwards writes a
     * later `paidAt`, but the earlier one still decides, and the comparison
     * against the snapshot is a strict `>`. So the tick changes nothing.
     *
     * Taking the LATER timestamp instead would subtract the bill a second
     * time here, which is why `settledMoment` exists at all.
     */
    await addPayday();
    const target = await bill();

    // The figure read off the bank, with the bill named as already out.
    const typed = await post("/api/balance", {
      cents: "61400",
      clearedOccurrenceIds: [target.id],
    });
    expect(typed.statusCode).toBe(201);

    const before = await figures();
    expect(before.balance).toBe("61400");

    const current = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { id: target.id },
      select: { version: true },
    });
    await patch(`/api/occurrences/${target.id}`, current.version, { paid: true });

    expect((await figures()).balance).toBe(before.balance);
  });

  it("lets the typed figure supersede a tick rather than stacking with it", async () => {
    /*
     * The other half, and the household's own rule for the whole feature:
     * the app suggests what the balance should be from what it knows, and
     * the frequent manual updates define what really exists.
     *
     * Tick a bill and the figure at the top comes down. Then read the bank -
     * which already has the bill out of it, and two card purchases besides -
     * and type that. The tick is now older than the snapshot, so it stops
     * being applied and the typed figure stands alone. Nothing has to be
     * reversed and no flag is cleared; the strict `>` does all of it.
     */
    await addPayday();
    const target = await bill();

    expect((await post("/api/balance", { cents: "80000" })).statusCode).toBe(201);
    await patch(`/api/occurrences/${target.id}`, target.version, { paid: true });

    // Suggested: 80000 less the bill. Reality: lower still, by whatever was
    // spent on the cards in between.
    expect((await figures()).balance).toBe("65300");

    expect((await post("/api/balance", { cents: "59300" })).statusCode).toBe(201);
    expect((await figures()).balance).toBe("59300");
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
