/**
 * The number on the app icon.
 *
 * Worth testing because every way it can go wrong is silent. The API is not
 * implemented at all on iOS and only shows anything on Android once the app
 * is installed, so a mistake here looks exactly like "this phone does not
 * support it" - and the one failure that is not silent, an unhandled
 * rejection on every refresh, happens in the browsers that have the API but
 * decline to use it right now.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeSupported, clearAppBadge, setAppBadge } from "../src/lib/appBadge.js";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function withNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else Reflect.deleteProperty(globalThis as object, "navigator");
});

describe("where the browser supports it", () => {
  it("shows the count", async () => {
    const setBadge = vi.fn().mockResolvedValue(undefined);
    withNavigator({ setAppBadge: setBadge, clearAppBadge: vi.fn() });

    await setAppBadge(4);
    expect(setBadge).toHaveBeenCalledWith(4);
  });

  it("takes the badge off rather than showing a zero", async () => {
    // `setAppBadge(0)` shows a dot on some platforms, which reads as "there
    // is something here" - the opposite of what no work left means.
    const setBadge = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    withNavigator({ setAppBadge: setBadge, clearAppBadge: clear });

    await setAppBadge(0);
    expect(clear).toHaveBeenCalled();
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("clears on sign-out", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    withNavigator({ setAppBadge: vi.fn(), clearAppBadge: clear });

    await clearAppBadge();
    expect(clear).toHaveBeenCalled();
  });
});

describe("where it does not", () => {
  it("says so", () => {
    withNavigator({});
    expect(badgeSupported()).toBe(false);
  });

  it("does nothing at all, without throwing", async () => {
    withNavigator({});
    await expect(setAppBadge(3)).resolves.toBeUndefined();
  });

  it("swallows a refusal from a browser that has the API but will not use it", async () => {
    // Android Chrome rejects this in a tab rather than an installed app, on
    // every single refresh. An unhandled rejection there is noise forever.
    withNavigator({
      setAppBadge: vi.fn().mockRejectedValue(new Error("Not installed")),
      clearAppBadge: vi.fn().mockRejectedValue(new Error("Not installed")),
    });

    await expect(setAppBadge(3)).resolves.toBeUndefined();
    await expect(clearAppBadge()).resolves.toBeUndefined();
  });
});
