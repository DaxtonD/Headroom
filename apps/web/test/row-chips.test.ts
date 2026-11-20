/**
 * Where a chip sits on a ledger row.
 *
 * Reported from use, 2026-11-19: "the chips aren't coherent - One-off appears
 * in different spots." They all shared one wrapping flex line, so where any
 * chip landed depended on how long the chips before it happened to be. A row
 * reading "Flexible - Mon, Nov 16" pushed One-off onto a second line; a row
 * reading just "Flexible" left it on the first. Same chip, different place,
 * for no reason a reader can see.
 *
 * Widening the row was not enough on its own. Doing the arithmetic for a
 * phone: a status chip, a dated flexible chip and One-off come to roughly
 * 260px, and the row's middle column has about 207px even after the ledger
 * went edge to edge. They were always going to wrap.
 *
 * So the chips are two lines with fixed membership instead of one flow that
 * wraps wherever it runs out. The first line is what happened and when, which
 * every row has. The second is what kind of row it is and which account it
 * touches, which only some rows have - and when they do, it always starts at
 * the same left edge.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rowTsx = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "OccurrenceRow.tsx"),
  "utf8",
);
const rowCss = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "OccurrenceRow.css"),
  "utf8",
);

/** The JSX of the chip span with this class, up to its closing tag. */
function chipGroup(className: string): string {
  const pattern = new RegExp(`<span className="${className}">([\\s\\S]*?)</span>\\s*\\n`, "m");
  return pattern.exec(rowTsx)?.[1] ?? "";
}

describe("the chips are two lines, not one wrapping flow", () => {
  it("has a second group at all", () => {
    expect(rowTsx).toMatch(/row__chips row__chips--about/);
    expect(rowCss).toMatch(/\.row__chips--about\s*\{/);
  });

  /**
   * The second line is rendered only when it has something on it. An empty
   * flex row still takes its gap, so a row with no One-off and no account
   * would gain a blank line under its chips.
   */
  it("renders the second group only when there is something for it", () => {
    expect(rowTsx).toMatch(/\{row\.isOneOff \|\| chargedTo \|\| paidToward \? \(/);
  });
});

describe("what goes on which line", () => {
  const about = chipGroup("row__chips row__chips--about");

  it("keeps One-off and the account chips together on the second", () => {
    expect(about, "the second chip group is empty or unparsed").not.toBe("");
    expect(about).toMatch(/One-off/);
    expect(about).toMatch(/chargedTo/);
    expect(about).toMatch(/paidToward/);
  });

  /**
   * The point of the whole change: One-off is the first thing on its line, so
   * it is in the same place on every row that has one.
   */
  it("puts One-off first on that line", () => {
    const oneOff = about.indexOf("One-off");
    const charged = about.indexOf("chargedTo");
    const pays = about.indexOf("paidToward");

    expect(oneOff).toBeGreaterThan(-1);
    expect(oneOff).toBeLessThan(charged);
    expect(oneOff).toBeLessThan(pays);
  });

  it("leaves the first line to what happened and when", () => {
    const status = chipGroup("row__chips");
    expect(status).not.toBe("");
    // Paid / Received, and the timing chip. Nothing else.
    expect(status).toMatch(/row\.settled \?/);
    expect(status).toMatch(/Flexible/);
    expect(status).not.toMatch(/One-off/);
    expect(status).not.toMatch(/chargedTo/);
    expect(status).not.toMatch(/paidToward/);
  });
});
