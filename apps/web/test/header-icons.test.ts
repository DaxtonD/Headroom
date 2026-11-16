/**
 * The two icons in the header.
 *
 * There used to be a geometry test here, because the gear was drawn in this
 * repository and the first attempt came out lopsided - "like a hand-drawn svg
 * that isn't symmetrical". It measured eight teeth and caught a coordinate a
 * fifth of a unit out.
 *
 * None of that applies now: both icons are Lucide's, inlined verbatim, so
 * being well-formed is their problem and not ours. What is ours is that they
 * stay themeable, stay recognisably the icons we vendored, and keep the
 * notice their licence asks to travel with them - which is the sort of thing
 * that quietly disappears in a tidy-up and is the one part with a legal
 * weight.
 *
 * It covers both because the rules are the same for both, and because the
 * version that checked "the first <svg> in the file" silently started
 * checking the wrong icon the moment a second one was added above it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const shell = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "Shell.tsx"),
  "utf8",
);

/** The `<svg>…</svg>` a named icon component is drawn with. */
function iconIn(component: string): string {
  const start = shell.indexOf(`function ${component}(`);
  if (start === -1) return "";
  return /<svg[\s\S]*?<\/svg>/.exec(shell.slice(start))?.[0] ?? "";
}

const ICONS = [
  ["GearIcon", "<GearIcon />"],
  ["ActivityIcon", "<ActivityIcon />"],
] as const;

describe.each(ICONS)("%s", (component, usage) => {
  const icon = iconIn(component);

  it("is in the header", () => {
    expect(icon, `${component} has no <svg>`).not.toBe("");
    expect(shell).toContain(usage);
  });

  it("takes its colour from the text around it", () => {
    // Every theme sets the header's text colour, and an icon has to follow
    // it. A fixed colour would be invisible in one of the five.
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).toContain('fill="none"');
  });

  it("hardcodes no colour at all", () => {
    const literals = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    expect(literals.test(icon), `a literal colour in ${component}: ${icon}`).toBe(false);
  });

  it("is hidden from a screen reader, which reads the button instead", () => {
    // The button around it carries the name; the drawing itself would
    // otherwise be announced twice or as nothing useful.
    expect(icon).toContain('aria-hidden="true"');
  });

  it("is drawn on the grid it was vendored at", () => {
    expect(icon).toContain('viewBox="0 0 24 24"');
  });
});

describe("the buttons they sit in", () => {
  it("say what pressing them does now, because both are toggles", () => {
    // A button called "Settings" that closes Settings is a lie to anyone who
    // cannot see which screen they are on. Same for Activity.
    for (const label of ['"Close settings"', '"Settings"', '"Close activity"', '"Activity"']) {
      expect(shell, `${label} is missing`).toContain(label);
    }
    expect(shell).toContain("aria-pressed=");
  });
});

describe("the drawings themselves", () => {
  it("is still the gear that was vendored", () => {
    // Not a geometry check - a shape check. Lucide's gear is one long path
    // plus the hole in the middle, and the path's first and last moves are
    // distinctive enough to notice a hand edit.
    const gear = iconIn("GearIcon");
    expect(gear).toContain('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18');
    expect(gear).toContain('V4a2 2 0 0 0-2-2z"');
    expect(gear).toContain('<circle cx="12" cy="12" r="3" />');
  });

  it("is still the history icon that was vendored", () => {
    // A clock with an arrow going back round it: the arc and its arrowhead,
    // then the hands.
    const history = iconIn("ActivityIcon");
    expect(history).toContain('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />');
    expect(history).toContain('<path d="M3 3v5h5" />');
    expect(history).toContain('<path d="M12 7v5l4 2" />');
  });
});

describe("the licence", () => {
  it("keeps the notice it asks for", () => {
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
