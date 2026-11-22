/**
 * Notifications: who gets told, about what, and what happens to a browser
 * that has stopped listening.
 *
 * The push service itself is mocked, because there is no real one to talk to
 * and no useful fake of one. Everything else is real: a real Postgres, the
 * real routes, and the real decision about what is worth interrupting
 * somebody for.
 *
 * The decision is the part worth testing hardest. A notification is an
 * interruption, and the failure mode is not an exception - it is two people
 * turning notifications off because the app told them about everything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAll } from "../src/lib/push.js";
import { notifyForPing, pathFor, worthTelling } from "../src/lib/pushNotifier.js";
import { createHarness, migrateTestDatabase, seedHousehold, signIn } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

/*
 * The fake push service. Through `vi.hoisted` because `vi.mock` is lifted
 * above the imports, and a factory that closed over an ordinary `const`
 * would read it before it existed.
 */
const fake = vi.hoisted(() => {
  /** Every send, so a test can read what actually went out. */
  const sent: { endpoint: string; body: string }[] = [];
  /** Endpoints the fake service rejects, and with what status. */
  const rejectWith = new Map<string, number>();

  class FakeWebPushError extends Error {
    constructor(readonly statusCode: number) {
      super(`push failed: ${String(statusCode)}`);
    }
  }

  return { sent, rejectWith, FakeWebPushError };
});

const { sent, rejectWith } = fake;

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (subscription: { endpoint: string }, body: string): Promise<void> => {
      const status = fake.rejectWith.get(subscription.endpoint);
      if (status !== undefined) throw new fake.FakeWebPushError(status);
      fake.sent.push({ endpoint: subscription.endpoint, body });
    },
  },
  WebPushError: fake.FakeWebPushError,
}));

const VAPID = {
  VAPID_PUBLIC_KEY: "BLtestpublickeythatisnotreal0000000000000000000000000000000000000",
  VAPID_PRIVATE_KEY: "test-private-key-not-real",
  VAPID_SUBJECT: "mailto:nobody@example.test",
};

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness(VAPID);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

afterEach(() => {
  sent.length = 0;
  rejectWith.clear();
});

function event(over: Record<string, unknown> = {}) {
  return {
    action: "update",
    entity: "occurrence",
    label: "Power",
    labelKind: "bill",
    fields: [] as string[],
    after: null,
    ...over,
  } as Parameters<typeof worthTelling>[0];
}

describe("what is worth interrupting somebody for", () => {
  it("tells them the four things they asked for", () => {
    expect(worthTelling(event({ entity: "balance_snapshot", action: "create", fields: ["cents"] }))).toBe(true);
    expect(worthTelling(event({ action: "verify", fields: ["verified"] }))).toBe(true);
    expect(worthTelling(event({ action: "clear", fields: ["paid"] }))).toBe(true);
    expect(worthTelling(event({ entity: "reimbursement", action: "create", fields: ["purchase"] }))).toBe(true);
    expect(
      worthTelling(event({ entity: "reimbursement", action: "update", fields: ["submitted"] })),
    ).toBe(true);
  });

  it("stays quiet about the balance-update checklist", () => {
    /*
     * Ticking bills off happens *inside* saving a balance. Notifying on it
     * would send a second message about one action - and several at once
     * when a few are ticked together, which is the normal case.
     */
    expect(worthTelling(event({ action: "clear", fields: ["cleared"] }))).toBe(false);
    expect(worthTelling(event({ action: "unclear", fields: ["cleared"] }))).toBe(false);
  });

  it("stays quiet about everything else", () => {
    for (const quiet of [
      event({ entity: "template", fields: ["active"] }),
      event({ entity: "budget_line", action: "create", fields: ["name"] }),
      event({ entity: "goal", action: "update", fields: ["savedCents"] }),
      event({ entity: "asset", action: "update", fields: ["cents"] }),
      event({ action: "unverify", fields: ["verified"] }),
      event({ action: "soft_delete", fields: ["deletedAt"] }),
      event({ action: "update", fields: ["cents"] }),
      event({ entity: "reimbursement", action: "update", fields: ["paid"] }),
    ]) {
      expect(worthTelling(quiet), `${quiet.entity}/${quiet.action} should be silent`).toBe(false);
    }
  });

  it("sends work expenses to the screen they are on", () => {
    expect(pathFor(event({ entity: "reimbursement" }))).toBe("/savings");
    expect(pathFor(event({ entity: "occurrence" }))).toBe("/");
    expect(pathFor(event({ entity: "balance_snapshot" }))).toBe("/");
  });
});

describe("signing a browser up", () => {
  /*
   * What a browser actually sends: `PushSubscription.toJSON()`, including
   * `expirationTime`. The first version of this test left that out, the
   * schema was `.strict()`, and every real sign-up in production was
   * rejected with a 400 while this suite stayed green. A payload invented
   * to match the parser tests the parser against itself.
   */
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    expirationTime: null,
    keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
  };

  it("stores it, and says what the browser needs to subscribe", async () => {
    await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const key = await harness.app.inject({ method: "GET", url: "/api/push/key", headers: { cookie } });
    expect(key.statusCode).toBe(200);
    expect(key.json()).toMatchObject({ configured: true, publicKey: VAPID.VAPID_PUBLIC_KEY });

    const saved = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie },
      payload: subscription,
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(await harness.db.prisma.pushSubscription.count()).toBe(1);
  });

  it("does not pile up duplicates when the same browser re-subscribes", async () => {
    // A browser hands back the subscription it already had on every sign-in.
    await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    for (let i = 0; i < 3; i += 1) {
      const saved = await harness.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { cookie },
        payload: subscription,
      });
      expect(saved.statusCode).toBe(201);
    }
    expect(await harness.db.prisma.pushSubscription.count()).toBe(1);
  });

  it("follows whoever is signed in on that browser now", async () => {
    const { jordan } = await seedHousehold(harness);
    const alexCookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const jordanCookie = await signIn(harness, "jordan@example.test", "correct-horse-battery-staple");

    for (const cookie of [alexCookie, jordanCookie]) {
      await harness.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { cookie },
        payload: subscription,
      });
    }

    const rows = await harness.db.prisma.pushSubscription.findMany();
    expect(rows).toHaveLength(1);
    // Otherwise the phone would go on buzzing for the person who set it up.
    expect(rows[0]?.userId).toBe(jordan.id);
  });

  it("lets either of them switch that browser off", async () => {
    // One phone, two people who both use it. "Stop this buzzing" has to work
    // whichever of them is signed in at the time.
    await seedHousehold(harness);
    const alexCookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const jordanCookie = await signIn(harness, "jordan@example.test", "correct-horse-battery-staple");

    await harness.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: alexCookie },
      payload: subscription,
    });

    const off = await harness.app.inject({
      method: "DELETE",
      url: "/api/push/subscriptions",
      headers: { cookie: jordanCookie },
      payload: { endpoint: subscription.endpoint },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await harness.db.prisma.pushSubscription.count()).toBe(0);
  });

  it("refuses an unsigned request", async () => {
    await seedHousehold(harness);
    for (const [method, url] of [
      ["GET", "/api/push/key"],
      ["POST", "/api/push/subscriptions"],
      ["DELETE", "/api/push/subscriptions"],
    ] as const) {
      const response = await harness.app.inject({ method, url, payload: subscription });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("browsers that have stopped listening", () => {
  async function subscribeRow(userId: string, endpoint: string) {
    return harness.db.prisma.pushSubscription.create({
      data: { userId, endpoint, p256dh: "key", auth: "secret" },
    });
  }

  it("forgets one the push service says is gone", async () => {
    const { alex } = await seedHousehold(harness);
    const live = await subscribeRow(alex.id, "https://push.example.test/live");
    const dead = await subscribeRow(alex.id, "https://push.example.test/dead");
    rejectWith.set(dead.endpoint, 410);

    const result = await sendToAll(
      harness.db.prisma,
      [live, dead].map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
      })),
      { body: "Alex verified Power", url: "/" },
    );

    expect(result).toMatchObject({ sent: 1, gone: 1, failed: 0 });
    const left = await harness.db.prisma.pushSubscription.findMany();
    expect(left.map((row) => row.endpoint)).toEqual([live.endpoint]);
    expect(sent.map((item) => item.endpoint)).toEqual([live.endpoint]);
  });

  it("keeps one the service merely could not reach, until it gives up", async () => {
    /*
     * A 500 from the push service, or a network blip, says nothing about the
     * browser. Deleting on the first failure would unsubscribe a household
     * during an outage, and they would never know it had happened.
     */
    const { alex } = await seedHousehold(harness);
    const flaky = await subscribeRow(alex.id, "https://push.example.test/flaky");
    rejectWith.set(flaky.endpoint, 500);

    const one = { id: flaky.id, endpoint: flaky.endpoint, p256dh: flaky.p256dh, auth: flaky.auth };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await sendToAll(harness.db.prisma, [one], { body: "x", url: "/" });
      expect(result, `attempt ${String(attempt)}`).toMatchObject({
        sent: 0,
        gone: 0,
        abandoned: 0,
        failed: 1,
      });
      expect(await harness.db.prisma.pushSubscription.count()).toBe(1);
    }

    /*
     * The fifth consecutive failure is indistinguishable from gone, so the
     * row goes - but it is counted as `abandoned`, not `gone`. The screen
     * tells the two apart: "it expired, subscribe again" is right for one and
     * useless for the other, which is usually a VAPID pair that stopped
     * matching and will refuse the next subscription exactly as it refused
     * this one.
     */
    const last = await sendToAll(harness.db.prisma, [one], { body: "x", url: "/" });
    expect(last).toMatchObject({ sent: 0, gone: 0, abandoned: 1, failed: 1 });
    expect(await harness.db.prisma.pushSubscription.count()).toBe(0);
  });

  it("forgets the count after one that works", async () => {
    const { alex } = await seedHousehold(harness);
    const row = await subscribeRow(alex.id, "https://push.example.test/recovers");
    const one = { id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };

    rejectWith.set(row.endpoint, 500);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sendToAll(harness.db.prisma, [one], { body: "x", url: "/" });
    }
    rejectWith.clear();
    await sendToAll(harness.db.prisma, [one], { body: "x", url: "/" });

    const after = await harness.db.prisma.pushSubscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.failures, "a run of failures must not be held against it forever").toBe(0);
    expect(after.lastOkAt).not.toBeNull();
  });

  it("carries no amount in what it sends", async () => {
    const { alex } = await seedHousehold(harness);
    const row = await subscribeRow(alex.id, "https://push.example.test/reader");

    await sendToAll(
      harness.db.prisma,
      [{ id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }],
      { body: "Alex updated the Chequing balance", url: "/" },
    );

    // It lands on a lock screen anybody holding the phone can read.
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      body: "Alex updated the Chequing balance",
      url: "/",
    });
    expect(sent[0]?.body).not.toMatch(/\d/);
  });
});

describe("with no VAPID keys configured", () => {
  it("says so plainly rather than offering a toggle that cannot work", async () => {
    const bare = await createHarness();
    try {
      await bare.reset();
      await seedHousehold(bare);
      const cookie = await signIn(bare, "alex@example.test", "correct-horse-battery-staple");

      const key = await bare.app.inject({ method: "GET", url: "/api/push/key", headers: { cookie } });
      expect(key.json()).toEqual({ configured: false, publicKey: null });

      const saved = await bare.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { cookie },
        payload: {
          endpoint: "https://push.example.test/abc",
          keys: { p256dh: "k", auth: "s" },
        },
      });
      expect(saved.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("from a real change to a real notification", () => {
  /*
   * The unit tests above cover the decision and the sending. Nothing covered
   * the chain between them: find the activity row this ping is about, word
   * it, and pick who to tell. Every one of those is a place where the whole
   * feature can be silently off while every other test stays green.
   */
  async function subscribe(userId: string, endpoint: string): Promise<void> {
    await harness.db.prisma.pushSubscription.create({
      data: { userId, endpoint, p256dh: "key", auth: "secret" },
    });
  }

  function deps() {
    return {
      stream: harness.app.changeStream,
      prisma: harness.db.prisma,
      env: harness.env,
      log: { info: () => undefined, warn: () => undefined },
    };
  }

  it("tells the other person, in words, what was just done", async () => {
    const { household, alex, jordan, account } = await seedHousehold(harness);
    await subscribe(jordan.id, "https://push.example.test/jordans-phone");

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const saved = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "54321" },
    });
    expect(saved.statusCode, saved.body).toBe(201);

    const snapshot = await harness.db.prisma.balanceSnapshot.findFirstOrThrow({
      where: { accountId: account.id },
      orderBy: { asOf: "desc" },
    });

    await notifyForPing(deps(), {
      householdId: household.id,
      entity: "balance_snapshot",
      id: snapshot.id,
      version: 1,
      by: alex.id,
    });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      body: "Alex updated the Chequing balance",
      url: "/",
    });
  });

  it("never tells the person who did it", async () => {
    const { household, alex, account } = await seedHousehold(harness);
    // Alex is the only one subscribed, and Alex is the one typing.
    await subscribe(alex.id, "https://push.example.test/alexs-phone");

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "54321" },
    });

    const snapshot = await harness.db.prisma.balanceSnapshot.findFirstOrThrow({
      where: { accountId: account.id },
      orderBy: { asOf: "desc" },
    });

    await notifyForPing(deps(), {
      householdId: household.id,
      entity: "balance_snapshot",
      id: snapshot.id,
      version: 1,
      by: alex.id,
    });

    expect(sent, "you do not need telling what you just typed").toHaveLength(0);
  });

  it("stays silent for a change nobody asked to hear about", async () => {
    const { household, alex, jordan } = await seedHousehold(harness);
    await subscribe(jordan.id, "https://push.example.test/jordans-phone");

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/budget-lines",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { section: "fixed", name: "Window cleaning", monthlyCents: "2500" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const line = (created.json() as { line: { id: string } }).line;

    await notifyForPing(deps(), {
      householdId: household.id,
      entity: "budget_line",
      id: line.id,
      version: 1,
      by: alex.id,
    });

    expect(sent).toHaveLength(0);
  });

  it("reaches every browser that person has signed up", async () => {
    const { household, alex, jordan } = await seedHousehold(harness);
    await subscribe(jordan.id, "https://push.example.test/phone");
    await subscribe(jordan.id, "https://push.example.test/laptop");

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/reimbursements",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { purchase: "Work boots", cents: "19900", boughtOn: "2026-11-14" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const row = (created.json() as { reimbursement: { id: string; version: number } }).reimbursement;

    await notifyForPing(deps(), {
      householdId: household.id,
      entity: "reimbursement",
      id: row.id,
      version: row.version,
      by: alex.id,
    });

    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      "https://push.example.test/laptop",
      "https://push.example.test/phone",
    ]);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      body: "Alex bought Work boots",
      // Work expenses live on Savings, so that is where a tap should land.
      url: "/savings",
    });
  });

  it("does nothing at all when the ping names something that is not there", async () => {
    // A ping for a row whose activity cannot be found must not throw: this
    // runs outside any request, and an unhandled rejection here would be a
    // log line nobody reads and, in the worst case, a dead listener.
    const { household, alex } = await seedHousehold(harness);
    await expect(
      notifyForPing(deps(), {
        householdId: household.id,
        entity: "occurrence",
        id: crypto.randomUUID(),
        version: 9,
        by: alex.id,
      }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

describe("the body a browser actually sends", () => {
  /*
   * The shape belongs to the browser, not to us. Validating it strictly
   * means any field a future browser adds stops people signing up, with a
   * 400 and nothing to go on - which is exactly what `expirationTime` did.
   */
  /** Seed once per test; two calls in one test would collide on the email. */
  async function household(): Promise<string> {
    await seedHousehold(harness);
    return signIn(harness, "alex@example.test", "correct-horse-battery-staple");
  }

  async function subscribeWith(
    cookie: string,
    body: unknown,
  ): Promise<{ status: number; message: string }> {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie },
      payload: body,
    });
    return {
      status: response.statusCode,
      message: (response.json() as { message?: string }).message ?? "",
    };
  }

  it("accepts expirationTime, which every browser sends", async () => {
    const result = await subscribeWith(await household(), {
      endpoint: "https://fcm.googleapis.com/fcm/send/real",
      expirationTime: null,
      keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
    });
    expect(result.status, result.message).toBe(201);
  });

  it("accepts an expiry that is a number, as the spec allows", async () => {
    const result = await subscribeWith(await household(), {
      endpoint: "https://fcm.googleapis.com/fcm/send/dated",
      expirationTime: 1893456000000,
      keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
    });
    expect(result.status, result.message).toBe(201);
  });

  it("ignores a field no browser sends today", async () => {
    // The next thing added to the spec must not take notifications down.
    const result = await subscribeWith(await household(), {
      endpoint: "https://fcm.googleapis.com/fcm/send/future",
      expirationTime: null,
      somethingNew: { nested: true },
      keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
    });
    expect(result.status, result.message).toBe(201);
  });

  it("still refuses something that is genuinely not a subscription, and says which part", async () => {
    const cookie = await household();
    const missingKeys = await subscribeWith(cookie, {
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
    });
    expect(missingKeys.status).toBe(400);
    expect(missingKeys.message, "the message has to name the field").toContain("keys");

    const noEndpoint = await subscribeWith(cookie, {
      keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
    });
    expect(noEndpoint.status).toBe(400);
    expect(noEndpoint.message).toContain("endpoint");
  });
});

describe("sending one to yourself on purpose", () => {
  /*
   * The one place the "never the person who did it" rule is deliberately
   * inverted. A notification that does not arrive has a long chain behind
   * it and every link fails silently; this is how somebody alone with one
   * phone finds out which link.
   */
  it("reaches this person's devices and reports what the service said", async () => {
    const { alex, jordan } = await seedHousehold(harness);
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/mine-1", "https://fcm.googleapis.com/fcm/send/mine-2"]) {
      await harness.db.prisma.pushSubscription.create({
        data: { userId: alex.id, endpoint, p256dh: "key", auth: "secret" },
      });
    }
    // The other person's phone must stay quiet; a test is not an event.
    await harness.db.prisma.pushSubscription.create({
      data: {
        userId: jordan.id,
        endpoint: "https://fcm.googleapis.com/fcm/send/theirs",
        p256dh: "key",
        auth: "secret",
      },
    });

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      subscriptions: 2,
      sent: 2,
      gone: 0,
      abandoned: 0,
      failed: 0,
    });
    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      "https://fcm.googleapis.com/fcm/send/mine-1",
      "https://fcm.googleapis.com/fcm/send/mine-2",
    ]);
  });

  it("says plainly when this device is not signed up", async () => {
    await seedHousehold(harness);
    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ subscriptions: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("reports a subscription the service has forgotten, and drops it", async () => {
    const { alex } = await seedHousehold(harness);
    const endpoint = "https://fcm.googleapis.com/fcm/send/expired";
    await harness.db.prisma.pushSubscription.create({
      data: { userId: alex.id, endpoint, p256dh: "key", auth: "secret" },
    });
    rejectWith.set(endpoint, 410);

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie },
    });

    expect(response.json()).toMatchObject({ subscriptions: 1, sent: 0, gone: 1 });
    expect(await harness.db.prisma.pushSubscription.count()).toBe(0);
  });

  it("refuses an unsigned request", async () => {
    await seedHousehold(harness);
    const response = await harness.app.inject({ method: "POST", url: "/api/push/test" });
    expect(response.statusCode).toBe(401);
  });
});
