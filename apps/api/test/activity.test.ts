/**
 * The activity log, end to end against a real Postgres.
 *
 * The point of these is not that the endpoint returns rows. It is that the
 * rows carry enough to make a sentence - a log that says "Alex updated
 * occurrence 4f3a..." is a log nobody opens twice. So each test drives a real
 * mutation through the API and then checks what the log says about it, in the
 * same words the household will read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activitySentence } from "@headroom/core";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

interface Entry {
  readonly action: string;
  readonly entity: string;
  readonly label: string | null;
  readonly labelKind: string | null;
  readonly fields: readonly string[];
  readonly after: Record<string, unknown> | null;
  readonly by: { readonly name: string };
}

async function feed(cookie: string, query = ""): Promise<{ entries: Entry[]; nextBefore: string | null }> {
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/activity${query}`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { entries: Entry[]; nextBefore: string | null };
}

/** What the household actually sees: the engine's sentence for a row. */
function sentences(entries: readonly Entry[]): string[] {
  return entries.map((entry) => activitySentence(entry.by.name, entry));
}

describe("the log is readable", () => {
  it("says who updated which balance", async () => {
    const { alex, account } = await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const saved = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "123456" },
    });
    expect(saved.statusCode, saved.body).toBe(201);

    const { entries } = await feed(cookie);
    expect(sentences(entries)).toContain("Alex updated the Chequing balance");
    expect(entries[0]?.by.name).toBe(alex.name);
  });

  it("names the bill that was verified and the one that was marked paid", async () => {
    await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/occurrences",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { name: "Window repair", cents: "-14000", date: "2026-12-02", kind: "bill" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { occurrence: { id: string } }).occurrence.id;

    for (const change of [{ verified: true }, { paid: true }]) {
      const patched = await harness.app.inject({
        method: "PATCH",
        url: `/api/occurrences/${id}`,
        headers: { cookie, "idempotency-key": crypto.randomUUID(), "if-match": "1" },
        payload: change,
      });
      expect(patched.statusCode, patched.body).toBe(200);
    }

    const said = sentences((await feed(cookie)).entries);
    expect(said).toContain("Alex verified Window repair");
    expect(said).toContain("Alex marked Window repair paid");
    expect(said).toContain("Alex added Window repair");
  });

  it("follows a work expense from bought to submitted", async () => {
    await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/reimbursements",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { purchase: "Safety boots", cents: "19900", boughtOn: "2026-11-14" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { reimbursement: { id: string } }).reimbursement.id;

    const submitted = await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${id}`,
      headers: { cookie, "idempotency-key": crypto.randomUUID(), "if-match": "1" },
      payload: { submitted: true },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const said = sentences((await feed(cookie)).entries);
    expect(said).toContain("Alex bought Safety boots");
    expect(said).toContain("Alex submitted Safety boots for reimbursement");
  });
});

describe("what the log will and will not show", () => {
  it("shows the other person's work, and only this household's", async () => {
    const { household, jordan, account } = await seedHousehold(harness);
    const alexCookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const jordanCookie = await signIn(harness, "jordan@example.test", "correct-horse-battery-staple");

    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie: jordanCookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "5000" },
    });

    // A second household's activity must never appear in the first one's log.
    const other = await harness.db.prisma.household.create({ data: { name: "Someone else" } });
    await harness.db.prisma.activity.create({
      data: {
        householdId: other.id,
        userId: jordan.id,
        action: "create",
        entity: "occurrence",
        entityId: crypto.randomUUID(),
        versionAfter: 1,
        fields: ["name"],
        label: "Not yours",
      },
    });

    const { entries } = await feed(alexCookie);
    expect(sentences(entries)).toContain("Jordan updated the Chequing balance");
    expect(entries.every((entry) => entry.label !== "Not yours")).toBe(true);
    expect(household.id).not.toBe(other.id);
  });

  it("refuses an unsigned request", async () => {
    await seedHousehold(harness);
    const response = await harness.app.inject({ method: "GET", url: "/api/activity" });
    expect(response.statusCode).toBe(401);
  });
});

describe("paging", () => {
  it("hands back a cursor only while there is more, and never repeats a row", async () => {
    const { household, alex } = await seedHousehold(harness);

    // Written straight to the table: this is about paging, and driving 25
    // real mutations would test generation instead.
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);
    for (let index = 0; index < 25; index += 1) {
      await harness.db.prisma.activity.create({
        data: {
          householdId: household.id,
          userId: alex.id,
          at: new Date(base + index * 60_000),
          action: "verify",
          entity: "occurrence",
          entityId: crypto.randomUUID(),
          versionAfter: 2,
          fields: ["verified"],
          label: `Bill ${String(index)}`,
          labelKind: "bill",
        },
      });
    }

    const first = await feed(await signIn(harness, "alex@example.test", "correct-horse-battery-staple"), "?limit=10");
    expect(first.entries).toHaveLength(10);
    expect(first.nextBefore).not.toBeNull();
    // Newest first.
    expect(first.entries[0]?.label).toBe("Bill 24");

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const seen = new Set<string>(first.entries.map((entry) => entry.label ?? ""));
    let cursor = first.nextBefore;
    let pages = 1;

    while (cursor !== null && pages < 10) {
      const next = await feed(cookie, `?limit=10&before=${encodeURIComponent(cursor)}`);
      for (const entry of next.entries) {
        expect(seen.has(entry.label ?? ""), `${entry.label ?? "?"} came back twice`).toBe(false);
        seen.add(entry.label ?? "");
      }
      cursor = next.nextBefore;
      pages += 1;
    }

    expect(seen.size).toBe(25);
    expect(cursor).toBeNull();
  });
});
