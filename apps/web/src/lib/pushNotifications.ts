/**
 * Turning notifications on for this browser, and off again.
 *
 * ## Per browser, not per person
 *
 * A push subscription belongs to one browser on one device. Turning them on
 * on a phone does nothing for a laptop, and turning them off on the laptop
 * must not silence the phone. The screen says so, because the alternative is
 * someone turning them "off" and still being buzzed.
 *
 * ## Every way this can fail, named
 *
 * There are five, and four of them are not errors:
 *
 *  - the browser has no push support at all;
 *  - the server has no VAPID keys, so there is nothing to subscribe to;
 *  - the person has blocked notifications for the site, which only they can
 *    undo and only in browser settings;
 *  - they have simply not turned them on;
 *  - and something actually went wrong.
 *
 * Collapsing those into "notifications are off" is what makes a toggle that
 * does nothing when pressed, with no explanation. Each gets its own state
 * and its own sentence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { BUILD_ID, isStamped, shortBuild } from "./buildId.js";
import { workerStatus } from "./serverBuild.js";
import type { WorkerStatus } from "./serverBuild.js";

export type PushState =
  /** Still working out where we stand. */
  | "checking"
  /** This browser cannot do it, whatever anybody presses. */
  | "unsupported"
  /** No VAPID keys on the server; nothing to subscribe to. */
  | "unconfigured"
  /** Blocked for this site. Only the person can undo it, in browser settings. */
  | "blocked"
  /** Available, and off. */
  | "off"
  /** On, for this browser. */
  | "on";

interface KeyResponse {
  readonly configured: boolean;
  readonly publicKey: string | null;
}

export function pushIsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * The VAPID public key, base64url as the server sends it, as the bytes the
 * browser wants.
 *
 * `applicationServerKey` takes raw bytes. Base64url is base64 with two
 * characters swapped and the padding dropped, so both have to be put back
 * before `atob` will touch it.
 */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    // `ready` never rejects; it waits. If no worker ever activates - which
    // is the state this app has been in before - it would hang forever, so
    // it races a timeout rather than leaving the screen saying "checking".
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
  } catch {
    return null;
  }
}

/**
 * The registration as it stands, without waiting for a worker to activate.
 *
 * ## Why reading must not go through `ready`
 *
 * `ready` waits for an **active** worker, and right after an update there is
 * not one for as long as the new worker takes to precache - routinely longer
 * than the five seconds above. The race then resolves null, and the reader
 * below used to treat that as "no subscription", which it reports as `off`.
 *
 * So the one moment the app is most likely to be asked - just after the
 * update bar was tapped - was the one moment it would answer "off" for a
 * device whose subscription was never touched. That is the same mistake
 * `useWorkerStatus` documents: a one-shot question about something with a
 * lifecycle gives an answer about timing rather than about state.
 *
 * The cure is not a longer timeout. A `pushManager` belongs to the
 * **registration**, not to the worker in charge of it, so the question can be
 * answered truthfully while a worker is still installing - as long as nothing
 * waits for one first. Null here means there is genuinely no registration,
 * and a browser with no registration cannot be holding a subscription.
 */
async function registrationNow(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this device has been told to want notifications.
 *
 * ## Why this is remembered at all, and why on the device
 *
 * A subscription can be destroyed without anybody choosing it: unregistering
 * the service worker takes it with it, and the update path does that when a
 * worker will not hand over. Rebuilding one needs no prompt - the permission
 * is still granted - but it does need to know whether this device wanted them
 * in the first place, because re-subscribing a device whose owner switched
 * them off would be the app overruling them.
 *
 * `localStorage`, deliberately, although preferences now live on the server:
 * a push subscription is per device, so "does this device want them" is too.
 * The phone and the laptop answer differently and neither should speak for
 * the other. Clearing site data clears this with it, which is right - it also
 * clears the subscription.
 */
const WANTED_KEY = "headroom.push.wanted";

function wantsNotifications(): boolean {
  try {
    return localStorage.getItem(WANTED_KEY) === "1";
  } catch {
    // Private mode, or storage refused. Then this device has said nothing.
    return false;
  }
}

function rememberWanted(wanted: boolean): void {
  try {
    if (wanted) localStorage.setItem(WANTED_KEY, "1");
    else localStorage.removeItem(WANTED_KEY);
  } catch {
    // The repair below is a convenience; losing it is not worth an error.
  }
}

/**
 * Where this browser stands, asked rather than remembered.
 *
 * Returns a state and changes nothing. Three systems have to agree before
 * notifications can be on - the browser, the server and the person - and any
 * of them can have changed since last time: permission revoked in browser
 * settings, site data cleared, VAPID keys removed from the server. Caching
 * the answer would mean a toggle that says "on" for a subscription that no
 * longer exists.
 */
async function currentPushState(): Promise<PushState> {
  if (!pushIsSupported()) return "unsupported";

  let key: KeyResponse;
  try {
    key = await api.get<KeyResponse>("/api/push/key");
  } catch {
    // Offline, or signed out. Neither is a setting, and claiming they are
    // off would be a guess; "off" is the honest floor until we can ask.
    return "off";
  }

  if (!key.configured) return "unconfigured";
  if (Notification.permission === "denied") return "blocked";

  // `registrationNow`, not `registration`: see the note on it. Waiting for a
  // worker to activate is how this came to report "off" after every update.
  const worker = await registrationNow();
  const existing = await worker?.pushManager.getSubscription();
  return existing ? "on" : "off";
}

/**
 * Tell the server about this browser's subscription again.
 *
 * ## The drift this exists to repair
 *
 * The server deletes a subscription the moment its push service rejects one,
 * and there is no way to tell the browser that happened - no event, nothing
 * to listen for. The browser's own `PushSubscription` object is untouched and
 * goes on existing exactly as before. So the two halves drift apart in
 * silence, and `currentPushState` - which can only see the browser's half -
 * goes on reporting "on" for a device the server has forgotten and will never
 * send anything to again.
 *
 * Reported from use on 2026-11-22: notifications had stopped arriving while
 * the screen still said "On for this device", and the only thing that
 * surfaced it was sending a test on purpose. Nothing short of that would
 * have, which is what made it a bug rather than a nuisance.
 *
 * Re-posting what this browser already has closes the gap. The route is an
 * upsert keyed on the endpoint, so this is a no-op when the server agrees and
 * a repair when it does not.
 *
 * It also clears the server's failure counter for this row, which is the
 * right call rather than an accident: that counter exists to reap a device
 * that cannot be reached, and a device whose owner is opening the app in
 * front of us is not that device.
 */
export async function resyncSubscription(): Promise<void> {
  try {
    const existing = await subscriptionForRepair();
    if (!existing) return;
    await api.post("/api/push/subscriptions", existing.toJSON());
  } catch {
    /*
     * Offline, signed out, or push switched off on the server. None of those
     * is news, none is actionable by the person, and the next load tries
     * again - so this stays quiet rather than putting an error on a screen
     * nobody asked to look at.
     */
  }
}

/**
 * The subscription to hand to the server, rebuilding it if it has been lost.
 *
 * ## Why this is allowed to create one
 *
 * It was not, and the comment said why: "creating one unasked would be a
 * permission prompt nobody pressed for." That reasoning is sound and this
 * does not break it - `requestPermission` is never called here, and the only
 * path that reaches `subscribe` is one where the permission has **already**
 * been granted and this device has **already** said it wants notifications.
 * Neither can be true unless somebody pressed the button at some point.
 *
 * What changed is that a subscription can now be known to have been destroyed
 * without anyone choosing it. Reported from use on 2026-11-25: every new
 * version meant re-enabling notifications. `loadServerBuild` unregisters a
 * service worker that will not hand over, a push subscription belongs to the
 * registration, and so the update took the subscription with it. That path is
 * now much narrower, but it still exists - and when it fires, this is what
 * makes it cost nothing.
 *
 * ## The three gates, each load-bearing
 *
 *  - **a subscription already exists** - then nothing is created and this is
 *    the plain re-post it always was;
 *  - **this device said it wants them** - so the app never overrules somebody
 *    who switched them off;
 *  - **permission is granted** - so no prompt can appear, and a device that
 *    has been blocked since is left alone.
 */
async function subscriptionForRepair(): Promise<PushSubscription | null> {
  const current = await registrationNow();
  const existing = await current?.pushManager.getSubscription();
  if (existing) return existing;

  if (!wantsNotifications()) return null;
  if (Notification.permission !== "granted") return null;

  const key = await api.get<KeyResponse>("/api/push/key");
  if (!key.configured || key.publicKey === null) return null;

  /*
   * `registration`, which waits, rather than `registrationNow`. Subscribing
   * is not reading: the registration this is about has just been rebuilt from
   * nothing, and a worker that is still installing may refuse one.
   */
  const worker = await registration();
  if (!worker) return null;

  return await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key.publicKey),
  });
}

/**
 * Repair the server's record of this browser, once per person per load.
 *
 * Mounted in `App`, not in Settings. The drift is invisible from inside the
 * app, so waiting until somebody opened the notifications screen would mean
 * waiting until they already suspected something was wrong.
 *
 * Keyed on who is signed in rather than run once, because `App` never
 * unmounts and the subscribe route deliberately moves a browser's row to
 * whoever is signed in on it now. On a shared phone, the second person to
 * sign in should get the notifications.
 */
export function usePushResync(userId: string | null): void {
  const doneForRef = useRef<string | null>(null);

  useEffect(() => {
    if (userId === null || doneForRef.current === userId) return;
    if (!pushIsSupported()) return;
    doneForRef.current = userId;
    void resyncSubscription();
  }, [userId]);
}

interface SendFailure {
  readonly host: string;
  readonly status: number;
}

interface TestResult {
  readonly subscriptions: number;
  readonly sent: number;
  readonly gone: number;
  readonly abandoned: number;
  readonly failed: number;
  readonly rejections?: readonly SendFailure[];
}

/**
 * The status the push service answered with, when every attempt agreed.
 *
 * Disagreement means two devices failing for two reasons, and no single
 * sentence is honest about that - so it returns null and the caller falls
 * back to saying only what it knows.
 */
function oneStatus(result: TestResult): number | null {
  const statuses = new Set((result.rejections ?? []).map((rejection) => rejection.status));
  if (statuses.size !== 1) return null;
  const [only] = [...statuses];
  return only ?? null;
}

export interface PushControls {
  readonly state: PushState;
  /** Set when something actually went wrong, as opposed to being switched off. */
  readonly error: string | null;
  readonly busy: boolean;
  readonly turnOn: () => void;
  readonly turnOff: () => void;
  /** Send one to this device, and say what the push service made of it. */
  readonly sendTest: () => void;
  /** What the last test said, in a sentence. */
  readonly testResult: string | null;
}

export function usePushNotifications(): PushControls {
  /*
   * Worked out at initialisation rather than in the effect. A browser
   * without push support is knowable before anything is asked, and
   * setting it from inside the effect is both a wasted render and the
   * pattern the React rules flag: state written synchronously on mount.
   */
  const [state, setState] = useState<PushState>(() =>
    pushIsSupported() ? "checking" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  /*
   * The effect asks an external system and sets state in the answer's
   * callback, which is the shape effects are for. The asking itself is a
   * plain function outside the component that returns a value and touches
   * no state - so "where do we stand" is testable on its own, and there is
   * no path on which mounting writes state synchronously.
   */
  useEffect(() => {
    let cancelled = false;
    /*
     * Repair first, then report. The card has to answer a question about a
     * subscription that may have been destroyed moments ago by an update, and
     * reporting before repairing is what showed "off" to somebody who had
     * changed nothing. `resyncSubscription` never rejects and is a no-op when
     * there is nothing to mend, so the cost is two requests on a screen
     * somebody opened on purpose.
     */
    void resyncSubscription()
      .then(() => currentPushState())
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = useCallback((): void => {
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const key = await api.get<KeyResponse>("/api/push/key");
        if (!key.configured || key.publicKey === null) {
          setState("unconfigured");
          return;
        }

        /*
         * Asked for only when they press the button. A permission prompt on
         * arrival is the single most reliable way to be refused forever -
         * and "denied" cannot be undone by this app at all.
         */
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setState(permission === "denied" ? "blocked" : "off");
          return;
        }

        const worker = await registration();
        if (!worker) {
          setError("The app's background worker is not running yet. Reload and try again.");
          return;
        }

        const subscription = await worker.pushManager.subscribe({
          // Required by every browser: a push must always show something.
          userVisibleOnly: true,
          applicationServerKey: keyBytes(key.publicKey),
        });

        await api.post("/api/push/subscriptions", subscription.toJSON());
        /*
         * Written only once the whole thing worked, so a half-finished
         * attempt never leaves this device asking to be re-subscribed to
         * something it never managed to subscribe to.
         */
        rememberWanted(true);
        setState("on");
      } catch {
        setError("Could not turn notifications on. Try again in a moment.");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const turnOff = useCallback((): void => {
    setBusy(true);
    setError(null);

    /*
     * Recorded before anything is attempted, unlike turning them on. The
     * intent is what the repair consults, and a press that fails halfway
     * must not leave this device asking to be signed up again on next load -
     * that would read as the app turning them back on by itself.
     */
    rememberWanted(false);

    void (async () => {
      try {
        const worker = await registration();
        const subscription = await worker?.pushManager.getSubscription();

        /*
         * The server is told first. If the browser's own unsubscribe then
         * fails, the worst case is a row pointing at a live subscription
         * nobody wants - and the next send gets a rejection and deletes it.
         * The other order risks the opposite: unsubscribed in the browser,
         * still stored here, and silently undeletable.
         */
        if (subscription) {
          await api.delete("/api/push/subscriptions", {
            body: { endpoint: subscription.endpoint },
          });
          await subscription.unsubscribe();
        }

        setState("off");
      } catch {
        setError("Could not turn notifications off. Try again in a moment.");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  /**
   * Send one to this device on purpose.
   *
   * Notifications normally go to the other person, which makes "it does not
   * work" impossible to test alone and impossible to tell apart from "there
   * was nothing to tell you about". This exercises the same path and says
   * what came back.
   */
  const sendTest = useCallback((): void => {
    setBusy(true);
    setError(null);
    setTestResult(null);

    void (async () => {
      try {
        const result = await api.post<TestResult>("/api/push/test");
        /*
         * Asked at the same time, because "sent, and nothing appeared" has
         * one likely explanation and it is this one.
         */
        const worker = await workerStatus();
        setTestResult(describeTest(result, worker));
      } catch {
        setError("Could not send a test notification. Try again in a moment.");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  return { state, error, busy, turnOn, turnOff, sendTest, testResult };
}

/**
 * What the server made of the test, in words.
 *
 * Each outcome means something different and only one of them is "it
 * worked". "Accepted but nothing appeared" is the useful one: it moves the
 * problem off this app entirely and onto the phone's own settings, which is
 * where nobody would think to look otherwise.
 */
function describeTest(result: TestResult, worker: WorkerStatus): string {
  if (result.subscriptions === 0) {
    return "This device is not signed up. Turn notifications on first.";
  }
  /*
   * Checked before `gone`, because a subscription dropped after repeated
   * refusals sets both and the two call for opposite things. Saying "it
   * expired, turn it off and on again" to somebody whose VAPID pair no
   * longer matches is advice that cannot work however many times they take
   * it - the new subscription is refused exactly like the old one.
   */
  if (result.abandoned > 0 && result.sent === 0) {
    return "The push service kept refusing this device, so it has been forgotten. Turning it off and on again will not help until that is fixed - the server log says what was refused, and the VAPID keys are the usual cause.";
  }
  if (result.gone > 0 && result.sent === 0) {
    /*
     * 404 and 410 both mean the row is dropped, and they are opposite news.
     *
     * 410 is the push service retiring a subscription: ordinary, and
     * subscribing again is the whole fix. 404 from FCM almost always means
     * the VAPID pair the server signs with is not the pair this browser
     * subscribed with - and then a fresh subscription is rejected exactly
     * like the last one. Reported on 2026-11-22 by someone who had turned
     * notifications off and on again and been told the same thing twice.
     */
    if (oneStatus(result) === 404) {
      return "The push service does not recognise this device (404). That almost always means the server's VAPID keys are not the pair this browser signed up with - turning notifications off and on again will keep giving this same answer until they match. Check VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the server, then sign every device up again.";
    }
    return "This device's subscription had expired (410), so it has been forgotten. Turn notifications off and on again.";
  }
  if (result.failed > 0 && result.sent === 0) {
    const status = oneStatus(result);
    if (status === 401 || status === 403) {
      return `The push service refused the server's credentials (${String(status)}). That is the VAPID pair itself - the public and private keys are not a matching pair, or VAPID_SUBJECT is not a mailto: or https: address.`;
    }
    return status === null
      ? "The push service would not take it. The server log says why."
      : `The push service would not take it (${String(status)}). The server log has the rest.`;
  }
  if (result.sent === 0) {
    return "Nothing was sent.";
  }
  /*
   * Three different answers, because the first version of this gave one
   * confident one - "this device is still running an older background
   * worker" - and that turned out to be a guess dressed as a diagnosis. It
   * cannot tell a worker that is old from one that is not running from one
   * too old to answer the question at all. So it says what it knows, names
   * the builds, and lets them be compared against Settings → Version.
   */
  /*
   * The worker is the half that receives a push, so its state decides what
   * "sent" actually means. Each of these is a different situation and the
   * earlier version collapsed them all into one confident wrong sentence.
   */
  if (worker.state === "installing") {
    return "Sent, but this device's background worker is still starting up. Give it a few seconds and try again.";
  }
  if (worker.state === "waiting" || worker.state === "none") {
    return "Sent, but this device has no background worker in charge yet, so it cannot receive one. Reload the app and try again.";
  }
  if (worker.state === "active" && worker.buildId === null) {
    return "Sent, but this device's background worker predates notifications and cannot receive them. Reload the app, and check Settings → Version.";
  }
  if (
    worker.buildId !== null &&
    isStamped(worker.buildId) &&
    isStamped(BUILD_ID) &&
    worker.buildId !== BUILD_ID
  ) {
    return (
      `Sent, but this page is build ${shortBuild(BUILD_ID)} and the background worker is ` +
      `${shortBuild(worker.buildId)}. The worker is the half that receives notifications. Reload.`
    );
  }

  return "Sent. If nothing appears within a few seconds, the phone is holding it back rather than the app — check notification settings and battery saving for your browser.";
}
