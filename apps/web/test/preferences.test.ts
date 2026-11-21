/**
 * Reading the stored appearance back, and the rule about who wins.
 *
 * The theme, the text size and the ledger's density moved onto the server on
 * 2026-11-21, because one of the two clears their browser every day and
 * `localStorage` went with it: "I'd like to store the user preferences in the
 * server and load on login. Then we don't lose the theme, font size or view
 * settings."
 *
 * Two things about that are worth values rather than a look.
 *
 * **The two representations of a text size have to round-trip.** The device
 * stores the multiplier, because `index.html` applies it before the first
 * paint and a name would mean that inline script carrying its own copy of the
 * table. The server stores the step's NAME, because a multiplier is a float
 * and nothing here stores a float if a name will do. One table feeds both, so
 * they cannot disagree - as long as the conversion holds, which is this.
 *
 * **An unrecognised value must leave the device alone.** The other phone can
 * update first and store a theme this build has never heard of. Falling back
 * to the global default there would reset a phone that was perfectly set up,
 * for the sake of a value that is not even wrong - just newer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_SIZES, type Appearance } from "../src/lib/appearance.js";
import { appearanceFromWire, wireFromAppearance } from "../src/lib/preferences.js";

/** What this device is already set to, when the question is what to keep. */
const onTheDevice: Appearance = { theme: "night", scale: 0.82, density: "compact" };

describe("reading what the server stored", () => {
  it("takes all three when it knows all three", () => {
    expect(
      appearanceFromWire(
        { theme: "paper", textSize: "medium", ledgerDensity: "comfortable" },
        onTheDevice,
      ),
    ).toEqual({ theme: "paper", scale: 0.88, density: "comfortable" });
  });

  it("round-trips every size the app offers", () => {
    for (const size of TEXT_SIZES) {
      const appearance: Appearance = { theme: "slate", scale: size.scale, density: "compact" };
      expect(appearanceFromWire(wireFromAppearance(appearance), onTheDevice)).toEqual(appearance);
    }
  });

  it("round-trips every theme the app offers", () => {
    for (const theme of ["system", "daylight", "paper", "clear", "night", "slate"] as const) {
      const appearance: Appearance = { theme, scale: 1, density: "comfortable" };
      expect(appearanceFromWire(wireFromAppearance(appearance), onTheDevice)).toEqual(appearance);
    }
  });

  /**
   * The other phone updated first and chose something this build has never
   * heard of. Leaving this device as it is, is the only answer that does not
   * punish it for being behind.
   */
  it("keeps what the device has when it does not recognise a name", () => {
    expect(
      appearanceFromWire(
        { theme: "midnight_orchard", textSize: "small", ledgerDensity: "spreadsheet" },
        onTheDevice,
      ),
    ).toEqual({ theme: "night", scale: 0.82, density: "compact" });
  });

  /**
   * The exception, and it is deliberate: an unknown text size falls to the
   * DEFAULT rather than to the device, because the scale is the one of the
   * three that can leave the app unusable. A size nothing offers is a size no
   * button can undo, which is the rule `readAppearance` has always followed.
   */
  it("falls back to a size that has a button, for a size that does not", () => {
    expect(
      appearanceFromWire(
        { theme: "night", textSize: "enormous", ledgerDensity: "compact" },
        onTheDevice,
      ).scale,
    ).toBe(1);
  });

  it("stores a name for the size and never a multiplier", () => {
    const wire = wireFromAppearance({ theme: "night", scale: 0.94, density: "compact" });
    expect(wire).toEqual({ theme: "night", textSize: "large", ledgerDensity: "compact" });
    for (const value of Object.values(wire)) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
      // The server's own guard, so a value that would be refused cannot be
      // sent in the first place.
      expect(value.length).toBeLessThanOrEqual(16);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The wiring, since there is no DOM in this suite                            */
/* -------------------------------------------------------------------------- */

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const preferences = source("src/lib/preferences.ts");
const appTsx = source("src/App.tsx");
const session = source("src/lib/session.ts");

describe("the sync", () => {
  /**
   * The load-bearing null. The server answers `preferences: null` for
   * somebody who has never chosen, and a device that already has a choice
   * sends it up rather than being reset by it. Without this, the first load
   * after this shipped would have put a phone set to Night at the smallest
   * size back to Daylight at the largest.
   */
  it("treats never-chosen as a reason to send, not a reason to reset", () => {
    expect(preferences).toContain("if (stored === null) return;");
    expect(session).toContain("readonly preferences?:");
    // Undefined is different again: still loading, or signed out.
    expect(preferences).toContain("if (stored === undefined) return;");
  });

  /**
   * Once per PERSON, not once per mount. One of them signing out and the
   * other signing in happens in the same tab, so `App` never unmounts and
   * this hook never remounts - and a boolean here had already been set by the
   * first of them, which left the second with whatever the phone was looking
   * like instead of their own theme.
   */
  it("adopts the stored answer once per person, not once ever", () => {
    expect(preferences).toContain("const adoptedForRef = useRef<string | null>(null);");
    expect(preferences).toContain("if (adoptedForRef.current === userId) return;");
    expect(preferences).toContain("adoptedForRef.current = userId;");
    // And the id is in the dependencies, or the switch is never noticed.
    expect(preferences).toContain("}, [enabled, userId, session.data]);");
  });

  /** Or the adopted value goes straight back up, and round again. */
  it("does not echo back what it has just been told", () => {
    expect(preferences).toContain("settledRef.current = JSON.stringify(wireFromAppearance(next))");
    expect(preferences).toContain("if (settledRef.current === asText) return;");
  });

  it("is mounted once, for the whole app", () => {
    expect(appTsx).toContain("useAppearanceSync(Boolean(session.data));");
    expect(appTsx.match(/useAppearanceSync/g)).toHaveLength(2); // the import and the call
  });

  /**
   * Nothing is said to anybody when a save fails. The choice applies on this
   * device either way and it is a theme; an error banner over the ledger
   * would be worse than the thing it reported.
   */
  it("fails quietly, and tries again on the next change", () => {
    expect(preferences).toContain("onError: () => {");
    expect(preferences).toContain("settledRef.current = null;");
  });

  /** A round trip to learn what the response has already said. */
  it("writes the answer into the session rather than refetching it", () => {
    expect(preferences).toContain("queryClient.setQueryData<SessionResponse | null>");
    expect(preferences).not.toContain("invalidateQueries");
  });
});
