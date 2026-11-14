/**
 * The settings gear.
 *
 * There used to be a geometry test here, because the gear was drawn in this
 * repository and the first attempt came out lopsided - "like a hand-drawn svg
 * that isn't symmetrical". It measured eight teeth and caught a coordinate a
 * fifth of a unit out.
 *
 * None of that applies now: the icon is Lucide's, inlined verbatim, so being
 * a well-formed gear is their problem and not ours. What is ours is that it
 * stays themeable, stays recognisably the icon we vendored, and keeps the
 * notice its licence asks to travel with it - which is the sort of thing that
 * quietly disappears in a tidy-up and is the one part with a legal weight.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const shell = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "Shell.tsx"),
  "utf8",
);

/** The `<svg>…</svg>` the gear is drawn with. */
const icon = /<svg[\s\S]*?<\/svg>/.exec(shell)?.[0] ?? "";

describe("the gear", () => {
  it("is in the header", () => {
    expect(icon).not.toBe("");
    expect(shell).toContain("<GearIcon />");
  });

  it("takes its colour from the text around it", () => {
    // Every theme sets the header's text colour, and the gear has to follow
    // it. A fixed colour would be invisible in one of the five.
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).toContain('fill="none"');
  });

  it("hardcodes no colour at all", () => {
    const literals = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    expect(literals.test(icon), `a literal colour in the icon: ${icon}`).toBe(false);
  });

  it("is hidden from a screen reader, which reads the button instead", () => {
    // The button around it carries the name; the drawing itself would
    // otherwise be announced twice or as nothing useful.
    expect(icon).toContain('aria-hidden="true"');

    // And the name says what pressing it does now, because it is a toggle:
    // a button called "Settings" that closes Settings is a lie to anyone
    // who cannot see which screen they are on.
    expect(shell).toContain('"Close settings"');
    expect(shell).toContain('"Settings"');
    expect(shell).toContain("aria-pressed=");
  });

  it("is still the icon that was vendored", () => {
    // Not a geometry check - a shape check. Lucide's gear is one long path
    // plus the hole in the middle, and the path's first and last moves are
    // distinctive enough to notice a hand edit.
    expect(icon).toContain('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18');
    expect(icon).toContain('V4a2 2 0 0 0-2-2z"');
    expect(icon).toContain('<circle cx="12" cy="12" r="3" />');
    expect(icon).toContain('viewBox="0 0 24 24"');
  });

  it("keeps the notice its licence asks for", () => {
    const notices = resolve(root, "THIRD-PARTY-NOTICES.md");
    expect(existsSync(notices), "THIRD-PARTY-NOTICES.md is gone").toBe(true);

    const text = readFileSync(notices, "utf8");
    expect(text).toContain("ISC License");
    expect(text).toContain("Lucide");
    // The permission notice itself, which is the part the licence requires.
    expect(text).toContain("permission notice appear in all copies");

    // And the code says where to find it, so the next person has a reason
    // not to delete it.
    expect(shell).toContain("THIRD-PARTY-NOTICES.md");
  });
});
