/**
 * An edit under Manage reaches the ledger.
 *
 * Reported from a real setup: changing an expense appeared to do nothing. The
 * cause was that generation would not touch an occurrence that already
 * existed, and by then every occurrence to the horizon had been generated - so
 * a corrected amount, a fixed typo, a moved date and an archived bill all
 * changed the template and left the ledger exactly as it was. The rule that
 * protected a typed-in figure was also silently refusing every correction.
 *
 * What replaces it: a row nobody has touched follows its template, and a row
 * somebody has made their own is never written to again. These tests hold both
 * halves, and the second half is the important one - getting it wrong would
 * overwrite real figures.
 *
 * Also here: "every month, but I choose when to pay it" with a day chosen,
 * which puts a flexible item on the day the household plans to pay it.
 *
 * Every amount is invented; the dates are the structure under test.
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

/** A payday, so there is a horizon to generate to and cheques to hang from. */
async function addPayday(): Promise<void> {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + ((4 - date.getUTCDay() + 7) % 7));
  const response = await post("/api/pay-schedules", {
    userId: memberId,
    anchorDate: date.toISOString().slice(0, 10),
    defaultCents: "200000",
  });
  expect(response.statusCode).toBe(201);
}

interface Template {
  readonly id: string;
  readonly version: number;
}

async function addBill(payload: Record<string, unknown>): Promise<Template> {
  const response = await post("/api/templates", {
    kind: "bill",
    section: "fixed",
    ...payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json().template as Template;
}

function rowsOf(templateId: string) {
  return harness.db.prisma.occurrence.findMany({
    where: { templateId, deletedAt: null },
    orderBy: { date: "asc" },
  });
}

function generate() {
  return post("/api/templates/generate", {});
}

describe("a correction under Manage", () => {
  it("writes nothing at all when nothing has changed", async () => {
    /*
     * The property that makes reconciliation safe to run on a timer, on every
     * write and at every boot: a second pass over settled data touches no row.
     * Without it, every sweep would bump versions, which would make the other
     * phone's next save fail with a conflict about a change nobody made.
     */
    await addPayday();
    await addBill({ name: "Water", defaultCents: "14400", withdrawal: "auto", schedule: { type: "monthly", day: 18 } });

    await generate();
    const first = await generate();
    expect(first.json().generation.created).toBe(0);
    expect(first.json().generation.updated).toBe(0);
    expect(first.json().generation.removed).toBe(0);

    const second = await generate();
    expect(second.json().generation.updated).toBe(0);
    expect(second.json().generation.removed).toBe(0);
  });

  it("never rewrites the past", async () => {
    await addPayday();
    const bill = await addBill({
      name: "Power",
      defaultCents: "18600",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 18 },
    });

    // A row from last month, still showing as unpaid: the money has not moved
    // and it is nobody's business but the household's.
    const lastMonth = new Date();
    lastMonth.setUTCHours(0, 0, 0, 0);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 18);
    const old = await harness.db.prisma.occurrence.create({
      data: {
        householdId,
        templateId: bill.id,
        periodKey: `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, "0")}`,
        name: "Power",
        cents: -18_600n,
        kind: "bill",
        withdrawal: "auto",
        date: lastMonth,
      },
    });

    const changed = await patch(`/api/templates/${bill.id}`, bill.version, {
      name: "Power bill",
      defaultCents: "19500",
    });
    expect(changed.statusCode).toBe(200);

    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: old.id } });
    expect(reread.name).toBe("Power");
    expect(reread.cents).toBe(-18_600n);
    expect(reread.version).toBe(1);
  });

  it("leaves a verified row alone, and a row marked paid", async () => {
    await addPayday();
    const bill = await addBill({
      name: "Water",
      defaultCents: "14400",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 18 },
    });

    const generated = await rowsOf(bill.id);
    expect(generated.length).toBeGreaterThan(1);
    const verified = generated[0] as { id: string; version: number };
    const paid = generated[1] as { id: string; version: number };

    expect((await patch(`/api/occurrences/${verified.id}`, verified.version, { verified: true })).statusCode).toBe(200);
    expect((await patch(`/api/occurrences/${paid.id}`, paid.version, { cleared: true })).statusCode).toBe(200);

    const changed = await patch(`/api/templates/${bill.id}`, bill.version, { defaultCents: "15900" });
    expect(changed.statusCode).toBe(200);

    // "Verified" means somebody checked the amount against the bill, and
    // "paid" means the money has gone. Neither may be quietly restated.
    for (const id of [verified.id, paid.id]) {
      const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id } });
      expect(row.cents).toBe(-14_400n);
    }
  });

  it("moves a bill to its new day without leaving the old one behind", async () => {
    await addPayday();
    const bill = await addBill({
      name: "Internet",
      defaultCents: "11000",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 5 },
    });

    const before = await rowsOf(bill.id);
    expect(before.length).toBeGreaterThan(0);

    const moved = await patch(`/api/templates/${bill.id}`, bill.version, {
      schedule: { type: "monthly", day: 22 },
    });
    expect(moved.statusCode).toBe(200);

    const after = await rowsOf(bill.id);
    expect(after.length).toBe(before.length);
    for (const row of after) expect(row.date?.toISOString().slice(8, 10)).toBe("22");
  });

  it("changes who a bill belongs to", async () => {
    await addPayday();
    const bill = await addBill({
      name: "Phone",
      defaultCents: "8500",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 11 },
    });

    expect((await rowsOf(bill.id)).every((row) => row.ownerUserId === null)).toBe(true);

    const owned = await patch(`/api/templates/${bill.id}`, bill.version, { ownerUserId: memberId });
    expect(owned.statusCode).toBe(200);

    expect((await rowsOf(bill.id)).every((row) => row.ownerUserId === memberId)).toBe(true);
  });
});

describe("correcting a payday", () => {
  it("does not strand a flexible bill that was hanging off the old cheque", async () => {
    /*
     * Correcting a payday moves every cheque, so the one a flexible bill was
     * hanging from stops existing. The foreign key nulls the anchor on delete,
     * and a null anchor means "now" - which would put the bill in front of
     * every cheque on the ledger and drag the lowest point of the whole
     * horizon down with it, from a change to a date.
     */
    const thursday = new Date();
    thursday.setUTCHours(0, 0, 0, 0);
    thursday.setUTCDate(thursday.getUTCDate() + ((4 - thursday.getUTCDay() + 7) % 7));

    const created = await post("/api/pay-schedules", {
      userId: memberId,
      anchorDate: thursday.toISOString().slice(0, 10),
      defaultCents: "200000",
    });
    expect(created.statusCode).toBe(201);
    const schedule = created.json().paySchedule as { id: string; version: number };

    const power = await addBill({
      name: "Power",
      defaultCents: "18600",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly" },
    });

    const bill = (await rowsOf(power.id))[0] as { id: string; version: number };
    expect(bill).toBeDefined();

    // Verified, so reconciliation may not touch it: it has to be repaired
    // rather than regenerated.
    const verified = await patch(`/api/occurrences/${bill.id}`, bill.version, { verified: true });
    expect(verified.statusCode).toBe(200);
    const anchoredTo = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: bill.id },
      select: { anchorOccurrenceId: true },
    });
    expect(anchoredTo.anchorOccurrenceId).not.toBeNull();

    // The payday was a day out.
    const corrected = new Date(thursday);
    corrected.setUTCDate(corrected.getUTCDate() + 1);
    const moved = await patch(`/api/pay-schedules/${schedule.id}`, schedule.version, {
      anchorDate: corrected.toISOString().slice(0, 10),
    });
    expect(moved.statusCode).toBe(200);

    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: bill.id },
      select: { anchorOccurrenceId: true, verifiedAt: true },
    });
    expect(reread.verifiedAt).not.toBeNull();

    // It hangs off a cheque that exists, and not off the front of the ledger.
    expect(reread.anchorOccurrenceId).not.toBeNull();
    const nowAnchoredTo = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: reread.anchorOccurrenceId as string },
      select: { kind: true, deletedAt: true },
    });
    expect(nowAnchoredTo.kind).toBe("paycheque");
    expect(nowAnchoredTo.deletedAt).toBeNull();
  });
});

describe("every month, but I choose when to pay it", () => {
  it("puts it on the day it is planned for, still flexible", async () => {
    await addPayday();
    const visa = await addBill({
      name: "Visa",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const rows = await rowsOf(visa.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.date?.toISOString().slice(8, 10)).toBe("20");
      // The household chose the day, so nobody is taking the money on it: it
      // must never be counted as an automatic withdrawal to be covered.
      expect(row.withdrawal).toBe("flexible");
      expect(row.anchorOccurrenceId).toBeNull();
    }

    // And the ledger agrees: a dated row that is not one coverage is about.
    const dashboard = await get("/api/dashboard").then((response) => response.json());
    expect(dashboard.nextAutoWithdrawals.some((row: { name: string }) => row.name === "Visa")).toBe(
      false,
    );
  });

  it("follows the day being changed, and gives it up again", async () => {
    await addPayday();
    const visa = await addBill({
      name: "Visa",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const moved = await patch(`/api/templates/${visa.id}`, visa.version, {
      schedule: { type: "flexible", frequency: "monthly", day: 26 },
    });
    expect(moved.statusCode).toBe(200);
    for (const row of await rowsOf(visa.id)) {
      expect(row.date?.toISOString().slice(8, 10)).toBe("26");
    }

    // Taking the day away sends it back to hanging off a paycheque, on the
    // same rows rather than a second set.
    const before = (await rowsOf(visa.id)).length;
    const freed = await patch(
      `/api/templates/${visa.id}`,
      (moved.json().template as { version: number }).version,
      { schedule: { type: "flexible", frequency: "monthly" } },
    );
    expect(freed.statusCode).toBe(200);

    const after = await rowsOf(visa.id);
    expect(after.length).toBe(before);
    for (const row of after) {
      expect(row.date).toBeNull();
      expect(row.anchorOccurrenceId).not.toBeNull();
    }
  });

  it("can be re-dated from the ledger, and generation leaves that alone", async () => {
    await addPayday();
    const visa = await addBill({
      name: "Visa",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const row = (await rowsOf(visa.id))[0] as { id: string; version: number; date: Date | null };
    const chosen = `${(row.date as Date).toISOString().slice(0, 8)}27`;

    const redated = await patch(`/api/occurrences/${row.id}`, row.version, { date: chosen });
    expect(redated.statusCode).toBe(200);
    expect(redated.json().occurrence.date).toBe(chosen);

    // This month is being paid late on purpose. The next generation pass must
    // not put it back on the 20th.
    const swept = await generate();
    expect(swept.json().generation.updated).toBe(0);

    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: row.id } });
    expect(reread.date?.toISOString().slice(0, 10)).toBe(chosen);
  });

  it("gives up its date when it is hung off a payday instead", async () => {
    await addPayday();
    const visa = await addBill({
      name: "Visa",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const payday = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
      orderBy: { date: "asc" },
    });
    const row = (await rowsOf(visa.id))[0] as { id: string; version: number };

    const hung = await patch(`/api/occurrences/${row.id}`, row.version, {
      anchorOccurrenceId: payday.id,
    });
    expect(hung.statusCode).toBe(200);

    // One placement or the other, never both: the running balance has to have
    // exactly one answer for where this row goes.
    const reread = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: row.id } });
    expect(reread.date).toBeNull();
    expect(reread.anchorOccurrenceId).toBe(payday.id);
  });

  it("refuses a date and a payday in the same request", async () => {
    await addPayday();
    const visa = await addBill({
      name: "Visa",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const payday = await harness.db.prisma.occurrence.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
    });
    const row = (await rowsOf(visa.id))[0] as { id: string; version: number };

    const both = await patch(`/api/occurrences/${row.id}`, row.version, {
      date: "2026-12-27",
      anchorOccurrenceId: payday.id,
    });
    expect(both.statusCode).toBe(400);
  });

  it("refuses a day of the month on the every-payday frequency", async () => {
    await addPayday();
    const response = await post("/api/templates", {
      name: "Visa",
      kind: "bill",
      section: "fixed",
      defaultCents: "34000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "per_pay_period", day: 20 },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("an automatic withdrawal", () => {
  it("cannot be left without a date", async () => {
    await addPayday();
    const water = await addBill({
      name: "Water",
      defaultCents: "14400",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 18 },
    });
    const row = (await rowsOf(water.id))[0] as { id: string; version: number };

    // The bank has already chosen the day. Taking it away would leave a row
    // the running balance could not place.
    const cleared = await patch(`/api/occurrences/${row.id}`, row.version, { date: null });
    expect(cleared.statusCode).toBe(400);

    const hung = await patch(`/api/occurrences/${row.id}`, row.version, {
      anchorOccurrenceId: null,
    });
    expect(hung.statusCode).toBe(400);
  });
});
