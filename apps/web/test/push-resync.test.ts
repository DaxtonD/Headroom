/**
 * The server forgetting a device, and the app never noticing.
 *
 * Reported from use on 2026-11-22: notifications had stopped arriving, while
 * the notifications card still said "On for this device". Pressing "Send a
 * test" was the only thing that surfaced it, and what it said was that the
 * subscription "had expired".
 *
 * The cause was a gap with no event behind it. The server deletes a push
 * subscription the moment its push service rejects one, and there is nothing
 * it can send the browser to say so - the browser's own `PushSubscription`
 * object carries on existing, unchanged. `currentPushState` reads that object
 * and nothing else, so it reported "on" for a device that would never be sent
 * anything again, and would have gone on reporting it indefinitely.
 *
 * Two repairs, and this file holds both to the source:
 *
 *  - the page hands its subscription back to the server on every load, so a
 *    forgotten row comes back within one app open;
 *  - the worker hands over a rotated one straight away, for the case where
 *    the browser swaps the subscription while no page is open.
 *
 * Neither can be exercised here - there is no browser, no service worker and
 * no push service - so both are checked by reading the source. Weaker than
 * running them, far stronger than the nothing that let this through.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const pushLib = read("src/lib/pushNotifications.ts");
const app = read("src/App.tsx");
const worker = read("src/sw.ts");

/** Just the resync function, so `turnOn` below it cannot answer for it. */
const resync = pushLib.slice(
  pushLib.indexOf("export async function resyncSubscription"),
  pushLib.indexOf("async function subscriptionForRepair"),
);

/**
 * The part that decides what to hand over, and whether to rebuild it.
 *
 * Sliced separately from `resync` for the same reason `resync` is sliced from
 * the file: a test that reads the whole module proves only that some line
 * somewhere says the right thing.
 */
const repair = pushLib.slice(
  pushLib.indexOf("async function subscriptionForRepair"),
  pushLib.indexOf("export function usePushResync"),
);

describe("handing the subscription back", () => {
  it("re-posts what the browser has to the subscribe route", () => {
    // The reading moved into `subscriptionForRepair`, which is the slice
    // below; what this function still does is hand the result over.
    expect(repair).toContain("pushManager.getSubscription()");
    expect(resync).toContain('api.post("/api/push/subscriptions"');
  });

  /**
   * Rebuilding a subscription that was destroyed for the person.
   *
   * This test asserted the opposite - no `subscribe` on this path at all, on
   * the grounds that "creating one unasked would be a permission prompt
   * nobody pressed for". That reasoning still holds and is still enforced;
   * what changed is that a subscription can be destroyed without anybody
   * choosing it.
   *
   * Reported 2026-11-25: every new version meant turning notifications on
   * again. `loadServerBuild` unregisters a worker that will not hand over, a
   * push subscription belongs to the registration, and so the update took it
   * with it. No prompt is involved in putting it back: the permission is
   * already granted, and this device has already said it wants them.
   */
  it("rebuilds a subscription this device asked for and lost", () => {
    expect(repair).toContain("pushManager.subscribe");
    // Nothing is created while the browser still has one.
    expect(repair).toMatch(/if \(existing\) return existing;/);
  });

  it("never prompts, and never overrules somebody who switched them off", () => {
    /*
     * The three gates. Each one alone is enough to stop a subscription being
     * created, and together they mean the only reachable path is "this was
     * on, and something took it away".
     */
    expect(repair).toContain("if (!wantsNotifications()) return null;");
    expect(repair).toContain('if (Notification.permission !== "granted") return null;');
    expect(repair).not.toContain("requestPermission");
  });

  it("records wanting them only once it worked, and not wanting them at once", () => {
    /*
     * Opposite order on purpose. A half-finished "turn on" must not leave the
     * device asking to be re-subscribed to something it never subscribed to;
     * a half-finished "turn off" must not leave the repair putting it back,
     * which would read as the app turning notifications on by itself.
     */
    const on = pushLib.slice(pushLib.indexOf("const turnOn"), pushLib.indexOf("const turnOff"));
    const posted = on.indexOf('api.post("/api/push/subscriptions"');
    const remembered = on.indexOf("rememberWanted(true)");
    expect(posted).toBeGreaterThan(-1);
    expect(remembered).toBeGreaterThan(posted);

    const off = pushLib.slice(pushLib.indexOf("const turnOff"), pushLib.indexOf("const sendTest"));
    expect(off.indexOf("rememberWanted(false)")).toBeLessThan(off.indexOf("try {"));
  });

  it("reads the subscription without waiting for a worker to activate", () => {
    /*
     * The other half of the same report, and the subtler one. `ready` waits
     * for an ACTIVE worker, which right after an update means waiting out the
     * new one's precache - longer than the five-second race it was given. The
     * null that came back was read as "no subscription", which reports as
     * "off"; so the one moment the app was most likely to be asked was the
     * one moment it answered wrongly.
     *
     * A `pushManager` belongs to the registration, not to the worker in
     * charge of it, so nothing needs to be waited for.
     */
    const state = pushLib.slice(
      pushLib.indexOf("async function currentPushState"),
      pushLib.indexOf("export async function resyncSubscription"),
    );
    expect(state).toContain("registrationNow()");
    expect(state).not.toMatch(/await registration\(\)/u);

    const now = pushLib.slice(pushLib.indexOf("async function registrationNow"));
    expect(now.slice(0, now.indexOf("\n}"))).toContain("getRegistration()");
  });

  it("repairs before it reports, so the card cannot answer for a lost one", () => {
    const hook = pushLib.slice(pushLib.indexOf("export function usePushNotifications"));
    const effect = hook.slice(hook.indexOf("useEffect"), hook.indexOf("const turnOn"));
    const repaired = effect.indexOf("resyncSubscription()");
    const reported = effect.indexOf("currentPushState()");
    expect(repaired).toBeGreaterThan(-1);
    expect(reported).toBeGreaterThan(repaired);
  });

  it("stays silent when it cannot reach the server", () => {
    /*
     * Offline and signed out both land here, and neither is a thing the
     * person can act on. An error banner about notifications on a screen
     * they did not open would be noise.
     */
    expect(resync).toContain("catch");
    expect(resync).not.toContain("setError");
  });
});

describe("when the repair runs", () => {
  it("is mounted in App, not only in Settings", () => {
    /*
     * The whole point: the drift is invisible from inside the app, so it
     * cannot wait for somebody to open the one screen that shows it.
     */
    expect(app).toContain("usePushResync");
    expect(app).toContain('from "./lib/pushNotifications.js"');
  });

  it("is keyed on who is signed in, not run once", () => {
    /*
     * `App` never unmounts, and the subscribe route moves a browser's row to
     * whoever is signed in on it now. A plain boolean ref would leave the
     * second person on a shared phone subscribed as the first.
     */
    const hook = pushLib.slice(pushLib.indexOf("export function usePushResync"));
    expect(hook).toMatch(/useRef<string \| null>\(null\)/);
    expect(hook).toMatch(/doneForRef\.current === userId/);
    expect(hook).toMatch(/\}, \[userId\]\);/);
    expect(app).toContain("usePushResync(session.data?.user.id ?? null)");
  });

  it("asks nothing of a browser that cannot do push at all", () => {
    const hook = pushLib.slice(pushLib.indexOf("export function usePushResync"));
    expect(hook).toContain("if (!pushIsSupported()) return;");
  });
});

describe("a subscription the browser rotates by itself", () => {
  it("is handed over by the worker", () => {
    expect(worker).toContain('self.addEventListener("pushsubscriptionchange"');
    const handler = worker.slice(worker.indexOf('self.addEventListener("pushsubscriptionchange"'));
    expect(handler).toContain('fetch("/api/push/subscriptions"');
    expect(handler).toContain('method: "POST"');
  });

  it("sends the session cookie, or the server cannot tell whose it is", () => {
    const handler = worker.slice(worker.indexOf('self.addEventListener("pushsubscriptionchange"'));
    const post = handler.slice(handler.indexOf('fetch("/api/push/subscriptions"'));
    expect(post).toContain('credentials: "same-origin"');
  });

  it("prefers the subscription the event already carries", () => {
    // Subscribing again when the browser has handed one over would be a
    // second round trip for an answer already in hand.
    const handler = worker.slice(worker.indexOf('self.addEventListener("pushsubscriptionchange"'));
    expect(handler).toContain("event.newSubscription ??");
  });

  it("gives up quietly rather than throwing inside the worker", () => {
    const handler = worker.slice(worker.indexOf('self.addEventListener("pushsubscriptionchange"'));
    expect(handler).toContain("catch");
    // The page repairs it on next load, so a failure here costs one app open.
    expect(handler).toContain("event.waitUntil");
  });
});

describe("what the test button says went wrong", () => {
  it("tells a refused subscription apart from an expired one", () => {
    /*
     * Both end with the row deleted, and the advice for them is opposite.
     * Repeated refusals are usually a VAPID pair that no longer matches, and
     * turning notifications off and on again cannot fix that - the new
     * subscription is refused exactly like the old one was.
     */
    const describe_ = pushLib.slice(pushLib.indexOf("function describeTest"));
    expect(describe_).toContain("result.abandoned > 0");
    expect(describe_).toContain("result.gone > 0");

    const abandonedAt = describe_.indexOf("result.abandoned > 0");
    const goneAt = describe_.indexOf("result.gone > 0");
    // Order matters: a give-up sets both counters.
    expect(abandonedAt).toBeLessThan(goneAt);
  });

  it("does not send somebody to turn it off and on again when that cannot help", () => {
    const describe_ = pushLib.slice(pushLib.indexOf("function describeTest"));
    const branch = describe_.slice(
      describe_.indexOf("result.abandoned > 0"),
      describe_.indexOf("result.gone > 0"),
    );
    expect(branch).toContain("will not help");
    expect(branch).toMatch(/VAPID/);
  });

  it("carries the counter the server actually sends", () => {
    const shape = pushLib.slice(pushLib.indexOf("interface TestResult"));
    expect(shape.slice(0, shape.indexOf("}"))).toContain("abandoned");
  });
});

describe("naming the status the push service answered with", () => {
  const describeTest = pushLib.slice(pushLib.indexOf("function describeTest"));

  it("tells a 404 apart from a 410, which the one message could not", () => {
    /*
     * The bug that made this necessary, 2026-11-22: notifications stopped,
     * the test said the subscription "had expired", turning it off and on
     * again produced the same sentence, and there was nothing anywhere to
     * say which of the two statuses it had actually been. They call for
     * opposite things.
     */
    const branch = describeTest.slice(describeTest.indexOf("result.gone > 0"));
    expect(branch).toContain("oneStatus(result) === 404");
    expect(branch).toMatch(/410/);
  });

  it("says plainly that off and on again will not fix a 404", () => {
    const branch = describeTest.slice(describeTest.indexOf("oneStatus(result) === 404"));
    const sentence = branch.slice(0, branch.indexOf("return", branch.indexOf("return") + 1));
    expect(sentence).toMatch(/VAPID/);
    expect(sentence).toMatch(/same answer|will keep giving/);
  });

  it("names the credentials themselves on a 401 or 403", () => {
    const branch = describeTest.slice(describeTest.indexOf("result.failed > 0"));
    expect(branch).toContain("status === 401 || status === 403");
    expect(branch).toMatch(/VAPID_SUBJECT/);
  });

  it("falls back to saying only what it knows when devices disagree", () => {
    /*
     * Two devices failing for two reasons have no single honest sentence,
     * so the status is dropped rather than one of them being picked.
     */
    const helper = pushLib.slice(
      pushLib.indexOf("function oneStatus"),
      pushLib.indexOf("export interface PushControls"),
    );
    expect(helper).toContain("if (statuses.size !== 1) return null;");
  });

  it("works against a server that does not send rejections yet", () => {
    // An installed app can be newer than the server it is talking to, or
    // older. Neither should throw on a screen whose job is diagnosis.
    const shape = pushLib.slice(pushLib.indexOf("interface TestResult"));
    expect(shape.slice(0, shape.indexOf("}"))).toContain("rejections?:");
    expect(pushLib).toContain("result.rejections ?? []");
  });
});
