/**
 * Telling the other person what just happened.
 *
 * ## Why it hangs off the change stream
 *
 * Every mutation already announces itself, after commit, through Postgres
 * `NOTIFY` - that is how one phone updates when the other saves something.
 * A notification is the same event delivered differently, so it listens to
 * the same thing.
 *
 * Hanging it there buys two properties that would otherwise have to be
 * re-earned at every call site. `pg_notify` is transactional, so a change
 * that rolls back never announces itself and can never be notified about.
 * And nothing in a request path has to know about notifications at all: no
 * route calls this, so no route can fail because a push service is down.
 *
 * ## What is worth a notification
 *
 * The four things the household asked for, and nothing else:
 *
 *  - a chequing or savings balance updated;
 *  - something on the ledger verified, or marked paid;
 *  - a work expense bought, or submitted.
 *
 * Everything else is still in the activity log, which is where a complete
 * record belongs. A notification is an interruption, and a list of everything
 * that interrupts you is a list you turn off.
 *
 * ## Never the person who did it
 *
 * You do not need telling what you just typed. Notifications go to everyone
 * in the household except the actor, on every browser they have signed up.
 */
import { activitySentence, type ActivityEvent } from "@headroom/core";
import type { ChangePing, ChangeStream } from "./changeStream.js";
import type { Env } from "../env.js";
import { configurePush, sendToAll, type PushLogger } from "./push.js";
import type { PrismaLike } from "./versioning.js";

/** The row shape the decision and the wording both need. */
interface Entry extends ActivityEvent {
  readonly userId: string;
  readonly user: { readonly name: string };
}

/**
 * Is this one of the things the household asked to be told about?
 *
 * Deliberately a list of what is in rather than a list of what is out. A new
 * kind of change should arrive silent and be added here on purpose, not
 * start interrupting two people because nobody remembered to exclude it.
 */
export function worthTelling(entry: ActivityEvent): boolean {
  switch (entry.entity) {
    case "balance_snapshot":
      // Every snapshot is a create; there is no other way to change one.
      return entry.action === "create";

    case "occurrence":
      if (entry.action === "verify") return true;
      /*
       * `clear` covers two different flags. `paid` is the ledger tick, which
       * is what was asked for. `cleared` is the balance-update checklist,
       * which happens *as part of* saving a balance - notifying on it would
       * send a second message about one action, and several of them at once
       * when a few bills are ticked off together.
       */
      return entry.action === "clear" && entry.fields.includes("paid");

    case "reimbursement":
      if (entry.action === "create") return true;
      return entry.action === "update" && entry.fields.includes("submitted");

    default:
      return false;
  }
}

/** Where tapping the notification should land. */
export function pathFor(entry: ActivityEvent): string {
  return entry.entity === "reimbursement" ? "/savings" : "/";
}

export interface PushNotifierDeps {
  readonly stream: ChangeStream;
  readonly prisma: PrismaLike;
  readonly env: Env;
  readonly log: PushLogger;
}

/**
 * Start listening. Returns the function that stops it.
 *
 * With no VAPID keys configured this does nothing at all and says so once,
 * which is the correct behaviour for a development machine and for an
 * installation whose owner has not set notifications up.
 */
export function startPushNotifier(deps: PushNotifierDeps): () => void {
  if (!configurePush(deps.env)) {
    deps.log.info({}, "web push is not configured; notifications are off");
    return () => undefined;
  }

  deps.log.info({}, "web push is configured; notifications are on");

  return deps.stream.subscribeAll((ping) => {
    // Deliberately not awaited: the change stream must not wait on a push
    // service, and nothing downstream depends on the result.
    void notifyForPing(deps, ping).catch((error: unknown) => {
      deps.log.warn({ err: error }, "could not send a notification");
    });
  });
}

/**
 * Handle one ping: find what it was, decide, and tell the other person.
 *
 * Exported so the whole chain can be tested without a Postgres LISTEN
 * connection and a real push service - the ping is the only input, and a
 * ping is four fields.
 */
export async function notifyForPing(deps: PushNotifierDeps, ping: ChangePing): Promise<void> {
  /*
   * The ping carries no detail by design - entity, id, version and who. The
   * sentence comes from the activity row that the same transaction wrote,
   * found by exactly those three.
   */
  const entry = (await deps.prisma.activity.findFirst({
    where: {
      householdId: ping.householdId,
      entity: ping.entity,
      entityId: ping.id,
      versionAfter: ping.version,
    },
    orderBy: { at: "desc" },
    select: {
      action: true,
      entity: true,
      label: true,
      labelKind: true,
      fields: true,
      afterJson: true,
      userId: true,
      user: { select: { name: true } },
    },
  })) as (Omit<Entry, "after"> & { afterJson: unknown }) | null;

  if (entry === null) return;

  const event: Entry = {
    action: entry.action,
    entity: entry.entity,
    label: entry.label,
    labelKind: entry.labelKind,
    fields: entry.fields,
    after: (entry.afterJson ?? null) as Record<string, unknown> | null,
    userId: entry.userId,
    user: entry.user,
  };

  if (!worthTelling(event)) return;

  const recipients = await deps.prisma.pushSubscription.findMany({
    where: {
      user: {
        householdId: ping.householdId,
        deletedAt: null,
        // Never the person who did it.
        id: { not: event.userId },
      },
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  if (recipients.length === 0) return;

  const result = await sendToAll(
    deps.prisma,
    recipients,
    {
      body: activitySentence(firstNameOf(event.user.name), event),
      url: pathFor(event),
      /*
       * One tag per kind of thing, so three balance corrections in a row
       * replace each other on the phone instead of stacking up. Not per row:
       * two different bills being verified are two different pieces of news.
       */
      tag: `${event.entity}:${event.label ?? ""}`,
    },
    deps.log,
  );

  if (result.gone > 0) {
    deps.log.info({ gone: result.gone }, "dropped push subscriptions the service says are gone");
  }
}

/** The name as the household says it, matching every other screen. */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
