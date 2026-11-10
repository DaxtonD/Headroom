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

  it("can be undone", async () => {
    await addPayday();
    const received = (await cheques())[0] as { id: string; version: number };

    await patch(`/api/occurrences/${received.id}`, received.version, { cleared: true });

    // It has to be reachable, or an accidental tap is permanent: clearing a
    // row takes it off the ledger, which is the only screen that lists rows.
    const listed = await get("/api/balance/cleared");
    expect(listed.statusCode).toBe(200);

    const body = listed.json() as {
      items: readonly { id: string; name: string; cents: string; version: number }[];
    };
    const found = body.items.find((item) => item.id === received.id);
    expect(found).toBeDefined();

    const undone = await patch(
      `/api/occurrences/${received.id}`,
      (found as { version: number }).version,
      { cleared: false },
    );
    expect(undone.statusCode).toBe(200);

    // Back on the ledger, editable again.
    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: received.id },
    });
    expect(reread.clearedAt).toBeNull();
    expect(reread.clearedById).toBeNull();

    const rows = (await windows()).flatMap((window) => window.rows);
    expect(rows.some((row) => row.id === received.id)).toBe(true);
  });

  it("offers nothing to undo when nothing has been marked", async () => {
    await addPayday();

    const body = await get("/api/balance/cleared").then((response) => response.json());
    expect(body.items).toEqual([]);
  });

  it("stops offering an undo once the balance has been entered", async () => {
    await addPayday();
    const received = (await cheques())[0] as { id: string; version: number };
    await patch(`/api/occurrences/${received.id}`, received.version, { cleared: true });

    // Typing in a new balance takes the cleared cheque into the figure itself.
    // Undoing it after that would put the row back on the ledger while the
    // money stayed in the balance, which is the same double count the other
    // way round - so it is deliberately no longer offered.
    expect((await post("/api/balance", { cents: "350000" })).statusCode).toBe(201);

    const body = await get("/api/balance/cleared").then((response) => response.json());
    expect(body.items).toEqual([]);
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
