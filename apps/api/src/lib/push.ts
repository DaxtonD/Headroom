/**
 * Sending a Web Push notification, and forgetting the ones that are gone.
 *
 * ## What travels
 *
 * A sentence and a path. No amount, ever - the household chose that, and it
 * matches the rule the live-update ping has followed since M2: a notification
 * goes through a third party's push service and lands on a lock screen
 * anybody holding the phone can read. The payload is encrypted to the
 * browser's own key, so the push service cannot read it either, but "nobody
 * can read it in transit" and "nobody can read it on the lock screen" are
 * different claims and only the second one matters here.
 *
 * ## Dead subscriptions
 *
 * A browser's subscription dies when notifications are turned off, the site
 * data is cleared, or the push service expires it, and there is no event that
 * tells us. The push service answers 404 or 410 for one that is gone, and the
 * only correct response is to delete the row. Anything else is a table that
 * grows forever and a send loop that gets slower every month.
 *
 * Other failures - the service being down, a network blip - are not the
 * subscription's fault and only raise a counter.
 */
import webpush, { WebPushError } from "web-push";
import type { Env } from "../env.js";
import { hasWebPush } from "../env.js";
import type { PrismaLike } from "./versioning.js";

/** After this many consecutive failures a subscription is assumed dead. */
const GIVE_UP_AFTER = 5;

export interface PushPayload {
  /** The sentence. Never contains an amount. */
  readonly body: string;
  /** Where tapping it should land. */
  readonly url: string;
  /** Collapses older notifications about the same thing on Android. */
  readonly tag?: string;
}

export interface PushLogger {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
}

let configuredFor: string | undefined;

/**
 * Hand the VAPID details to `web-push`, once.
 *
 * The library keeps them in module state, so this is idempotent and cheap to
 * call again; it re-applies only if the keys actually changed, which in
 * practice means only in tests.
 */
export function configurePush(env: Env): boolean {
  if (!hasWebPush(env)) return false;

  const subject = env.VAPID_SUBJECT as string;
  const publicKey = env.VAPID_PUBLIC_KEY as string;
  const privateKey = env.VAPID_PRIVATE_KEY as string;

  const fingerprint = `${subject}\u0000${publicKey}`;
  if (configuredFor !== fingerprint) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configuredFor = fingerprint;
  }
  return true;
}

export interface Sendable {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface SendResult {
  readonly sent: number;
  /** Rows deleted because the push service said they no longer exist. */
  readonly gone: number;
  /**
   * Rows deleted after `GIVE_UP_AFTER` failures of some other kind.
   *
   * Counted apart from `gone` because the two mean opposite things to
   * whoever has to fix it. "The service says this endpoint is finished" is
   * ordinary and self-correcting - subscribe again and it works. "The
   * service kept refusing us" is usually the VAPID pair, and reporting that
   * one as an expiry sends somebody off to turn notifications off and on
   * again forever, which cannot possibly help.
   */
  readonly abandoned: number;
  readonly failed: number;
}

/**
 * Send one payload to many browsers.
 *
 * Never throws. A notification failing is not a reason for the change that
 * caused it to look like it failed - by the time this runs the money has
 * already been written and committed.
 */
export async function sendToAll(
  prisma: PrismaLike,
  subscriptions: readonly Sendable[],
  payload: PushPayload,
  log?: PushLogger,
): Promise<SendResult> {
  let sent = 0;
  let gone = 0;
  let abandoned = 0;
  let failed = 0;

  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
        );
        sent += 1;
        await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastOkAt: new Date(), failures: 0 },
        });
      } catch (error) {
        /*
         * 404 and 410 are the push service saying this browser is no longer
         * reachable at this endpoint - unsubscribed, site data cleared, or
         * expired. It is the only signal there is, and it is final.
         */
        const status = error instanceof WebPushError ? error.statusCode : 0;
        if (status === 404 || status === 410) {
          gone += 1;
          await prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch(() => undefined);
          return;
        }

        failed += 1;
        log?.warn({ status, endpoint: hostOf(subscription.endpoint) }, "push failed");

        const row = await prisma.pushSubscription
          .update({
            where: { id: subscription.id },
            data: { failures: { increment: 1 } },
            select: { failures: true },
          })
          .catch(() => null);

        // Repeatedly unreachable is indistinguishable from gone, and a row
        // that can never be delivered to is worth no more than one that says
        // so outright.
        if (row !== null && row.failures >= GIVE_UP_AFTER) {
          abandoned += 1;
          await prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch(() => undefined);
        }
      }
    }),
  );

  return { sent, gone, abandoned, failed };
}

/** The push service's host, for a log line that names no endpoint secret. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}
