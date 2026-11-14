/**
 * The integrity tests HANDOFF section 16.8 requires for M2, against a real
 * Postgres. Each one maps to a numbered requirement:
 *
 *  1. Same field from the same base version -> second gets 409, naming the
 *     first user and value.
 *  2. Different fields -> both apply, version advances twice, second says
 *     `merged: true`.
 *  3. Same Idempotency-Key three times -> one effect, identical responses.
 *     Same key, different body -> 422.
 *  4. Recurrence generation run concurrently twice -> no duplicates.
 *  5. Balance snapshots cannot be updated or deleted; a correction is a new
 *     row and the derived balance follows the latest.
 *  6. PATCH without If-Match -> 428.
 *
 * (The offline test from 16.8 is a web-app behaviour and lives with the client.)
 *
 * Amounts here are invented.
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
let carolCookie: string;
let daxCookie: string;
let householdId: string;
let carolId: string;
let accountId: string;

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
  carolId = seeded.carol.id;
  accountId = seeded.account.id;
  carolCookie = await signIn(harness, "carol@example.test", seeded.password);
  daxCookie = await signIn(harness, "dax@example.test", seeded.password);
});

/** A flexible bill, which is what the UI edits most. */
async function makeBill(cents: bigint, name = "Power") {
  return harness.db.prisma.occurrence.create({
    data: {
      householdId,
      name,
      cents,
      kind: "bill",
      withdrawal: "flexible",
      createdById: carolId,
    },
  });
}

function patch(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
  options: { baseVersion?: number; key?: string; omitIfMatch?: boolean } = {},
) {
  const headers: Record<string, string> = {
    cookie,
    "idempotency-key": options.key ?? randomUUID(),
  };
  if (!options.omitIfMatch) {
    headers["if-match"] = `"${options.baseVersion ?? 1}"`;
  }

  return harness.app.inject({
    method: "PATCH",
    url: `/api/occurrences/${id}`,
    headers,
    payload: body,
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Same field, same base version                                           */
/* -------------------------------------------------------------------------- */

describe("two people change the SAME field from the same version", () => {
  it("applies the first and returns 409 to the second, naming who and what", async () => {
    const bill = await makeBill(-12_345n);

    // Carol verifies it at her figure.
    const first = await patch(carolCookie, bill.id, { cents: "14000" }, { baseVersion: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json().occurrence.version).toBe(2);

    // Dax was looking at version 1 and types a different amount.
    const second = await patch(daxCookie, bill.id, { cents: "15500" }, { baseVersion: 1 });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe("version_conflict");
    expect(body.changedFields).toEqual(["cents"]);
    expect(body.changedBy.name).toBe("Carol");
    // The current value is returned so the UI can offer "Keep $140.00".
    // Integer cents on the wire: $140.00 is "14000".
    expect(body.current.cents).toBe("14000");
    expect(body.changedAt).toBeDefined();
    // The version that won, so "Use mine" can be resent without a refetch.
    expect(body.current.version).toBe(2);
  });

  it("does not apply the losing change", async () => {
    const bill = await makeBill(-12_345n);

    await patch(carolCookie, bill.id, { cents: "14000" }, { baseVersion: 1 });
    await patch(daxCookie, bill.id, { cents: "15500" }, { baseVersion: 1 });

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.cents).toBe(14_000n);
    expect(row.version).toBe(2);
  });

  it("lets the loser retry against the new version, and logs the override", async () => {
    const bill = await makeBill(-12_345n);

    await patch(carolCookie, bill.id, { cents: "14000", verified: true }, { baseVersion: 1 });

    // "Use $155.00" (sent as 15500 cents): resent against version 2, which also un-verifies it.
    const override = await patch(
      daxCookie,
      bill.id,
      { cents: "15500", verified: false },
      { baseVersion: 2 },
    );
    expect(override.statusCode).toBe(200);

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.cents).toBe(15_500n);
    expect(row.verifiedAt).toBeNull();

    // Who overrode what is in the history.
    const history = await harness.app
      .inject({ method: "GET", url: `/api/occurrences/${bill.id}/history`, headers: { cookie: daxCookie } })
      .then((response) => response.json().history);

    expect(history[0].by.name).toBe("Dax");
    expect(history[0].fields).toContain("cents");
    expect(history[0].before.cents).toBe("14000");
    expect(history[0].after.cents).toBe("15500");
  });

  it("refuses a version that is ahead of the row", async () => {
    const bill = await makeBill(-12_345n);
    const response = await patch(carolCookie, bill.id, { cents: "100" }, { baseVersion: 99 });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("version_ahead");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Different fields                                                        */
/* -------------------------------------------------------------------------- */

describe("two people change DIFFERENT fields from the same version", () => {
  it("applies both, advances the version twice, and reports the merge", async () => {
    const paycheque = await harness.db.prisma.occurrence.create({
      data: {
        householdId,
        name: "Pay",
        cents: 175_000n,
        kind: "paycheque",
        withdrawal: "auto",
        date: new Date("2026-11-26T00:00:00.000Z"),
        createdById: carolId,
      },
    });
    const bill = await makeBill(-12_345n);

    // Carol verifies the amount.
    const first = await patch(carolCookie, bill.id, { verified: true }, { baseVersion: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json().merged).toBe(false);
    expect(first.json().occurrence.version).toBe(2);

    // Dax, still on version 1, moves it to a later payday. Different field, so
    // both changes stand and nobody is interrupted.
    const second = await patch(
      daxCookie,
      bill.id,
      { anchorOccurrenceId: paycheque.id },
      { baseVersion: 1 },
    );

    expect(second.statusCode).toBe(200);
    expect(second.json().merged).toBe(true);
    expect(second.json().occurrence.version).toBe(3);

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.verifiedAt).not.toBeNull();
    expect(row.anchorOccurrenceId).toBe(paycheque.id);
    expect(row.version).toBe(3);
  });

  it("records both changes in the history, each with its own fields", async () => {
    const bill = await makeBill(-12_345n);

    await patch(carolCookie, bill.id, { verified: true }, { baseVersion: 1 });
    await patch(daxCookie, bill.id, { name: "Power bill" }, { baseVersion: 1 });

    const activities = await harness.db.prisma.activity.findMany({
      where: { entity: "occurrence", entityId: bill.id },
      orderBy: { versionAfter: "asc" },
    });

    // Two updates. There is no create entry because this fixture inserts the
    // row directly rather than through POST /api/occurrences.
    expect(activities).toHaveLength(2);
    expect(activities[0]?.fields).toEqual(["verified"]);
    expect(activities[1]?.fields).toEqual(["name"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Idempotency                                                             */
/* -------------------------------------------------------------------------- */

describe("idempotency", () => {
  it("applies the same key three times once, with identical responses", async () => {
    const bill = await makeBill(-12_345n);
    const key = randomUUID();
    const body = { cents: "13150" };

    const first = await patch(carolCookie, bill.id, body, { baseVersion: 1, key });
    const second = await patch(carolCookie, bill.id, body, { baseVersion: 1, key });
    const third = await patch(carolCookie, bill.id, body, { baseVersion: 1, key });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);

    // Byte-identical: a retry gets the stored response, not a recomputed one.
    expect(second.json()).toEqual(first.json());
    expect(third.json()).toEqual(first.json());

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    // One effect: the version moved once, not three times.
    expect(row.version).toBe(2);
    expect(row.cents).toBe(13_150n);

    const activities = await harness.db.prisma.activity.count({
      where: { entity: "occurrence", entityId: bill.id, action: "update" },
    });
    expect(activities).toBe(1);
  });

  it("returns 422 for the same key with a different body", async () => {
    const bill = await makeBill(-12_345n);
    const key = randomUUID();

    const first = await patch(carolCookie, bill.id, { cents: "13150" }, { baseVersion: 1, key });
    expect(first.statusCode).toBe(200);

    const reused = await patch(carolCookie, bill.id, { cents: "99999" }, { baseVersion: 1, key });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error).toBe("idempotency_key_reused");

    // The second amount was not applied.
    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.cents).toBe(13_150n);
  });

  it("creates a one-off once however many times the tap is repeated", async () => {
    const key = randomUUID();
    const payload = { name: "Christmas bonus", cents: "27500", kind: "deposit" as const };

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        harness.app.inject({
          method: "POST",
          url: "/api/occurrences",
          headers: { cookie: carolCookie, "idempotency-key": key },
          payload,
        }),
      ),
    );

    for (const response of responses) {
      expect([201, 200]).toContain(response.statusCode);
    }

    const count = await harness.db.prisma.occurrence.count({ where: { name: "Christmas bonus" } });
    expect(count).toBe(1);
  });

  it("refuses a mutation with no Idempotency-Key at all", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "if-match": '"1"' },
      payload: { cents: "100" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("idempotency_key_required");
  });

  it("refuses a key that is not a UUID", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "if-match": '"1"', "idempotency-key": "not-a-uuid" },
      payload: { cents: "100" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("idempotency_key_invalid");
  });

  it("survives the same key arriving twice at once", async () => {
    const bill = await makeBill(-12_345n);
    const key = randomUUID();
    const body = { cents: "13150" };

    // Both in flight together: one wins the primary key, the other replays it.
    const [a, b] = await Promise.all([
      patch(carolCookie, bill.id, body, { baseVersion: 1, key }),
      patch(carolCookie, bill.id, body, { baseVersion: 1, key }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());

    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.version).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Concurrent recurrence generation                                        */
/* -------------------------------------------------------------------------- */

describe("recurrence generation run twice at once", () => {
  it("creates no duplicate occurrences", async () => {
    const template = await harness.db.prisma.template.create({
      data: {
        householdId,
        kind: "bill",
        name: "Power",
        defaultCents: 12_345n,
        withdrawal: "flexible",
        scheduleType: "flexible",
        scheduleJson: { frequency: "monthly" },
      },
    });

    const generate = () =>
      harness.db.prisma.occurrence.create({
        data: {
          householdId,
          templateId: template.id,
          // The unique (templateId, periodKey) constraint is what makes this
          // safe, however many generators run at once.
          periodKey: "2026-11",
          name: "Power",
          cents: -12_345n,
          kind: "bill",
          withdrawal: "flexible",
        },
      });

    const results = await Promise.allSettled([generate(), generate(), generate()]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    const count = await harness.db.prisma.occurrence.count({
      where: { templateId: template.id, periodKey: "2026-11" },
    });
    expect(count).toBe(1);
  });

  it("still allows a different period for the same template", async () => {
    const template = await harness.db.prisma.template.create({
      data: {
        householdId,
        kind: "bill",
        name: "Power",
        defaultCents: 12_345n,
        withdrawal: "flexible",
        scheduleType: "flexible",
        scheduleJson: { frequency: "monthly" },
      },
    });

    for (const periodKey of ["2026-11", "2026-12", "2027-01"]) {
      await harness.db.prisma.occurrence.create({
        data: {
          householdId,
          templateId: template.id,
          periodKey,
          name: "Power",
          cents: -12_345n,
          kind: "bill",
          withdrawal: "flexible",
        },
      });
    }

    expect(await harness.db.prisma.occurrence.count({ where: { templateId: template.id } })).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Balance snapshots                                                      */
/* -------------------------------------------------------------------------- */

describe("balance snapshots", () => {
  it("records a new snapshot and clears what the user ticked, in one go", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie: carolCookie, "idempotency-key": randomUUID() },
      payload: { cents: "41000", clearedOccurrenceIds: [bill.id] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().snapshot.cents).toBe("41000");
    expect(response.json().clearedCount).toBe(1);

    const cleared = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(cleared.clearedAt).not.toBeNull();
    expect(cleared.clearedById).toBe(carolId);
  });

  it("cannot be updated or deleted; a correction is a new row", async () => {
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie: carolCookie, "idempotency-key": randomUUID() },
      payload: { cents: "41000" },
    });
    expect(first.statusCode).toBe(201);
    const snapshotId = first.json().snapshot.id;

    await expect(
      harness.db.pool.query(`UPDATE "balance_snapshot" SET "cents" = 1 WHERE "id" = $1`, [snapshotId]),
    ).rejects.toThrow(/insert-only/i);

    await expect(
      harness.db.pool.query(`DELETE FROM "balance_snapshot" WHERE "id" = $1`, [snapshotId]),
    ).rejects.toThrow(/insert-only/i);

    // The correction: a second snapshot.
    const corrected = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie: carolCookie, "idempotency-key": randomUUID() },
      payload: { cents: "52750" },
    });
    expect(corrected.statusCode).toBe(201);

    expect(await harness.db.prisma.balanceSnapshot.count()).toBe(2);
  });

  it("makes the derived balance follow the latest snapshot", async () => {
    // Integer cents on the wire: $410.00 then a correction to $527.50.
    for (const cents of ["41000", "52750"]) {
      await harness.app.inject({
        method: "POST",
        url: "/api/balance",
        headers: { cookie: carolCookie, "idempotency-key": randomUUID() },
        payload: { cents },
      });
    }

    const dashboard = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie: carolCookie } })
      .then((response) => response.json());

    expect(dashboard.balance.snapshotCents).toBe("52750");
  });

  it("counts anything cleared since the snapshot towards the current balance", async () => {
    /*
     * The snapshot is written straight to the table with an `asOf` a second
     * ago, rather than posted and then back-dated: snapshots are append-only
     * by database trigger, which is the rule working, and an UPDATE is refused.
     *
     * A second matters because the comparison is deliberately strict. Anything
     * cleared as PART of a snapshot carries that snapshot's own timestamp and
     * must not be counted against it again, so two timestamps landing on the
     * same millisecond decide between counting and not - and two requests in a
     * test are easily that close, which made this fail about one run in three.
     * A person typing a balance and then marking a bill paid is never within a
     * millisecond of themselves.
     */
    await harness.db.prisma.balanceSnapshot.create({
      data: {
        accountId,
        cents: 41_000n,
        asOf: new Date(Date.now() - 1000),
        enteredById: carolId,
      },
    });

    const bill = await makeBill(-15_000n);

    // Marking it paid after the snapshot means the money has already gone.
    const cleared = await patch(carolCookie, bill.id, { cleared: true }, { baseVersion: 1 });
    expect(cleared.statusCode).toBe(200);

    const dashboard = await harness.app
      .inject({ method: "GET", url: "/api/dashboard", headers: { cookie: carolCookie } })
      .then((response) => response.json());

    // 530.00 typed in, less the 150.00 that cleared afterwards.
    expect(dashboard.balance.cents).toBe("26000");
    expect(dashboard.balance.snapshotCents).toBe("41000");

    // And it has left the timeline.
    const timeline = await harness.app
      .inject({ method: "GET", url: "/api/timeline", headers: { cookie: carolCookie } })
      .then((response) => response.json());
    expect(timeline.rows.map((row: { id: string }) => row.id)).not.toContain(bill.id);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. If-Match                                                               */
/* -------------------------------------------------------------------------- */

describe("If-Match", () => {
  it("returns 428 when a change does not say which version it saw", async () => {
    const bill = await makeBill(-12_345n);

    const response = await patch(carolCookie, bill.id, { cents: "100" }, { omitIfMatch: true });

    expect(response.statusCode).toBe(428);
    expect(response.json().error).toBe("version_required");
  });

  it("accepts baseVersion in the body instead of the header", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "idempotency-key": randomUUID() },
      payload: { cents: "100", baseVersion: 1 },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses If-Match: *, which would be a blind overwrite', async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "idempotency-key": randomUUID(), "if-match": "*" },
      payload: { cents: "100" },
    });

    expect(response.statusCode).toBe(428);
  });
});

/* -------------------------------------------------------------------------- */
/* Commands that are already true                                             */
/* -------------------------------------------------------------------------- */

describe("repeating a command that is already true", () => {
  it("is a no-op that returns the current state", async () => {
    const bill = await makeBill(-12_345n);

    const first = await patch(carolCookie, bill.id, { verified: true }, { baseVersion: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json().noop).toBe(false);
    expect(first.json().occurrence.version).toBe(2);

    // Verifying it again, with a fresh key so it is not an idempotency replay.
    const again = await patch(carolCookie, bill.id, { verified: true }, { baseVersion: 2 });
    expect(again.statusCode).toBe(200);
    expect(again.json().noop).toBe(true);
    // The version did not move, and no history entry was written.
    expect(again.json().occurrence.version).toBe(2);

    const updates = await harness.db.prisma.activity.count({
      where: { entity: "occurrence", entityId: bill.id, action: { in: ["verify", "update"] } },
    });
    expect(updates).toBe(1);
  });

  it("does not clear an already-cleared bill twice", async () => {
    const bill = await makeBill(-12_345n);

    await patch(carolCookie, bill.id, { cleared: true }, { baseVersion: 1 });
    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });

    const again = await patch(carolCookie, bill.id, { cleared: true }, { baseVersion: 2 });
    expect(again.json().noop).toBe(true);

    const after = await harness.db.prisma.occurrence.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.clearedAt?.getTime()).toBe(row.clearedAt?.getTime());
  });

  it("rejects a request that changes nothing at all", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("nothing_to_change");
  });

  it("refuses a field that is not editable, rather than ignoring it", async () => {
    const bill = await makeBill(-12_345n);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { cookie: carolCookie, "if-match": '"1"', "idempotency-key": randomUUID() },
      // Running balances are derived, never stored, so this must not be
      // quietly accepted.
      payload: { runningCents: "1000" },
    });

    expect(response.statusCode).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Household isolation                                                        */
/* -------------------------------------------------------------------------- */

describe("household isolation", () => {
  it("will not let one household touch another's data", async () => {
    const otherHousehold = await harness.db.prisma.household.create({
      data: { name: "Someone else" },
    });
    const otherBill = await harness.db.prisma.occurrence.create({
      data: {
        householdId: otherHousehold.id,
        name: "Not ours",
        cents: -1_000n,
        kind: "bill",
        withdrawal: "flexible",
      },
    });

    const response = await patch(carolCookie, otherBill.id, { cents: "100" }, { baseVersion: 1 });
    expect(response.statusCode).toBe(404);

    const untouched = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: otherBill.id },
    });
    expect(untouched.cents).toBe(-1_000n);
  });

  it("requires a session for every one of these routes", async () => {
    const bill = await makeBill(-12_345n);

    for (const [method, url] of [
      ["GET", "/api/dashboard"],
      ["GET", "/api/timeline"],
      ["GET", "/api/pay-periods"],
      ["GET", "/api/events"],
      ["GET", `/api/occurrences/${bill.id}/history`],
    ] as const) {
      const response = await harness.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }

    const write = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${bill.id}`,
      headers: { "if-match": '"1"', "idempotency-key": randomUUID() },
      payload: { cents: "100" },
    });
    expect(write.statusCode).toBe(401);
  });
});
