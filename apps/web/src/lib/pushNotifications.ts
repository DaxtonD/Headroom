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
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { BUILD_ID, isStamped, shortBuild } from "./buildId.js";
import { activeWorkerBuild } from "./serverBuild.js";

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

  const worker = await registration();
  const existing = await worker?.pushManager.getSubscription();
  return existing ? "on" : "off";
}

interface TestResult {
  readonly subscriptions: number;
  readonly sent: number;
  readonly gone: number;
  readonly failed: number;
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
    void currentPushState().then((next) => {
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
        const workerBuild = await activeWorkerBuild();
        setTestResult(describeTest(result, workerBuild));
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
function describeTest(result: TestResult, workerBuild: string | null): string {
  if (result.subscriptions === 0) {
    return "This device is not signed up. Turn notifications on first.";
  }
  if (result.gone > 0 && result.sent === 0) {
    return "This device's subscription had expired, so it has been forgotten. Turn notifications off and on again.";
  }
  if (result.failed > 0 && result.sent === 0) {
    return "The push service would not take it. The server log says why.";
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
  if (workerBuild === null) {
    const page = isStamped(BUILD_ID) ? ` This page is ${shortBuild(BUILD_ID)}.` : "";
    return (
      "Sent, but the background worker on this device did not answer. It is either not running, " +
      `or older than this page — either way it cannot receive a notification.${page} ` +
      "Reload the app, and check Settings → Version."
    );
  }

  if (isStamped(workerBuild) && isStamped(BUILD_ID) && workerBuild !== BUILD_ID) {
    return (
      `Sent, but this page is build ${shortBuild(BUILD_ID)} and the background worker is ` +
      `${shortBuild(workerBuild)}. The worker is the half that receives notifications. Reload.`
    );
  }

  return "Sent. If nothing appears within a few seconds, the phone is holding it back rather than the app — check notification settings and battery saving for your browser.";
}
