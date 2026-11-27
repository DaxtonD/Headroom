/**
 * What build the server is serving, and how to get onto it.
 *
 * This is the escape hatch for a service worker that will not update. The
 * update bar the app already has depends on the service worker lifecycle
 * noticing a new worker and telling React about it; when that chain does not
 * fire, the app sits on an old bundle indefinitely and says nothing. It
 * happened, on a deployed install, and from the inside it was invisible.
 *
 * So this asks a question that does not go through the service worker at all:
 * what build does the server say it is? `/api/health` is unauthenticated and
 * is explicitly excluded from the service worker's navigation fallback, so
 * the answer comes from the network or not at all.
 */
import { useEffect, useState } from "react";
import { BUILD_ID, isStaleBuild } from "./buildId.js";

/** Cache-busted, because the whole point is to not be told what we had. */
interface Health {
  readonly buildId: string | null;
  /** Seconds the app's clock is ahead of the database's. Null if unknown. */
  readonly clockSkewSeconds: number | null;
}

async function fetchHealth(): Promise<Health | null> {
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { buildId?: unknown; clockSkewSeconds?: unknown };
    return {
      buildId: typeof body.buildId === "string" ? body.buildId : null,
      clockSkewSeconds:
        typeof body.clockSkewSeconds === "number" ? body.clockSkewSeconds : null,
    };
  } catch {
    // Offline, or the server is down. Neither says anything about staleness.
    return null;
  }
}

export interface ServerBuild {
  /** What the server reports, once known. */
  readonly serverBuild: string | null;
  /**
   * How far the server's clock is from its database's, in seconds.
   *
   * It decides what day it is, and every figure on every screen is derived
   * from that - so this is not a timestamp detail. Null when unknown.
   */
  readonly clockSkewSeconds: number | null;
  /** The app is definitely running a build the server is no longer serving. */
  readonly stale: boolean;
  /** Ask again now. */
  readonly recheck: () => void;
}

export function useServerBuild(): ServerBuild {
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [clockSkewSeconds, setClockSkew] = useState<number | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const ask = (): void => {
      void fetchHealth().then((health) => {
        if (cancelled || health === null) return;
        if (health.buildId !== null) setServerBuild(health.buildId);
        setClockSkew(health.clockSkewSeconds);
      });
    };

    ask();

    // Reopening the app is the moment worth checking, and for this household
    // that is several times a day.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") ask();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [asked]);

  return {
    serverBuild,
    clockSkewSeconds,
    stale: serverBuild !== null && isStaleBuild(BUILD_ID, serverBuild),
    recheck: () => setAsked((count) => count + 1),
  };
}

/**
 * How long to let a worker finish installing before giving up on it.
 *
 * This used to be one three-second wall for the whole promotion, and that
 * number was measuring the wrong thing. `registration.update()` resolves once
 * the worker SCRIPT has been fetched and the install has been *started* - not
 * finished - and installing means precaching the shell, which is over half a
 * megabyte. On a phone on mobile data that is routinely longer than three
 * seconds, so the promotion below found no `waiting` worker to talk to, judged
 * the lifecycle uncooperative, and unregistered a worker whose only fault was
 * being partway through its job.
 *
 * Twenty seconds is long enough for that download on a bad connection. It is
 * never the common path: a worker that has already installed is promoted
 * immediately, and this only runs when one is genuinely mid-install.
 */
const INSTALL_CAP_MS = 20_000;

/**
 * How long to give a worker that has been *told* to take over.
 *
 * Activation itself is immediate once installed, so this stays short - a tap
 * on "Reload" still has to feel like a reload.
 */
const TAKEOVER_CAP_MS = 5000;

/** Resolves true once `worker` reaches one of `states`, false if it cannot. */
async function waitForState(
  worker: ServiceWorker,
  states: readonly ServiceWorker["state"][],
  timeoutMs: number,
): Promise<boolean> {
  if (states.includes(worker.state)) return true;

  return await new Promise<boolean>((resolve) => {
    const done = (result: boolean): void => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", onChange);
      resolve(result);
    };
    const onChange = (): void => {
      if (states.includes(worker.state)) done(true);
      // Redundant means it was replaced or failed: it will never get there,
      // so waiting out the timeout would only delay the fallback.
      else if (worker.state === "redundant") done(false);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    worker.addEventListener("statechange", onChange);
  });
}

/**
 * Resolves true once this worker is in charge, false if it never gets there.
 *
 * Two ways of counting as "in charge", and the second is the one that matters
 * on an installed app. `controllerchange` is the clean signal, but it only
 * fires for a page the new worker actually claims - and this app deliberately
 * never calls `clients.claim()`, so for a page already controlled by the old
 * worker it may not fire at all. Reaching `activated` is enough: the
 * registration's active worker is the new one from that moment, which is what
 * the reload immediately afterwards will be served by.
 *
 * Waiting only for `controllerchange` is why the fallback kept firing on a
 * worker that had in fact taken over perfectly well.
 */
async function waitForTakeover(worker: ServiceWorker, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const done = (result: boolean): void => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onController);
      worker.removeEventListener("statechange", onState);
      resolve(result);
    };
    const onController = (): void => done(true);
    const onState = (): void => {
      if (worker.state === "activated") done(true);
      else if (worker.state === "redundant") done(false);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", onController);
    worker.addEventListener("statechange", onState);
  });
}

/**
 * What happened when we tried to get a registration's newest worker in charge.
 *
 * Three outcomes rather than a boolean, and the distinction is the whole
 * point: only one of them justifies unregistering, and the boolean version
 * could not tell it from the commonest case of all.
 */
type Promotion =
  /** A newer worker took over. */
  | "promoted"
  /** There was nothing newer to promote, and nothing is wrong. */
  | "nothing-to-promote"
  /** There is somewhere newer to be and this registration will not go. */
  | "stuck";

/**
 * Get one registration's newest worker into charge, politely.
 *
 * Returns `"stuck"` only when the lifecycle genuinely will not cooperate,
 * which is the single case the caller is entitled to unregister over - and
 * unregistering costs this device its push subscription, so that case has to
 * be narrow and provable rather than "anything that was not a promotion".
 */
async function promote(
  registration: ServiceWorkerRegistration,
  serverBuild: string | null,
): Promise<Promotion> {
  /*
   * `installing` as well as `waiting`, which is the bug this had.
   * Immediately after `update()` a brand-new worker is almost always still
   * installing, so looking only at `waiting` found nothing exactly when
   * there was something to find.
   */
  const candidate = registration.waiting ?? registration.installing;

  /*
   * Nothing newer exists. That used to be judged a failure and answered with
   * an unregister, and it is the ordinary state in two quite different
   * situations:
   *
   *  - the worker already updated itself on its own schedule, so the active
   *    one IS the new build and a reload is all that is left to do;
   *  - `update()` could not reach the server, so there is nowhere newer to
   *    go from here however hard anybody presses.
   *
   * Neither is worth a push subscription. So it asks the active worker which
   * build it is and only calls the registration stuck when that build is one
   * the server has demonstrably moved past. Where it cannot tell - no answer,
   * or no idea what the server is serving - it does not destroy anything.
   */
  if (!candidate) {
    const active = registration.active;
    if (!active) return "stuck";

    const build = await askBuild(active, 3000);
    if (build === null || serverBuild === null) return "nothing-to-promote";
    return build === serverBuild ? "nothing-to-promote" : "stuck";
  }

  if (candidate.state === "installing") {
    const installed = await waitForState(
      candidate,
      ["installed", "activating", "activated"],
      INSTALL_CAP_MS,
    );
    if (!installed) return "stuck";
  }

  // It got all the way there on its own while we waited.
  if (candidate.state === "activated") return "promoted";

  // Listen before posting: activation can be quicker than this stack.
  const takeover = waitForTakeover(candidate, TAKEOVER_CAP_MS);
  candidate.postMessage({ type: "SKIP_WAITING" });
  return (await takeover) ? "promoted" : "stuck";
}

/**
 * Ask the active worker to start serving this page, when nothing is.
 *
 * ## When this happens, and why it is not the same as taking over
 *
 * A page can end up with no controller at all: the load that follows an
 * `unregister()` below, a first load before any worker existed, or a
 * registration the browser is still tearing down. The page works - it came
 * from the network - but nothing is serving it, so it has no offline cache,
 * and until 2026-11-22 nothing ever adopted it, because `clients.claim()` is
 * deliberately never called.
 *
 * That rule exists to stop a new build swapping itself in under somebody
 * halfway through typing a balance. It does not apply here: there is no
 * controller to replace. The page's code is already loaded and claiming
 * changes nothing about it - only where its *later* fetches are answered
 * from. And it stays page-initiated, so "only when the page asks" still
 * holds.
 *
 * ## The guard that matters
 *
 * Only when the worker is the SAME build as this page. A newer worker would
 * start answering from a newer precache, and this page's lazily-loaded chunks
 * are named with hashes from its own build - so the first screen that had not
 * been opened yet would 404. Asking first costs one message on a channel that
 * already exists.
 */
export async function claimIfUncontrolled(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  if (navigator.serviceWorker.controller !== null) return;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const active = registration?.active;
    if (!active) return;

    const build = await askBuild(active, 3000);
    if (build === null || build !== BUILD_ID) {
      /*
       * The active worker is not this page's build, so claiming it would
       * answer this page's hashed chunk requests out of the wrong precache.
       * That part has always been right. What was missing is that it also
       * did nothing else - it returned, and nothing on this path ever asked
       * for the right worker, so the device sat uncontrolled behind an old
       * worker until the browser's own update check came round.
       *
       * "It seems like it resolves itself after a day or two", reported
       * 2026-11-25, is that check. Asking outright turns a day into the few
       * seconds an install takes. Once per page, because this is called
       * repeatedly until something is serving the page and an update is a
       * network fetch of half a megabyte.
       */
      await askForNewWorker(registration);
      return;
    }

    active.postMessage({ type: "CLAIM" });
  } catch {
    // No worker, no permission, or it went away. The next load tries again.
  }
}

/** Whether this page has already asked for the newer worker to be fetched. */
let updateRequested = false;

async function askForNewWorker(registration: ServiceWorkerRegistration): Promise<void> {
  if (updateRequested) return;
  updateRequested = true;
  try {
    await registration.update();
  } catch {
    // Offline, or the server is down. The next load asks again.
  }
}

/**
 * Keep asking to be adopted until something is serving this page.
 *
 * A worker that is still installing has no `active` yet, so a single attempt
 * on mount answers about timing rather than about state - the same trap
 * {@link useWorkerStatus} documents. Stops the moment there is a controller,
 * which is the condition it exists to reach.
 */
export function useClaimIfUncontrolled(): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let attempts = 0;

    const look = (): void => {
      if (cancelled || navigator.serviceWorker.controller !== null) return;

      void claimIfUncontrolled().then(() => {
        attempts += 1;
        if (cancelled || navigator.serviceWorker.controller !== null) return;
        if (attempts < 5) setTimeout(look, 1500);
      });
    };

    look();
    return () => {
      cancelled = true;
    };
  }, []);
}

/**
 * What the service worker is doing on this device, and which build it is.
 *
 * ## Why this is not a yes/no
 *
 * It was, and the yes/no lied twice. First it said "this device is running
 * an older background worker" for any silence, which it cannot know. Then,
 * rewritten to report rather than assert, it still said "did not answer" on
 * a device whose worker had just been installed fresh from the current
 * build - because it asked once, on mount, while that worker was still
 * precaching half a megabyte, and never asked again.
 *
 * A one-shot question about something with a lifecycle gives an answer
 * about timing, not about state. So this reports the state.
 */
export type WorkerState =
  /** This browser has no service workers. */
  | "unsupported"
  /** Nothing is registered for this scope. */
  | "none"
  /** Downloading and precaching. Normal for a few seconds after a fresh load. */
  | "installing"
  /** Ready, but not in charge: an older worker is still running the show. */
  | "waiting"
  /** In charge. This is the one that would receive a push. */
  | "active";

export interface WorkerStatus {
  readonly state: WorkerState;
  /** The active worker's build, when it answered. Null if it did not. */
  readonly buildId: string | null;
  /** Is this page itself being served by a worker? */
  readonly controlled: boolean;
  /**
   * A newer worker is installing or waiting behind the active one.
   *
   * `state` describes the worker in charge, because that is the one that
   * receives a push - but an active worker with a replacement on the way is
   * not the same situation as one with none, and reporting only the first
   * made a transition look like a resting state. See {@link useWorkerStatus},
   * which stopped looking the moment it got an answer and so could show an
   * old build for ever.
   */
  readonly updating: boolean;
}

/**
 * Ask a worker which build it is, over a channel that cannot hang.
 *
 * A worker older than this question never replies, which is itself the
 * answer: it predates the push handler too.
 */
async function askBuild(worker: ServiceWorker, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);

    channel.port1.onmessage = (event: MessageEvent<{ buildId?: unknown }>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(typeof event.data?.buildId === "string" ? event.data.buildId : null);
    };

    try {
      worker.postMessage({ type: "WHICH_BUILD" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
  });
}

export async function workerStatus(): Promise<WorkerStatus> {
  if (!("serviceWorker" in navigator)) {
    return { state: "unsupported", buildId: null, controlled: false, updating: false };
  }

  const controlled = navigator.serviceWorker.controller !== null;

  /*
   * `getRegistration`, not `ready`. `ready` waits for an active worker and
   * does not settle while one is installing, which is exactly the moment
   * this is most often asked - and a timeout there tells you nothing, where
   * "installing" tells you to look again shortly.
   */
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    return { state: "none", buildId: null, controlled, updating: false };
  }

  if (!registration) return { state: "none", buildId: null, controlled, updating: false };

  /*
   * Read before the active worker is asked anything, because asking takes up
   * to three seconds and the answer is about the moment of the question.
   */
  const updating = registration.waiting !== null || registration.installing !== null;

  if (registration.active) {
    return {
      state: "active",
      buildId: await askBuild(registration.active, 3000),
      controlled,
      updating,
    };
  }
  if (registration.waiting) return { state: "waiting", buildId: null, controlled, updating };
  if (registration.installing) {
    return { state: "installing", buildId: null, controlled, updating };
  }

  return { state: "none", buildId: null, controlled, updating: false };
}

/** Kept for the notification test, which only cares about the build. */
export async function activeWorkerBuild(): Promise<string | null> {
  return (await workerStatus()).buildId;
}

/**
 * The worker's state, re-checked while it is still settling.
 *
 * A worker installs in a few seconds, so asking once on mount catches it
 * mid-install and reports a problem that is about to solve itself. This
 * keeps looking until there is an active worker that has answered, or until
 * the install has had long enough to have finished.
 */
export function useWorkerStatus(): WorkerStatus {
  const [status, setStatus] = useState<WorkerStatus>({
    state: "installing",
    buildId: null,
    controlled: false,
    updating: false,
  });

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    const look = (): void => {
      void workerStatus().then((next) => {
        if (cancelled) return;
        setStatus(next);
        attempts += 1;
        /*
         * An active worker that answered is NOT the end of the story while a
         * newer one is installing behind it, and treating it as one is how
         * Settings came to report a build from two releases ago as a settled
         * fact. Reported 2026-11-25, with the three lines disagreeing exactly
         * as they were built to: "the background worker never matches the app
         * or server version after an update."
         *
         * `workerStatus` checks `active` first and is right to - the active
         * worker is the one that receives a push - but the old worker stays
         * active throughout the new one's install, so the first question
         * asked after an update gets the old answer and nothing asked again.
         */
        const settled = next.state === "active" && next.buildId !== null && !next.updating;
        /*
         * Longer while something is actually installing. An install precaches
         * most of a megabyte and the twelve seconds this used to allow is
         * under half of what the update path itself waits for.
         */
        const cap = next.updating || next.state === "installing" ? 30 : 8;
        const giveUp = next.state === "unsupported" || attempts >= cap;
        if (!settled && !giveUp) setTimeout(look, 1500);
      });
    };

    look();
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

/**
 * Get onto the build the server is serving, whatever the worker is doing.
 *
 * Tries the polite route first: a waiting worker is told to take over. Then -
 * and this is the part that was missing - it *waits* to see whether it did.
 * Reloading the instant the message is posted reloads through the old worker,
 * which serves the old bundle again, so the tap appears to do nothing and the
 * bar comes straight back.
 *
 * If a worker that exists and is newer will not take control in time, the
 * lifecycle is not cooperating and that registration is removed outright, so
 * the next load has to come from the network. The precache rebuilds
 * immediately afterwards, so the cost is one online load.
 *
 * ## The unregister is not free, and it used to fire far too readily
 *
 * **A push subscription belongs to the service worker registration.**
 * Unregistering destroys it, the browser is left with nothing to hand over,
 * and the notifications card has no honest answer but "off" - so the person
 * has to turn them on again. Reported from use on 2026-11-25: "after the app
 * detects a new version and offers the restart, the new version requires me
 * to re-enable notifications."
 *
 * This used to unregister **every** registration whenever **no** registration
 * reported a promotion, and "no promotion" is the normal answer when there was
 * nothing newer to promote - a worker that had already updated itself, or an
 * `update()` that could not reach the server. So the commonest healthy state
 * was being answered with the most destructive move available.
 *
 * Now only a registration that `promote` can prove is stuck is removed, and
 * the proof needs the server's build to compare against - which is why that
 * is now a parameter rather than something this function guesses at.
 *
 * The subscription is also rebuilt afterwards, by `resyncSubscription` on the
 * next load, for the case where the unregister was right. Both halves matter:
 * one stops it happening, the other stops it mattering when it does.
 *
 * Always ends in a reload, including when none of it worked, because a reload
 * is what the person asked for.
 */
export async function loadServerBuild(serverBuild: string | null): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();

      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await registration.update();
          } catch {
            // An update check that fails is exactly the case this is for.
          }
        }),
      );

      /*
       * Every registration, not the first one that happens to be `waiting`.
       * A worker mid-install is the usual state right after `update()`, and
       * `promote` is what waits for it instead of writing it off.
       */
      const outcomes = await Promise.all(
        registrations.map(async (registration) => ({
          registration,
          outcome: await promote(registration, serverBuild),
        })),
      );

      await Promise.all(
        outcomes
          .filter((entry) => entry.outcome === "stuck")
          .map(async (entry) => {
            try {
              await entry.registration.unregister();
            } catch {
              // Then the reload below is the only move left.
            }
          }),
      );
    }
  } finally {
    window.location.reload();
  }
}
