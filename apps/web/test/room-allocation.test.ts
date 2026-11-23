/**
 * What the room to save is for, on screen.
 *
 * Asked for on 2026-11-22: "let's build the savings intelligence into the
 * model. A blanket 'room to save' doesn't cover all scenarios. Our household
 * is really trying to save to make lump-sum payments to the mortgage and for
 * vacations, but that doesn't mean every spare dollar is to be allocated to
 * savings."
 *
 * ## The distinction these tests protect
 *
 * **What can safely leave is arithmetic. Where it should go is policy.** The
 * figure from `roomToSaveFrom` is the first, and showing it in the one place
 * and the one type size that make it read as the second is the whole
 * complaint. So the figure is renamed to what it is, the policy sits under it
 * as its own lines, and the remainder is named `Not earmarked`.
 *
 * That last line is the feature. Any change that lets it quietly become zero
 * - allocating to a pot the household never put a plan against, say - would
 * reproduce the exact reading being objected to, and would do it silently.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

const ledger = read("pages", "Ledger.tsx");
const ledgerCss = read("pages", "Ledger.css");
const goalForm = read("components", "GoalForm.tsx");
const queries = read("lib", "queries.ts");
const savingsQueries = read("lib", "savingsQueries.ts");
const savings = read("pages", "Savings.tsx");
const planner = read("lib", "plannerQueries.ts");

describe("the constraint and the policy are kept apart", () => {
  it("renames the figure to what the engine can actually say", () => {
    expect(ledger).toContain("Could move out");
    expect(ledger).toContain("period.roomToSaveCents");
  });

  it("puts the policy underneath it, not inside it", () => {
    // Visibly a breakdown OF the figure, not a competing figure.
    const summary = ledger.slice(ledger.indexOf("Could move out"));
    expect(summary.indexOf("ledger__plan")).toBeGreaterThan(-1);
    expect(summary.indexOf("ledger__plan")).toBeLessThan(summary.indexOf("ledger__subtotal-note"));
  });

  it("takes the division from the engine rather than doing it here", () => {
    /*
     * The allocation rule - in the household's order, each goal up to its
     * stated intent - is tested as behaviour in
     * `packages/core/test/allocateRoom.test.ts`. A second copy on the phone
     * would be the copy that was wrong.
     */
    expect(queries).toContain("readonly roomAllocation: RoomAllocation | null;");
    expect(ledger).not.toContain("allocateRoom(");
  });
});

describe("the line that answers the complaint", () => {
  it("names what is not committed, rather than hiding it", () => {
    // Not "money you have failed to allocate": the part of the room the
    // household has deliberately not promised to anything.
    expect(ledger).toContain("Not earmarked");
    expect(ledger).toContain("roomAllocation.unallocatedCents");
  });

  it("reads as a figure of its own, not as a leftover", () => {
    const rule = ledgerCss.slice(ledgerCss.indexOf(".ledger__plan-row--rest {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("border-top");
    expect(body).toContain("--hr-ink");
  });

  it("says when the plan does not fit the period", () => {
    // The other direction: what was intended but could not be afforded.
    expect(ledger).toContain("roomAllocation.shortCents > 0n");
    expect(ledger).toMatch(/does not fit this period/u);
  });

  it("shows nothing at all when no goal has a plan", () => {
    // A breakdown with no lines in it would be an empty box under a figure.
    expect(ledger).toContain("roomAllocation.lines.length > 0");
  });
});

describe("stating the intent", () => {
  it("asks per payday, which is the unit the figure is in", () => {
    /*
     * The figure it is compared against is what could leave in a pay period.
     * A monthly amount would have to be converted at the point of
     * comparison, and a conversion on money needs a rounding rule nobody
     * asked for.
     */
    expect(goalForm).toContain("Put aside each payday?");
  });

  it("treats blank as a real answer, not as zero", () => {
    /*
     * A pot with no plan is the normal state for a trip - the household's
     * own words in 2026-11-08 were that trips "never have a set date or set
     * cost". Such a goal is never allocated to, which is what keeps "not
     * earmarked" from quietly becoming nothing.
     */
    expect(goalForm).toContain('intent.trim() !== ""');
    expect(goalForm).toContain("intentCents === null ? null : intentCents.toString()");
    expect(goalForm).toMatch(/Leave blank for a pot/u);
  });

  it("is carried by the goals bundle as well", () => {
    expect(planner).toContain("readonly perPaydayIntentCents: Cents | null;");
  });
});

/**
 * The data-loss trap this nearly walked into.
 *
 * The Savings screen edits an earmark through the **goal form**, and that form
 * sends every field it knows about. So an earmark that did not carry the
 * intent would arrive at the form as absent, and saving any edit from Savings
 * would clear the household's plan without mentioning it.
 */
describe("editing a goal from the savings screen", () => {
  it("keeps the plan the household set", () => {
    expect(savingsQueries).toContain("readonly perPaydayIntentCents: Cents | null;");
    expect(savings).toContain("perPaydayIntentCents: earmark.perPaydayIntentCents");
  });

  it("survives an older server that does not send it", () => {
    // Optional on the wire, and absent decodes to null rather than throwing.
    expect(savingsQueries).toMatch(/perPaydayIntentCents\?: string \| null;/u);
    expect(savingsQueries).toContain("earmark.perPaydayIntentCents ?? null");
  });
});
