/**
 * A real change, through a real LISTEN connection, to an attempted push.
 *
 * ## The gap this fills
 *
 * `push.test.ts` calls `notifyForPing` directly, which proves the decision,
 * the wording and the recipients but assumes the ping ever arrives. The
 * wiring in between - `startPushNotifier` subscribing to a `ChangeStream`
 * that is actually listening to Postgres - was never exercised. The whole
 * feature can be off with every other test green, which is what makes this
 * worth a separate file and a real connection.
 *
 * So this starts a genuine `ChangeStream`, starts the notifier on it, saves
 * a balance through the real route, and waits for a push to be attempted.
 * Nothing is stubbed except the push service itself, which does not exist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const sent: { endpoint: string; body: string }[] = [];
  class FakeWebPushError extends Error {
    constructor(readonly statusCode: number) {
      super(`push failed: ${String(statusCode)}`);
    }
  }
  return { sent, FakeWebPushError };
});

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (subscription: { endpoint: string }, body: string): Promise<void> => {
      fake.sent.push({ endpoint: subscription.endpoint, body });
      await Promise.resolve();
    },
  },
  WebPushError: fake.FakeWebPushError,
}));

const { sent } = fake;

import { ChangeStream } from "../src/lib/changeStream.js";
import { startPushNotifier } from "../src/lib/pushNotifier.js";
import { createHarness, migrateTestDatabase, seedHousehold, signIn } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

const VAPID = {
  VAPID_PUBLIC_KEY: "BLtestpublickeythatisnotreal0000000000000000000000000000000000000",
  VAPID_PRIVATE_KEY: "test-private-key-not-real",
  VAPID_SUBJECT: "mailto:nobody@example.test",
};

let harness: Harness;
let stream: ChangeStream;
let stopNotifier: () => void;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness(VAPID);

  // The real thing: its own connection, a real LISTEN, real NOTIFY delivery.
  stream = new ChangeStream(harness.env);
  await stream.start();

  stopNotifier = startPushNotifier({
    stream,
    prisma: harness.db.prisma,
    env: harness.env,
    log: { info: () => undefined, warn: () => undefined },
  });
});

afterAll(async () => {
  stopNotifier();
  await stream.stop();
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

afterEach(() => {
  sent.length = 0;
});

/**
 * Wait for a push to be attempted.
 *
 * `NOTIFY` arrives on another connection and the handler is deliberately not
 * awaited, so there is nothing to await here either. Polling with a deadline
 * is honest about that; a fixed sleep would be slower and flakier.
 */
async function waitForPush(count = 1, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("a change made through the API reaches the other person's phone", () => {
  it("delivers a balance update, end to end", async () => {
    const { jordan, account } = await seedHousehold(harness);
    await harness.db.prisma.pushSubscription.create({
      data: {
        userId: jordan.id,
        endpoint: "https://fcm.googleapis.com/fcm/send/jordans-phone",
        p256dh: "key",
        auth: "secret",
      },
    });

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const saved = await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "54321" },
    });
    expect(saved.statusCode, saved.body).toBe(201);

    await waitForPush();

    expect(sent, "nothing was pushed; the ping never reached the notifier").toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      body: "Alex updated the Chequing balance",
      url: "/",
    });
  });

  it("delivers a work expense being submitted", async () => {
    const { jordan } = await seedHousehold(harness);
    await harness.db.prisma.pushSubscription.create({
      data: {
        userId: jordan.id,
        endpoint: "https://fcm.googleapis.com/fcm/send/jordans-phone",
        p256dh: "key",
        auth: "secret",
      },
    });

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/reimbursements",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { purchase: "Work boots", cents: "19900", boughtOn: "2026-11-14" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const row = (created.json() as { reimbursement: { id: string } }).reimbursement;

    await waitForPush();
    expect(sent).toHaveLength(1);

    const submitted = await harness.app.inject({
      method: "PATCH",
      url: `/api/reimbursements/${row.id}`,
      headers: { cookie, "idempotency-key": crypto.randomUUID(), "if-match": "1" },
      payload: { submitted: true },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    await waitForPush(2);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]?.body ?? "{}")).toMatchObject({
      body: "Alex submitted Work boots for reimbursement",
      url: "/savings",
    });
  });

  it("sends nothing when the only subscribed device belongs to whoever did it", async () => {
    /*
     * The most likely reason for "notifications are on and nothing arrives":
     * both devices signed in as the same person, who is also the one making
     * the change. Working as intended, and worth a test so it stays a
     * deliberate silence rather than an accidental one.
     */
    const { alex, account } = await seedHousehold(harness);
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/desk", "https://fcm.googleapis.com/fcm/send/phone"]) {
      await harness.db.prisma.pushSubscription.create({
        data: { userId: alex.id, endpoint, p256dh: "key", auth: "secret" },
      });
    }

    const cookie = await signIn(harness, "alex@example.test", "correct-horse-battery-staple");
    await harness.app.inject({
      method: "POST",
      url: "/api/balance",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { accountId: account.id, cents: "54321" },
    });

    // Long enough that a push would have been attempted if one were coming.
    await waitForPush(1, 1500);
    expect(sent).toHaveLength(0);
  });
});
