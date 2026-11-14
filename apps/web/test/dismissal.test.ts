/**
 * There is one implementation of "how do I get out of this sheet".
 *
 * A modal has to close four ways - Cancel, Escape, Android's Back, and a tap
 * outside - and each of the four has to refuse while a save is in flight. Four
 * behaviours written per sheet is four chances to leave one out, and leaving
 * one out is invisible: the sheet looks finished, and the missing exit is the
 * absence of a line of code.
 *
 * It had already happened. Of the three sheets in the app, the retirement
 * assumptions one had the tap-outside and nothing else - Escape did nothing,
 * Back left the screen altogether, and a tap outside threw the form away
 * while its own save was still running. The other two had all four, which is
 * why nobody noticed: the pattern looked established.
 *
 * So the rule this file enforces is not "each sheet does these four things",
 * which is what drifted. It is "each sheet asks the one place that does them".
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(import.meta.dirname, "..", "src");
const HOOK = "lib/overlayDismissal.ts";

const sources = readdirSync(WEB_SRC, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
  .map((entry) => ({
    name: entry.replaceAll("\\", "/"),
    text: readFileSync(resolve(WEB_SRC, entry), "utf8"),
  }));

const hook = sources.find((file) => file.name === HOOK);

describe("getting out of a sheet", () => {
  it("found the sources and the hook", () => {
    // Otherwise every check below passes having read nothing.
    expect(sources.length).toBeGreaterThan(20);
    expect(hook, `${HOOK} is missing`).toBeDefined();
  });

  it("is implemented once", () => {
    /*
     * Escape is the giveaway. Back has a hook of its own that other things
     * use legitimately - the ledger's expanding rows, the explain panels -
     * and a Cancel button is just a button, but a `window` keydown listener
     * watching for Escape is only ever somebody re-implementing a dialog.
     */
    const listensForEscape = sources
      .filter((file) => file.text.includes('"Escape"'))
      .map((file) => file.name);

    expect(listensForEscape).toEqual([HOOK]);
  });

  it("is what every sheet uses", () => {
    // A backdrop is what makes something a sheet, so this finds them all
    // without a list to keep up to date.
    const sheets = sources.filter((file) => file.text.includes('"sheet-backdrop"'));
    expect(sheets.length).toBeGreaterThanOrEqual(3);

    const rolledTheirOwn = sheets
      .filter((file) => !file.text.includes("useOverlayDismissal("))
      .map((file) => file.name);

    expect(rolledTheirOwn).toEqual([]);
  });

  it("refuses every exit while a save is in flight", () => {
    const text = hook?.text ?? "";

    // Each of the three the hook owns consults `blocked`. Cancel is the
    // sheet's own disabled button, which is visible on the screen.
    expect(text).toContain("blockedRef");
    // Escape.
    expect(text).toMatch(/"Escape"[\s\S]{0,80}blockedRef\.current/);
    // The tap outside.
    expect(text).toMatch(/fromBackdrop && !blockedRef\.current/);
    // And Back, which has the same guard inside its own hook.
    expect(text).toMatch(/useBackDismiss\(true, close, blocked\)/);
  });

  it("only closes on a click that began outside the sheet", () => {
    /*
     * A `click` is dispatched on the nearest common ancestor of the press and
     * the release, so selecting text in the sheet and releasing past its edge
     * dispatches on the backdrop. Closing on that lost whatever had been
     * typed. The press has to have started on the backdrop too.
     */
    expect(hook?.text).toContain("pressedBackdrop");
    expect(hook?.text).toMatch(/onPointerDown[\s\S]{0,200}event\.target === event\.currentTarget/);
  });
});
