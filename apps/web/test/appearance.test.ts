/**
 * The appearance store, and the seam it sits on.
 *
 * Two things here are worth a test rather than a look:
 *
 *  1. **Storage can throw.** A private window, or a browser with site data
 *     blocked, makes `localStorage.getItem` raise rather than return null. An
 *     unguarded read there takes the whole app down at startup, on the first
 *     line of the first render, with a blank screen and no clue why.
 *
 *  2. **The keys are written twice.** `index.html` applies the theme before
 *     the first paint, so it reads the same two keys this module writes, from
 *     its own inline script. Nothing but a test connects the two copies, and
 *     the symptom of a drift is mild enough to miss: the app simply forgets
 *     the theme on every reload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  TEXT_SCALE_STORAGE_KEY,
  TEXT_SIZES,
  THEMES,
  THEME_STORAGE_KEY,
  paletteFor,
  readAppearance,
  saveAppearance,
} from "../src/lib/appearance.js";

const INDEX_HTML = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf8");
const TOKENS = readFileSync(
  resolve(import.meta.dirname, "..", "src", "styles", "tokens.css"),
  "utf8",
);

/* -------------------------------------------------------------------------- */
/* A browser, enough of one                                                   */
/* -------------------------------------------------------------------------- */

interface FakeWindow {
  store: Map<string, string>;
  dark: boolean;
  throws: boolean;
}

let fake: FakeWindow;

beforeEach(() => {
  fake = { store: new Map(), dark: false, throws: false };

  const localStorage = {
    getItem: (key: string): string | null => {
      if (fake.throws) throw new DOMException("denied", "SecurityError");
      return fake.store.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (fake.throws) throw new DOMException("denied", "SecurityError");
      fake.store.set(key, value);
    },
  };

  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn() },
  };

  vi.stubGlobal("window", {
    localStorage,
    matchMedia: (query: string) => {
      if (fake.throws) throw new Error("no matchMedia");
      return {
        matches: query.includes("dark") && fake.dark,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    },
  });

  vi.stubGlobal("document", {
    documentElement: root,
    querySelector: () => null,
  });

  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#123b33" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */

describe("the appearance store", () => {
  it("starts on the theme the app already had", () => {
    // Not "match my device": installing an update must never change how the
    // app looks without being asked.
    expect(readAppearance()).toEqual({ theme: "daylight", scale: 1 });
    expect(DEFAULT_APPEARANCE.scale).toBe(1);
  });

  it("remembers a choice", () => {
    saveAppearance({ theme: "night", scale: 0.88 });
    expect(readAppearance()).toEqual({ theme: "night", scale: 0.88 });
  });

  it("applies the choice to the document", () => {
    saveAppearance({ theme: "slate", scale: 0.82 });

    expect(document.documentElement.dataset["theme"]).toBe("slate");
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      "--hr-text-scale",
      "0.82",
    );
  });

  it("survives storage that refuses to be read", () => {
    fake.throws = true;

    // The whole app renders off this. It has to answer rather than throw.
    expect(() => readAppearance()).not.toThrow();
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("survives storage that refuses to be written", () => {
    fake.throws = true;
    expect(() => saveAppearance({ theme: "paper", scale: 1 })).not.toThrow();
  });

  it("ignores a stored value it does not recognise", () => {
    fake.store.set(THEME_STORAGE_KEY, "chartreuse");
    fake.store.set(TEXT_SCALE_STORAGE_KEY, "0.3");

    // A scale from an older build, or edited by hand, must not leave the text
    // at a size the settings screen has no button to undo.
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("follows the device only when asked to", () => {
    fake.dark = true;
    expect(paletteFor("system")).toBe("night");
    expect(paletteFor("daylight")).toBe("daylight");

    fake.dark = false;
    expect(paletteFor("system")).toBe("daylight");
    expect(paletteFor("night")).toBe("night");
  });
});

describe("the choices on offer", () => {
  it("names a palette that tokens.css actually defines", () => {
    /*
     * Daylight is the base palette, in the bare `:root`, so it has no
     * `[data-theme]` block of its own - setting `data-theme="daylight"`
     * resolves through to it. Every other name has to be a real block, or the
     * app would set an attribute that selects nothing and show Daylight while
     * the settings screen insisted something else was on.
     */
    const defined = new Set(
      [...TOKENS.matchAll(/:root\[data-theme="([a-z-]+)"\]/g)].map((match) => match[1] as string),
    );
    expect(TOKENS).toMatch(/:root\s*\{/);
    defined.add("daylight");

    const missing = THEMES.filter((theme) => theme.key !== "system")
      .map((theme) => theme.key)
      .filter((key) => !defined.has(key));

    expect(missing).toEqual([]);

    // And the other direction: a palette in the stylesheet that no button
    // offers is dead weight nobody can reach.
    const offered = new Set(THEMES.map((theme) => theme.previews));
    expect([...defined].filter((name) => !offered.has(name as never))).toEqual([]);
  });

  it("only ever scales down from the size the app was designed at", () => {
    // Stated by Dax: the current size is as large as anyone wants it.
    expect(Math.max(...TEXT_SIZES.map((size) => size.scale))).toBe(1);
    expect(Math.min(...TEXT_SIZES.map((size) => size.scale))).toBeGreaterThan(0.5);
    expect(TEXT_SIZES.length).toBeGreaterThan(2);
  });

  it("has no two steps the same", () => {
    const scales = TEXT_SIZES.map((size) => size.scale);
    expect(new Set(scales).size).toBe(scales.length);
  });
});

describe("the pre-paint script in index.html", () => {
  it("reads the same keys this module writes", () => {
    // The drift this catches is quiet: the app would simply forget the theme
    // on every reload, with nothing failing anywhere.
    expect(INDEX_HTML).toContain(THEME_STORAGE_KEY);
    expect(INDEX_HTML).toContain(TEXT_SCALE_STORAGE_KEY);
  });

  it("resolves the device preference the same way", () => {
    expect(INDEX_HTML).toContain("prefers-color-scheme: dark");
    // `system` is not a palette, so the script has to turn it into one before
    // it reaches the stylesheet.
    expect(INDEX_HTML).toContain('"system"');
  });

  it("runs before the app, not after it", () => {
    // After the module script, this would correct a page the browser had
    // already painted - which is the flash it exists to prevent.
    expect(INDEX_HTML.indexOf("headroom.theme")).toBeLessThan(
      INDEX_HTML.indexOf("/src/main.tsx"),
    );
  });
});
