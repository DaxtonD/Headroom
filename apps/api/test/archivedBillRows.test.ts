/**
 * Getting a row off the ledger when the bill behind it is gone.
 *
 * Reported from use on 2026-11-21: a payment to savings was entered twice,
 * the duplicate bill was archived on Manage, and its row stayed on the
 * ledger with no way to remove it. That is the worst shape a bug can take in
 * this app - a figure that is wrong, visible several times a day, and
 * unfixable from the screen it is wrong on.
 *
 * Two separate holes put it there.
 *
 * The first: reconciliation refused to remove any row a person had touched,
 * where "touched" included editing the amount or confirming it. That rule is
 * right about never silently CHANGING somebody's edit and wrong about
 * keeping a row whose bill no longer exists. Money that has actually moved
 * is a different matter and still stays.
 *
 * The second: `DELETE /api/occurrences/:id` refused anything that was not a
 * one-off, on the grounds that the next generation run would undo it or make
 * it permanent depending on how the period key matched. True while the
 * template is still producing rows - and not true at all once it is
 * archived, which is exactly when somebody needs the row gone.
 *
 * Every amount here is invented.
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
  cookie = await signIn(harness, "alex@example.test", seeded.password);

  // The ledger is laid out in pay periods, so it needs a payday to anchor on.
  const payday = await post("/api/pay-schedules", {
    userId: seeded.alex.id,
    anchorDate: inDays(2),
    defaultCents: "200000",
  });
  expect(payday.statusCode, payday.body).toBe(201);
});

function headers() {
  return { cookie, "idempotency-key": randomUUID() };
}

function post(url: string, payload: unknown) {
  return harness.app.inject({ method: "POST", url, headers: headers(), payload });
}

function patch(url: string, version: number, payload: unknown) {
  return harness.app.inject({
    method: "PATCH",
    url,
    headers: { ...headers(), "if-match": `"${String(version)}"` },
    payload,
  });
}

function remove(url: string, version: number) {
  return harness.app.inject({
    method: "DELETE",
    url,
    headers: { ...headers(), "if-match": `"${String(version)}"` },
  });
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly isOneOff: boolean;
  readonly canRemove: boolean;
  readonly settled: boolean;
}

/** Every row on the ledger, which is what the household is looking at. */
async function ledger(): Promise<Row[]> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/api/pay-periods",
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  const periods = response.json().periods as { rows: Row[] }[];
  return periods.flatMap((period) => period.rows);
}

function named(rows: readonly Row[], name: string): Row | undefined {
  return rows.find((row) => row.name === name);
}

/** A monthly bill on a day a few days out, so its rows are still ahead. */
async function addBill(name: string, cents: string) {
  const [, month, day] = inDays(4).split("-");
  const created = await post("/api/templates", {
    name,
    kind: "bill",
    defaultCents: cents,
    withdrawal: "auto",
    schedule: { type: "monthly", day: Number(day), month: Number(month) },
    section: "fixed",
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().template as { id: string; version: number };
}

function archive(template: { id: string; version: number }) {
  return patch(`/api/templates/${template.id}`, template.version, { active: false });
}

/* -------------------------------------------------------------------------- */
/* Archiving the bill takes its rows with it                                  */
/* -------------------------------------------------------------------------- */

describe("archiving a bill", () => {
  it("takes an untouched row off the ledger", async () => {
    const template = await addBill("Savings", "83400");
    expect(named(await ledger(), "Savings")).toBeDefined();

    expect((await archive(template)).statusCode).toBe(200);
    expect(named(await ledger(), "Savings")).toBeUndefined();
  });

  /**
   * The reported case. Confirming an amount, or typing one in, says "this
   * figure is right" - it does not say "keep this row after the bill it came
   * from has been archived". Those were the same flag, and the household was
   * left with a duplicate savings payment they had confirmed and could not
   * remove.
   */
  it("takes a row that was confirmed off the ledger too", async () => {
    const template = await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");
    expect(row, "the row should exist to confirm").toBeDefined();

    const confirmed = await patch(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0, {
      verified: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    expect((await archive(template)).statusCode).toBe(200);
    expect(named(await ledger(), "Savings")).toBeUndefined();
  });

  it("takes a row whose amount was edited off the ledger too", async () => {
    const template = await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");

    const edited = await patch(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0, {
      cents: "92500",
    });
    expect(edited.statusCode, edited.body).toBe(200);

    expect((await archive(template)).statusCode).toBe(200);
    expect(named(await ledger(), "Savings")).toBeUndefined();
  });

  /**
   * The line the rule holds at. A tick says the money has left the account,
   * and the balance at the top has been brought down to match - so the row
   * is history, not a plan, and archiving the bill cannot unspend it.
   */
  it("keeps a row whose money has already gone", async () => {
    const template = await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");

    const paid = await patch(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0, {
      paid: true,
    });
    expect(paid.statusCode, paid.body).toBe(200);

    expect((await archive(template)).statusCode).toBe(200);

    const kept = named(await ledger(), "Savings");
    expect(kept, "a paid row is history and stays").toBeDefined();
    expect(kept?.settled).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The way out, for whatever archiving leaves behind                          */
/* -------------------------------------------------------------------------- */

describe("removing a row by hand", () => {
  it("is refused while the bill is still producing it", async () => {
    await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");
    expect(row?.canRemove, "a live bill's row offers no remove").toBe(false);

    const refused = await remove(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("not_a_one_off");
  });

  /**
   * Once the bill is archived nothing will put the row back, so the reason
   * for refusing is gone. This is the escape hatch: whatever reconciliation
   * decides to keep, the household can still get it off the ledger without
   * reaching for SQL.
   */
  it("is allowed once nothing will recreate it", async () => {
    const template = await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");

    const paid = await patch(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0, {
      paid: true,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await archive(template)).statusCode).toBe(200);

    const orphan = named(await ledger(), "Savings");
    expect(orphan, "the paid row is still there").toBeDefined();
    expect(orphan?.canRemove, "and can now be removed").toBe(true);

    const removed = await remove(`/api/occurrences/${orphan?.id ?? ""}`, orphan?.version ?? 0);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(named(await ledger(), "Savings")).toBeUndefined();
  });

  /** A one-off has no bill behind it and has always been removable. */
  it("is still allowed for a one-off", async () => {
    const created = await post("/api/occurrences", {
      name: "Dentist",
      cents: "-18750",
      kind: "bill",
      date: inDays(3),
    });
    expect(created.statusCode, created.body).toBe(201);

    const row = named(await ledger(), "Dentist");
    expect(row?.isOneOff).toBe(true);
    expect(row?.canRemove).toBe(true);

    const removed = await remove(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(named(await ledger(), "Dentist")).toBeUndefined();
  });

  /**
   * Soft-deleted rather than erased, like every other removal here, so the
   * history of what was on the ledger survives being tidied up.
   */
  it("keeps the record of what was removed", async () => {
    const template = await addBill("Savings", "83400");
    const row = named(await ledger(), "Savings");
    const paid = await patch(`/api/occurrences/${row?.id ?? ""}`, row?.version ?? 0, {
      paid: true,
    });
    expect(paid.statusCode).toBe(200);
    expect((await archive(template)).statusCode).toBe(200);

    const orphan = named(await ledger(), "Savings");
    expect((await remove(`/api/occurrences/${orphan?.id ?? ""}`, orphan?.version ?? 0)).statusCode).toBe(
      200,
    );

    const stored = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: orphan?.id ?? "" },
      select: { deletedAt: true, deletedById: true },
    });
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.deletedById).not.toBeNull();

    const activity = await harness.db.prisma.activity.findFirst({
      where: { entity: "occurrence", entityId: orphan?.id ?? "", action: "soft_delete" },
    });
    expect(activity, "the removal is in the history").not.toBeNull();
    expect(householdId).toBeTruthy();
  });
});
