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
  pushLib.indexOf("export function usePushResync"),
);

describe("handing the subscription back", () => {
  it("re-posts what the browser has to the subscribe route", () => {
    expect(resync).toContain("pushManager.getSubscription()");
    expect(resync).toContain('api.post("/api/push/subscriptions"');
  });

  it("does nothing when this browser has no subscription to hand over", () => {
    // Creating one unasked would be a permission prompt nobody pressed for.
    expect(resync).toMatch(/if \(!existing\) return;/);
    expect(resync).not.toContain("pushManager.subscribe");
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
