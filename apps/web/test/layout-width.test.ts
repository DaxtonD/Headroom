/**
 * The app cannot be made wider than the phone it is on.
 *
 * Reported from use: opening a row on the ledger "causes the window to expand
 * horizontally and overflow. I have to pinch-zoom out to see the whole UI
 * again."
 *
 * The cause was the shell's grid. A track sized `auto` - which is what a
 * single-column grid gets by default, and what `1fr` still falls back to for
 * its minimum - is never narrower than the widest min-content inside it. So a
 * control that could not be squeezed did not overflow its own row: it widened
 * the track, and with it the header, the tab bar and the page. Nothing on the
 * ledger looked wrong, because what had changed size was the app.
 *
 * `minmax(0, …)` caps the track at the viewport instead. This is exactly the
 * kind of thing that gets "tidied" back out by someone who reads `1fr` as
 * already meaning this, so it is worth stating in a test that says why.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shellCss = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "Shell.css"),
  "utf8",
);

/** Every `grid-template-columns:` declaration in the file, value only. */
const columnDeclarations = [...shellCss.matchAll(/grid-template-columns:\s*([^;]+);/g)].map(
  (match) => (match[1] as string).replace(/\s+/g, " ").trim(),
);

describe("the shell's grid", () => {
  it("declares its columns at all", () => {
    // The phone layout and the desktop one.
    expect(columnDeclarations.length).toBe(2);
  });

  it("gives every flexible track a zero minimum", () => {
    for (const declaration of columnDeclarations) {
      expect(declaration, `"${declaration}" can be widened by its contents`).toContain(
        "minmax(0,",
      );
      // A bare `1fr` anywhere in the list brings the floor back with it.
      expect(declaration.replace(/minmax\(0,[^)]*\)/g, "")).not.toContain("fr");
    }
  });

  it("keeps the fixed desktop sidebar fixed", () => {
    // The sidebar is a real width and must not be turned into a flexible
    // track by a future edit to the line above.
    const desktop = columnDeclarations.find((declaration) => declaration.includes("px"));
    expect(desktop).toBe("220px minmax(0, 1fr)");
  });

  it("frees every grid item from its own min-content floor", () => {
    // `minmax(0, 1fr)` sizes the track; a grid ITEM still has an automatic
    // minimum of its own, so both are needed.
    const areas = [".shell-header", ".shell-offline", ".shell-nav", ".shell-main"];
    const rule = shellCss.match(/((?:\.shell-[a-z]+,\s*)+\.shell-[a-z]+)\s*\{[^}]*min-width:\s*0/);
    expect(rule, "no shared min-width: 0 rule for the grid items").not.toBeNull();
    for (const area of areas) {
      expect((rule?.[1] as string).includes(area), `${area} still has a min-content floor`).toBe(
        true,
      );
    }
  });
});
