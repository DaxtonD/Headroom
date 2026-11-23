/**
 * "Purchases come from the Visa for now."
 *
 * Asked for on 2026-11-22, to replace a conversation the household was having
 * by hand: when chequing runs low, one of them tells the other in the morning
 * that necessary purchases go on the Visa until payday, and that a variable
 * bill has been pushed to a later pay period.
 *
 * ## What is worth a test against a real database
 *
 * **It is a household fact, so it goes through the whole treatment.**
 * `If-Match` and an idempotency key, 409 on the same field, auto-merge on a
 * different one. This is NOT `me/preferences`, which is the one exception in
 * this app and is exempt because that row has a single writer by
 * construction. Two people can set this at once, and the loser must be told
 * rather than silently overwritten - so the tests that hold the exception in
 * place over there have to have their opposite over here, or somebody will
 * "simplify" this route by rote one day.
 *
 * **The server settles four of the five columns.** The client sends an
 * account and maybe a note. The end date, who set it and when are the
 * server's, because a body that could set `spendFromSetById` would let one of
 * them put the other's name on it.
 *
 * **Whether it still applies is derived.** There is no "active" column. A row
 * whose end date has passed reads as the ordinary state with nothing having
 * run at midnight to make that true.
 *
 * **Chequing is refused.** It is the ordinary state, `null` already says it,
 * and two spellings of one thing would mean a banner announcing business as
 * usual.
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
let cookie: string;
let seeded: Awaited<ReturnType<typeof seedHousehold>>;
let visaId: string;
let savingsId: string;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  seeded = await seedHousehold(harness);
  cookie = await signIn(harness, "alex@example.test", seeded.password);

  const visa = await harness.db.prisma.account.create({
    data: { householdId: seeded.household.id, name: "Visa", kind: "credit_card" },
  });
  visaId = visa.id;

  const savings = await harness.db.prisma.account.create({
    data: { householdId: seeded.household.id, name: "Savings", kind: "savings" },
  });
  savingsId = savings.id;
});

function patch(payload: unknown, options: { version?: number; as?: string } = {}) {
  const headers: Record<string, string> = {
    cookie: options.as ?? cookie,
    "idempotency-key": randomUUID(),
  };
  if (options.version !== undefined) headers["if-match"] = String(options.version);

  return harness.app.inject({
    method: "PATCH",
    url: "/api/settings/household",
    headers,
    payload,
  });
}

async function version(): Promise<number> {
  const row = await harness.db.prisma.household.findUniqueOrThrow({
    where: { id: seeded.household.id },
    select: { version: true },
  });
  return row.version;
}

async function dashboard(as: string = cookie) {
  const response = await harness.app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie: as },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    today: string;
    householdVersion: number;
    spendFrom: {
      accountId: string;
      accountName: string;
      until: string;
      note: string | null;
      setBy: { name: string } | null;
    } | null;
  };
}

describe("setting it", () => {
  it("stores the account and tells the screen about it", async () => {
    const response = await patch(
      { spendFromAccountId: visaId, spendFromNote: "Tight until Friday" },
      { version: await version() },
    );
    expect(response.statusCode, response.body).toBe(200);

    const view = await dashboard();
    expect(view.spendFrom?.accountId).toBe(visaId);
    expect(view.spendFrom?.accountName).toBe("Visa");
    expect(view.spendFrom?.note).toBe("Tight until Friday");
  });

  it("records who said so, from the session rather than the body", async () => {
    /*
     * The other person seeing who it was without having to ask is most of
     * what this is for - and it must not be something either of them can put
     * the other's name on, which is why the field is not in the schema at
     * all.
     */
    await patch({ spendFromAccountId: visaId }, { version: await version() });

    expect((await dashboard()).spendFrom?.setBy?.name).toBe("Alex");

    const rejected = await patch(
      { spendFromAccountId: visaId, spendFromSetById: seeded.jordan.id },
      { version: await version() },
    );
    expect(rejected.statusCode).toBe(400);
  });

  it("ends it on its own, without being asked when", async () => {
    /*
     * A posture nobody turns off becomes permanently on and stops being
     * read, so there is always an end - but picking the date is not a
     * decision the household has to make.
     */
    await patch({ spendFromAccountId: visaId }, { version: await version() });

    const view = await dashboard();
    expect(view.spendFrom?.until).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // In the future, inclusive of today at the earliest.
    expect(view.spendFrom?.until.localeCompare(view.today)).toBeGreaterThanOrEqual(0);
  });

  it("takes an end date when one is given", async () => {
    await patch(
      { spendFromAccountId: visaId, spendFromUntil: "2099-01-31" },
      { version: await version() },
    );

    expect((await dashboard()).spendFrom?.until).toBe("2099-01-31");
  });

  it("accepts savings, which is the same thing for the same reason", async () => {
    // Some households spend out of savings when chequing is low. The API
    // takes any account that is not chequing.
    const response = await patch({ spendFromAccountId: savingsId }, { version: await version() });
    expect(response.statusCode, response.body).toBe(200);
    expect((await dashboard()).spendFrom?.accountName).toBe("Savings");
  });
});

describe("what it refuses", () => {
  it("refuses chequing, because null already says that", async () => {
    const response = await patch(
      { spendFromAccountId: seeded.account.id },
      { version: await version() },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/already come out of chequing/iu);
  });

  it("refuses another household's account", async () => {
    /*
     * Scoped by `householdId` in the WHERE rather than fetched and checked,
     * so a foreign id does not 403 - it simply does not match, and the answer
     * is the same one as for an id that never existed.
     */
    const other = await harness.db.prisma.household.create({ data: { name: "Someone else" } });
    const theirs = await harness.db.prisma.account.create({
      data: { householdId: other.id, name: "Their Visa", kind: "credit_card" },
    });

    const response = await patch({ spendFromAccountId: theirs.id }, { version: await version() });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an end date or a note with no account", async () => {
    // Either on its own describes a posture that is not in force. The engine
    // is deliberately strict about a half-written row, so the route is too.
    expect((await patch({ spendFromUntil: "2099-01-31" }, { version: await version() })).statusCode).toBe(400);
    expect((await patch({ spendFromNote: "why" }, { version: await version() })).statusCode).toBe(400);
  });
});

describe("lifting it", () => {
  it("clears the whole posture, not just the account", async () => {
    /*
     * An end date and a note left behind would describe something that is
     * not in force, and `spendFromIsActive` would be the only thing standing
     * between that and a banner.
     */
    await patch(
      { spendFromAccountId: visaId, spendFromNote: "Tight until Friday" },
      { version: await version() },
    );
    await patch({ spendFromAccountId: null }, { version: await version() });

    expect((await dashboard()).spendFrom).toBeNull();

    const row = await harness.db.prisma.household.findUniqueOrThrow({
      where: { id: seeded.household.id },
      select: {
        spendFromAccountId: true,
        spendFromUntil: true,
        spendFromNote: true,
        spendFromSetById: true,
        spendFromSetAt: true,
      },
    });
    expect(row).toEqual({
      spendFromAccountId: null,
      spendFromUntil: null,
      spendFromNote: null,
      spendFromSetById: null,
      spendFromSetAt: null,
    });
  });
});

describe("when it has lapsed", () => {
  it("reads as the ordinary state, with nothing having run at midnight", async () => {
    /*
     * The reason there is no "active" column. A flag would be wrong for the
     * hours between the end date passing and anything noticing, and the
     * thing that would notice does not exist.
     *
     * Written straight to the database because the route will not accept a
     * date in the past - which is correct for the route and is exactly the
     * state this needs to produce.
     */
    await patch({ spendFromAccountId: visaId }, { version: await version() });
    await harness.db.prisma.household.update({
      where: { id: seeded.household.id },
      data: { spendFromUntil: new Date("2020-01-01T00:00:00Z") },
    });

    expect((await dashboard()).spendFrom).toBeNull();
  });

  it("does not default a one-off to a lapsed account", async () => {
    // The screen never evaluates the rule: a lapsed posture arrives as null,
    // so the form has nothing to get wrong.
    await patch({ spendFromAccountId: visaId }, { version: await version() });
    await harness.db.prisma.household.update({
      where: { id: seeded.household.id },
      data: { spendFromUntil: new Date("2020-01-01T00:00:00Z") },
    });

    const view = await dashboard();
    expect(view.spendFrom?.accountId ?? null).toBeNull();
  });
});

/**
 * The integrity rules, which this is not exempt from.
 *
 * `me/preferences` is the one route in this app with no version and no
 * idempotency key, and the reasoning there is that the row has exactly one
 * writer. This row has two, holds money decisions, and a silent overwrite
 * would mean one of them acting on a posture the other had already changed.
 */
describe("two people at once", () => {
  it("needs a version and an idempotency key", async () => {
    const at = await version();

    // 428 for a missing version - "you must say what you were looking at" -
    // and 400 for a missing key, which is the app's existing distinction and
    // not one worth inventing a new answer for here.
    expect((await patch({ spendFromAccountId: visaId })).statusCode).toBe(428);

    const noKey = await harness.app.inject({
      method: "PATCH",
      url: "/api/settings/household",
      headers: { cookie, "if-match": String(at) },
      payload: { spendFromAccountId: visaId },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("checks those headers before it goes looking at accounts", async () => {
    /*
     * Found writing these tests: the posture validation ran first, so a
     * request with no `If-Match` was answered by whichever validation
     * happened to fail - telling the client its account was wrong when the
     * real problem was a missing header - and a request that was going to be
     * rejected did three database reads on the way.
     */
    const response = await harness.app.inject({
      method: "PATCH",
      url: "/api/settings/household",
      headers: { cookie, "idempotency-key": randomUUID() },
      // Chequing, which the posture validation rejects with a 400. The
      // missing version has to win.
      payload: { spendFromAccountId: seeded.account.id },
    });

    expect(response.statusCode).toBe(428);
  });

  it("returns 409 when both of them set it from the same version", async () => {
    const at = await version();
    const jordan = await signIn(harness, "jordan@example.test", seeded.password);

    const first = await patch({ spendFromAccountId: visaId }, { version: at });
    expect(first.statusCode, first.body).toBe(200);

    const second = await patch({ spendFromAccountId: savingsId }, { version: at, as: jordan });
    expect(second.statusCode).toBe(409);

    // The first one's choice stands, rather than being quietly replaced.
    expect((await dashboard()).spendFrom?.accountId).toBe(visaId);
  });

  it("merges a change to a different field", async () => {
    // Field-level, like every other PATCH here: somebody changing the
    // cushion must not have to care that the posture moved.
    const at = await version();

    expect((await patch({ spendFromAccountId: visaId }, { version: at })).statusCode).toBe(200);

    const cushion = await patch({ cushionCents: "5000" }, { version: at });
    expect(cushion.statusCode, cushion.body).toBe(200);
    expect(cushion.json().merged).toBe(true);
    expect((await dashboard()).spendFrom?.accountId).toBe(visaId);
  });

  it("replays one request rather than applying it twice", async () => {
    const at = await version();
    const key = randomUUID();
    const send = () =>
      harness.app.inject({
        method: "PATCH",
        url: "/api/settings/household",
        headers: { cookie, "if-match": String(at), "idempotency-key": key },
        payload: { spendFromAccountId: visaId },
      });

    const first = await send();
    const again = await send();

    expect(first.statusCode, first.body).toBe(200);
    expect(again.statusCode, again.body).toBe(200);
    // One write: a replay must not bump the version a second time.
    expect(await version()).toBe(at + 1);
  });
});

/**
 * It writes an activity row, which is what makes the notification happen.
 *
 * There is no separate notification call. `pushNotifier` watches the change
 * stream, reads the activity row the same transaction wrote, and words it
 * with `activitySentence` - so "the other person gets told" and "the log says
 * what happened" are the same mechanism and cannot drift.
 */
describe("what the other person gets told", () => {
  it("logs it with the account's name, for the sentence to use", async () => {
    await patch({ spendFromAccountId: visaId }, { version: await version() });

    const entry = await harness.db.prisma.activity.findFirst({
      where: { householdId: seeded.household.id, entity: "household" },
      orderBy: { at: "desc" },
    });

    expect(entry?.action).toBe("update");
    expect(entry?.fields).toContain("spendFromAccountId");
    // The row holds an id; the name is what the sentence needs.
    expect(entry?.label).toBe("Visa");
  });

  it("logs the lifting too, with the null that words it", async () => {
    await patch({ spendFromAccountId: visaId }, { version: await version() });
    await patch({ spendFromAccountId: null }, { version: await version() });

    const entry = await harness.db.prisma.activity.findFirst({
      where: { householdId: seeded.household.id, entity: "household" },
      orderBy: { at: "desc" },
    });

    expect(entry?.fields).toContain("spendFromAccountId");
    // `afterJson` is the column; `after` is what the engine's wording calls
    // the same thing once it has been read back.
    expect((entry?.afterJson as Record<string, unknown> | null)?.["spendFromAccountId"]).toBeNull();
  });
});
