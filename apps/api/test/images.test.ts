/**
 * Storing a picture, serving it back, and pointing things at it.
 *
 * Asked for by the household: a small image to the left of the name of an
 * expense, an account or a budget-only category, "so we both see the same
 * image" - which is why it is stored on the server rather than on one phone.
 *
 * Against real Postgres, because the parts worth testing are the parts the
 * database enforces: that an `imageId` really has to be this household's,
 * that a picture shared by three things is one row, and that the row goes away
 * once nothing points at it.
 *
 * ## What this is guarding
 *
 * `imageId` is a plain foreign key on three tables, so without `requireOwnImage`
 * the database would accept another household's picture quite happily - the
 * same hole `requireValidRouting` exists to close for accounts. And without
 * `forgetImageIfUnused`, the table would grow by a row every time somebody
 * re-crops, because a crop is deliberately a new row rather than a change to
 * an existing one. The database is also the backup, so that growth would be
 * paid for twice.
 *
 * Nothing here can move a figure: `packages/core` does not know the table
 * exists. That is what makes this the least dangerous thing in the repository
 * and worth saying out loud.
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
import { distinctWebp, extended, lossy } from "./helpers/webp.js";
import { MAX_IMAGE_BYTES } from "../src/lib/images.js";

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

function get(url: string, withCookie = true) {
  return harness.app.inject({
    method: "GET",
    url,
    ...(withCookie ? { headers: { cookie } } : {}),
  });
}

/** Upload one and return its id. */
async function upload(bytes: Buffer): Promise<string> {
  const response = await post("/api/images", { base64: bytes.toString("base64") });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().image.id as string;
}

function imageRows() {
  return harness.db.prisma.image.findMany({ select: { id: true, byteSize: true } });
}

/**
 * A bill, which is what "expense" means in the schema.
 *
 * Dated a few days out rather than hung off a pay period, because the seed
 * has no pay schedules: a per-pay-period template would generate nothing and
 * the row test below would pass by finding nothing to look at. The day comes
 * from the household's own today, so this works whatever day it is run.
 */
async function addExpense(name: string, imageId?: string | null) {
  const response = await post("/api/templates", {
    name,
    kind: "bill",
    section: "fixed",
    defaultCents: "14000",
    withdrawal: "auto",
    schedule: { type: "monthly", day: Number(inDays(3).slice(8, 10)) },
    ...(imageId === undefined ? {} : { imageId }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().template as { id: string; imageId: string | null; version: number };
}

async function addCategory(name: string, imageId?: string | null) {
  const response = await post("/api/budget-lines", {
    name,
    section: "variable",
    monthlyCents: "20000",
    ...(imageId === undefined ? {} : { imageId }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().line as { id: string; imageId: string | null; version: number };
}

async function addCard(name: string, imageId?: string | null) {
  const response = await post("/api/accounts", {
    name,
    kind: "credit_card",
    ...(imageId === undefined ? {} : { imageId }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().account as { id: string; imageId: string | null; version: number };
}

/** A second household, for the one hole that matters. No users needed. */
async function otherHouseholdsImage(): Promise<string> {
  const other = await harness.db.prisma.household.create({
    data: { name: "Someone else" },
  });
  const bytes = distinctWebp(7);
  const row = await harness.db.prisma.image.create({
    data: {
      householdId: other.id,
      sha256: "f".repeat(64),
      bytes: new Uint8Array(bytes),
      contentType: "image/webp",
      width: 256,
      height: 256,
      byteSize: bytes.byteLength,
    },
    select: { id: true },
  });
  return row.id;
}

describe("storing a picture", () => {
  it("takes one and hands back its id", async () => {
    const bytes = lossy(256, 256, 40);
    const response = await post("/api/images", { base64: bytes.toString("base64") });

    expect(response.statusCode).toBe(201);
    expect(response.json().image).toMatchObject({ width: 256, height: 256 });
    expect(response.json().image.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the size out of the file rather than off the request", async () => {
    // A client is a phone, and a phone is not a trust boundary. What the
    // header says is what gets stored.
    const id = await upload(extended(128, 64));
    const row = await harness.db.prisma.image.findUniqueOrThrow({ where: { id } });
    expect({ width: row.width, height: row.height }).toEqual({ width: 128, height: 64 });
  });

  it("stores the same picture once, however many things use it", async () => {
    /*
     * The expected case, not an edge one: the household gives one logo to a
     * handful of subscriptions. Content-addressing makes that free.
     */
    const bytes = distinctWebp(11);
    const first = await upload(bytes);
    const second = await upload(bytes);

    expect(second).toBe(first);
    expect(await imageRows()).toHaveLength(1);
  });

  it("stores a different crop as a different picture", async () => {
    // And this is why a re-crop can never change what an id means, which is
    // what lets the URL be cached for ever.
    const first = await upload(distinctWebp(1));
    const second = await upload(distinctWebp(2));

    expect(second).not.toBe(first);
    expect(await imageRows()).toHaveLength(2);
  });

  it("refuses something that is not a WebP", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    const response = await post("/api/images", { base64: png.toString("base64") });

    expect(response.statusCode).toBe(400);
    expect(await imageRows()).toHaveLength(0);
  });

  it("refuses one that is too big to store", async () => {
    // Well under the app's 256KB bodyLimit, so this is the image cap being
    // tested and not the body one.
    const big = lossy(256, 256, MAX_IMAGE_BYTES);
    const response = await post("/api/images", { base64: big.toString("base64") });

    expect(response.statusCode).toBe(400);
    expect(await imageRows()).toHaveLength(0);
  });

  it("refuses an empty body", async () => {
    expect((await post("/api/images", { base64: "" })).statusCode).toBe(400);
  });

  it("needs an idempotency key, like every other write", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/images",
      headers: { cookie },
      payload: { base64: distinctWebp(3).toString("base64") },
    });
    expect(response.statusCode).toBe(400);
  });

  it("needs somebody signed in", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/images",
      headers: { "idempotency-key": randomUUID() },
      payload: { base64: distinctWebp(4).toString("base64") },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("serving one back", () => {
  it("returns the bytes that went in", async () => {
    const bytes = distinctWebp(21);
    const id = await upload(bytes);

    const response = await get(`/api/images/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(Buffer.from(response.rawPayload).equals(bytes)).toBe(true);
  });

  it("says it can be kept for ever, and kept privately", async () => {
    /*
     * Immutable is safe because the row is insert-only and an id is never
     * reused for different bytes - that is what content-addressing buys, and
     * it is what lets the service worker keep a copy so these survive
     * offline. `private` because it is one household's data on an
     * authenticated route: a shared cache must not hold it.
     */
    const response = await get(`/api/images/${await upload(distinctWebp(22))}`);
    const cacheControl = response.headers["cache-control"] as string;

    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    // Same origin as the app, so a browser that sniffed it as something else
    // would be running that inside the app's own origin.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("will not serve another household's picture", async () => {
    // The whole reason the route is scoped rather than trusting an
    // unguessable id.
    const theirs = await otherHouseholdsImage();
    expect((await get(`/api/images/${theirs}`)).statusCode).toBe(404);
  });

  it("will not serve one to nobody", async () => {
    const id = await upload(distinctWebp(23));
    expect((await get(`/api/images/${id}`, false)).statusCode).toBe(401);
  });

  it("is a 404 and not a 500 for something that is not even an id", async () => {
    expect((await get("/api/images/not-a-uuid")).statusCode).toBe(404);
    expect((await get(`/api/images/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe("pointing the three things at a picture", () => {
  it("sets one on an expense, when it is created and afterwards", async () => {
    const first = await upload(distinctWebp(31));
    const expense = await addExpense("Wireless", first);
    expect(expense.imageId).toBe(first);

    const second = await upload(distinctWebp(32));
    const changed = await patch(`/api/templates/${expense.id}`, expense.version, {
      imageId: second,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().template.imageId).toBe(second);
  });

  it("sets one on an account", async () => {
    const id = await upload(distinctWebp(33));
    const card = await addCard("Visa", id);
    expect(card.imageId).toBe(id);

    const renamed = await patch(`/api/accounts/${card.id}`, card.version, { name: "Visa card" });
    expect(renamed.statusCode).toBe(200);
    // A rename must not quietly drop the picture: it is a field-level PATCH.
    expect(renamed.json().account.imageId).toBe(id);
  });

  it("sets one on a budget-only category", async () => {
    const id = await upload(distinctWebp(34));
    const category = await addCategory("Groceries", id);
    expect(category.imageId).toBe(id);

    const changed = await patch(`/api/budget-lines/${category.id}`, category.version, {
      imageId: null,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().line.imageId).toBeNull();
  });

  it("refuses a picture that does not exist, with a 400 rather than a 500", async () => {
    /*
     * Without the guard this reaches the foreign key and comes back as a
     * server error, which reads as "the app is broken" rather than "that
     * request cannot be honoured".
     */
    const response = await post("/api/budget-lines", {
      name: "Groceries",
      section: "variable",
      monthlyCents: "20000",
      imageId: randomUUID(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses another household's picture", async () => {
    // `imageId` is a plain foreign key, so the database would take this. The
    // same hole `requireValidRouting` closes for accounts.
    const theirs = await otherHouseholdsImage();

    const onCreate = await post("/api/templates", {
      name: "Wireless",
      kind: "bill",
      section: "fixed",
      defaultCents: "14000",
      withdrawal: "flexible",
      schedule: { type: "flexible", frequency: "per_pay_period" },
      imageId: theirs,
    });
    expect(onCreate.statusCode).toBe(400);

    const mine = await addExpense("Wireless");
    const onPatch = await patch(`/api/templates/${mine.id}`, mine.version, { imageId: theirs });
    expect(onPatch.statusCode).toBe(400);
  });
});

describe("showing up where the screens read from", () => {
  it("comes through on the dashboard's accounts", async () => {
    const id = await upload(distinctWebp(41));
    const card = await addCard("Visa", id);

    const response = await get("/api/dashboard");
    const accounts = response.json().accounts as readonly { id: string; imageId: string | null }[];
    expect(accounts.find((account) => account.id === card.id)?.imageId).toBe(id);
    // And chequing, which has none, says so rather than being absent.
    expect(accounts.find((account) => account.id === chequingId)?.imageId).toBeNull();
  });

  it("comes through on every ledger row the expense generated", async () => {
    /*
     * From the template, not the row. A picture belongs to the thing rather
     * than to one month of it, so one change has to change every row - which
     * is the only behaviour "change the image" could reasonably mean.
     */
    const id = await upload(distinctWebp(42));
    await addExpense("Wireless", id);

    const rows = (
      await get("/api/timeline")
    ).json().rows as readonly { name: string; imageId: string | null }[];
    const wireless = rows.filter((row) => row.name === "Wireless");

    expect(wireless.length).toBeGreaterThan(0);
    for (const row of wireless) expect(row.imageId).toBe(id);
  });

  it("leaves a one-off with none, having nothing recurring to recognise", async () => {
    const response = await post("/api/occurrences", {
      name: "Dentist",
      cents: "18500",
      kind: "bill",
      paid: true,
    });
    expect(response.statusCode).toBe(201);

    const rows = (
      await get("/api/timeline")
    ).json().rows as readonly { name: string; imageId: string | null }[];
    expect(rows.find((row) => row.name === "Dentist")?.imageId).toBeNull();
  });
});

describe("not keeping pictures nothing points at", () => {
  it("forgets the old one when a picture is replaced", async () => {
    /*
     * A re-crop is a new row by design. Without this the table grows by one
     * every time somebody adjusts a picture, and the database is the backup
     * too, so the growth is paid for twice.
     */
    const first = await upload(distinctWebp(51));
    const expense = await addExpense("Wireless", first);
    const second = await upload(distinctWebp(52));

    expect(await imageRows()).toHaveLength(2);

    const changed = await patch(`/api/templates/${expense.id}`, expense.version, {
      imageId: second,
    });
    expect(changed.statusCode).toBe(200);

    const left = await imageRows();
    expect(left.map((row) => row.id)).toEqual([second]);
  });

  it("forgets it when a picture is taken away", async () => {
    const id = await upload(distinctWebp(53));
    const category = await addCategory("Groceries", id);

    await patch(`/api/budget-lines/${category.id}`, category.version, { imageId: null });
    expect(await imageRows()).toHaveLength(0);
  });

  it("keeps it while anything else is still using it", async () => {
    /*
     * The case that makes this a reference count rather than a delete. One
     * logo on three subscriptions is the expected case, so replacing it on
     * one of them must not take it off the other two.
     */
    const shared = await upload(distinctWebp(54));
    const one = await addExpense("Streaming", shared);
    await addExpense("Music", shared);
    const other = await upload(distinctWebp(55));

    await patch(`/api/templates/${one.id}`, one.version, { imageId: other });

    const left = (await imageRows()).map((row) => row.id).sort();
    expect(left).toEqual([shared, other].sort());
  });

  it("counts all three tables, not just the one that changed", async () => {
    // A picture shared between an account and an expense. Counting only
    // templates would delete it out from under the account.
    const shared = await upload(distinctWebp(56));
    const expense = await addExpense("Wireless", shared);
    await addCard("Visa", shared);

    await patch(`/api/templates/${expense.id}`, expense.version, { imageId: null });

    expect((await imageRows()).map((row) => row.id)).toEqual([shared]);
  });

  it("leaves an untouched picture alone on an unrelated change", async () => {
    const id = await upload(distinctWebp(57));
    const expense = await addExpense("Wireless", id);

    await patch(`/api/templates/${expense.id}`, expense.version, { name: "Mobile" });

    expect((await imageRows()).map((row) => row.id)).toEqual([id]);
  });
});

describe("the household it belongs to", () => {
  it("keeps every picture inside its own household", async () => {
    const id = await upload(distinctWebp(61));
    const row = await harness.db.prisma.image.findUniqueOrThrow({
      where: { id },
      select: { householdId: true },
    });
    expect(row.householdId).toBe(householdId);
  });
});
