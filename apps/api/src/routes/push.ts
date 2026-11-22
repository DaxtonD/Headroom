/**
 * Signing a browser up for notifications, and off again.
 *
 * Three small endpoints. The browser does the hard part: it asks its push
 * service for a subscription, and hands back an endpoint URL and two keys.
 * All the server does is remember them against the person signed in here,
 * and forget them when asked.
 *
 * ## No idempotency key, and no version
 *
 * Every other mutation in this app carries both, because every other
 * mutation changes money. This changes whether a phone buzzes. A replayed
 * subscribe is an upsert on an endpoint that is unique by definition, so it
 * is already idempotent in the only way that matters; a replayed unsubscribe
 * deletes a row that is already gone. Requiring the ceremony here would be
 * cargo-culting it.
 *
 * ## The public key is served, not built in
 *
 * The web app needs the VAPID public key to subscribe at all. Baking it into
 * the bundle would mean rebuilding the image to rotate a key, and would make
 * a dev build against a different server fail in a way nobody could read.
 * It is public by design - that is the whole point of the pair.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasWebPush } from "../env.js";
import { HttpError } from "../lib/http.js";
import { configurePush, sendToAll } from "../lib/push.js";

/**
 * A browser's own subscription, exactly as `PushSubscription.toJSON()` gives
 * it. The shape is the browser's, so this validates rather than designs it.
 *
 * **Not `.strict()`, and that is the point.** It was, and it rejected every
 * real subscription in production: `toJSON()` also returns `expirationTime`,
 * which every browser sends and no hand-written test payload had. Being
 * strict about a shape somebody else defines means any field a future
 * browser adds breaks signing up, with a 400 and no clue why.
 *
 * So unknown fields are dropped. `expirationTime` is named rather than
 * merely tolerated, because "we see this and deliberately ignore it" is
 * worth saying out loud - it is the push service's own expiry guess, and
 * what actually tells us a subscription is dead is a 404 or 410 at send
 * time, which `lib/push.ts` acts on.
 */
const subscribeBody = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.union([z.number(), z.string(), z.null()]).optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

const unsubscribeBody = z.object({ endpoint: z.string().url().max(2048) }).strict();

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the browser needs to subscribe, and whether it is worth trying.
   *
   * `configured: false` is a normal answer, not an error: an installation
   * whose owner has not set VAPID keys up has notifications switched off,
   * and the screen should say so plainly rather than offer a toggle that
   * cannot work.
   */
  app.get("/push/key", async (request, reply) => {
    if (!request.user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const configured = hasWebPush(app.env);
    return reply.send({
      configured,
      publicKey: configured ? app.env.VAPID_PUBLIC_KEY : null,
    });
  });

  app.post("/push/subscriptions", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    if (!hasWebPush(app.env)) {
      throw new HttpError(
        503,
        "push_not_configured",
        "Notifications are not set up on this server yet.",
      );
    }

    const parsed = subscribeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      /*
       * Name the field. The first version of this said only "That is not a
       * push subscription", which is exactly as much help as saying nothing
       * - the body comes from the browser, so the one thing worth knowing
       * is which part of it we did not like.
       */
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") ?? "";
      throw new HttpError(
        400,
        "invalid_request",
        where === ""
          ? "That is not a push subscription."
          : `That is not a push subscription: ${where} ${issue?.message ?? "is wrong"}.`,
      );
    }
    const input = parsed.data;

    /*
     * Keyed on the endpoint, which the push service guarantees is unique.
     * The update moves it to whoever is signed in here now: the same browser
     * can be used by either of them, and notifications must follow the
     * person who is actually signed in, not the one who turned them on.
     */
    const userAgent = request.headers["user-agent"];
    await app.db.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId: user.id,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 400) : null,
      },
      update: {
        userId: user.id,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        failures: 0,
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 400) : null,
      },
    });

    return reply.code(201).send({ subscribed: true });
  });

  /**
   * Send one to yourself, on purpose.
   *
   * The one case where the "never the person who did it" rule is wrong. A
   * notification that does not arrive has a long chain behind it - the
   * browser, its push service, the subscription, the VAPID pair, the
   * server's own listener - and every link fails silently. This exercises
   * all of it except the listener and reports what the push service said,
   * so "notifications are on and nothing arrives" stops being a question
   * nobody can answer from the outside.
   *
   * It goes only to the devices the caller has signed up, never to anyone
   * else's: a test should not buzz the other person's phone.
   */
  app.post("/push/test", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    if (!hasWebPush(app.env)) {
      throw new HttpError(
        503,
        "push_not_configured",
        "Notifications are not set up on this server yet.",
      );
    }

    // Normally done once at startup. Repeated here so a test still works if
    // the notifier failed to start, which is one of the things being tested.
    configurePush(app.env);

    const mine = await app.db.prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (mine.length === 0) {
      return reply.send({ subscriptions: 0, sent: 0, gone: 0, abandoned: 0, failed: 0 });
    }

    const result = await sendToAll(
      app.db.prisma,
      mine,
      {
        body: "Notifications are working on this device.",
        url: "/",
        tag: "headroom:test",
      },
      app.log,
    );

    return reply.send({ subscriptions: mine.length, ...result });
  });

  app.delete("/push/subscriptions", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = unsubscribeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", "Which subscription?");
    }

    /*
     * Scoped to the household rather than to the person: either of them may
     * be signed in on a browser that is still subscribed as the other, and
     * "stop this phone buzzing" has to work in that state. Scoping it to the
     * signed-in user would leave a phone nobody could switch off.
     */
    await app.db.prisma.pushSubscription.deleteMany({
      where: {
        endpoint: parsed.data.endpoint,
        user: { householdId: user.householdId },
      },
    });

    return reply.send({ subscribed: false });
  });
}
