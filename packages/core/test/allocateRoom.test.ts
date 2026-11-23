/**
 * What the room to save is actually for.
 *
 * Asked for on 2026-11-22: "a blanket 'room to save' doesn't cover all
 * scenarios. Our household is really trying to save to make lump-sum payments
 * to the mortgage and for vacations, but that doesn't mean every spare dollar
 * is to be allocated to savings."
 *
 * ## What these tests are holding
 *
 * **The constraint is not touched.** `roomToSaveFrom` answers what can safely
 * leave chequing; this answers what the household has decided to do with it.
 * Two computations, and the second must never change the first - so
 * `availableCents` comes back exactly as it went in, whatever the goals say.
 *
 * **"Unallocated" has to be able to be non-zero.** It is the figure that
 * answers the complaint. Any rule that quietly absorbs the whole room into
 * goals - allocating to a pot with no stated plan, say - would reproduce the
 * exact reading being objected to, and would do it silently.
 *
 * **Order decides who goes short.** When the room will not stretch, a
 * household funds the first thing fully and the last thing not at all. They do
 * not underfund everything by a quarter, and a proportional split would need a
 * rounding rule on money as well.
 */
import { describe, expect, it } from "vitest";
import { allocateRoom, type RoomGoal } from "../src/allocateRoom.js";

const mortgage: RoomGoal = {
  id: "g-mortgage",
  name: "Mortgage lump sum",
  perPaydayIntentCents: 30_000n,
  sortIndex: 0,
};
const vacation: RoomGoal = {
  id: "g-vacation",
  name: "Vacation",
  perPaydayIntentCents: 20_000n,
  sortIndex: 1,
};
/** A pot with no plan, which is the normal state for a trip. */
const someday: RoomGoal = {
  id: "g-someday",
  name: "Someday",
  perPaydayIntentCents: null,
  sortIndex: 2,
};

describe("when the room covers everything planned", () => {
  const result = allocateRoom({ availableCents: 91_143n, goals: [mortgage, vacation, someday] });

  it("gives each goal exactly what was asked for it", () => {
    expect(result.lines.map((line) => [line.name, line.allocatedCents])).toEqual([
      ["Mortgage lump sum", 30_000n],
      ["Vacation", 20_000n],
    ]);
    expect(result.lines.every((line) => !line.isShort)).toBe(true);
  });

  it("names the rest as unallocated rather than finding a home for it", () => {
    /*
     * The whole point of the feature. This is not money somebody has failed
     * to allocate - it is the part of the room the household has not
     * committed, and it is theirs to leave where it is.
     */
    expect(result.unallocatedCents).toBe(41_143n);
    expect(result.shortCents).toBe(0n);
  });

  it("leaves the constraint exactly as it found it", () => {
    // What can safely leave is arithmetic and this is policy. A policy layer
    // that could change the constraint would be the original bug with extra
    // steps.
    expect(result.availableCents).toBe(91_143n);
    expect(result.intendedCents).toBe(50_000n);
  });
});

describe("a goal with no stated intent", () => {
  it("is not allocated to, and is not listed as a line", () => {
    /*
     * Null is not zero. Automatically earmarking for a pot with no plan would
     * invent a policy nobody stated - and would make "unallocated" always
     * zero, which is precisely the reading being complained about.
     */
    const result = allocateRoom({ availableCents: 91_143n, goals: [someday] });

    expect(result.lines).toEqual([]);
    expect(result.intendedCents).toBe(0n);
    expect(result.unallocatedCents).toBe(91_143n);
  });

  it("is left out when its intent is zero as well", () => {
    // A goal deliberately paused for the year. Listing it with nothing beside
    // it would be a row that says nothing.
    const paused: RoomGoal = { ...vacation, perPaydayIntentCents: 0n };
    const result = allocateRoom({ availableCents: 10_000n, goals: [paused] });

    expect(result.lines).toEqual([]);
    expect(result.unallocatedCents).toBe(10_000n);
  });
});

describe("when the room will not stretch", () => {
  it("funds the first in full and the last not at all", () => {
    /*
     * What a household actually does when money is short. Underfunding
     * everything by a quarter is the arithmetic answer and the wrong one, and
     * it would need a rounding rule on money into the bargain.
     */
    const result = allocateRoom({ availableCents: 35_000n, goals: [mortgage, vacation] });

    expect(result.lines.map((line) => [line.name, line.allocatedCents, line.isShort])).toEqual([
      ["Mortgage lump sum", 30_000n, false],
      ["Vacation", 5_000n, true],
    ]);
  });

  it("says how much of the plan is not reached", () => {
    const result = allocateRoom({ availableCents: 35_000n, goals: [mortgage, vacation] });

    expect(result.shortCents).toBe(15_000n);
    expect(result.unallocatedCents).toBe(0n);
  });

  it("follows the household's order, not the amounts", () => {
    // The household decides what matters. Sorting by size here would quietly
    // overrule them.
    const reversed = allocateRoom({
      availableCents: 25_000n,
      goals: [
        { ...vacation, sortIndex: 0 },
        { ...mortgage, sortIndex: 1 },
      ],
    });

    expect(reversed.lines.map((line) => [line.name, line.allocatedCents])).toEqual([
      ["Vacation", 20_000n],
      ["Mortgage lump sum", 5_000n],
    ]);
  });

  it("allocates nothing at all when there is no room", () => {
    const result = allocateRoom({ availableCents: 0n, goals: [mortgage, vacation] });

    expect(result.lines.map((line) => line.allocatedCents)).toEqual([0n, 0n]);
    expect(result.shortCents).toBe(50_000n);
    expect(result.unallocatedCents).toBe(0n);
  });
});

describe("a period that is already short", () => {
  const result = allocateRoom({ availableCents: -4_000n, goals: [mortgage, vacation] });

  it("allocates nothing and reports the whole plan unmet", () => {
    expect(result.lines.map((line) => line.allocatedCents)).toEqual([0n, 0n]);
    expect(result.shortCents).toBe(50_000n);
    expect(result.unallocatedCents).toBe(0n);
  });

  it("still reports the real constraint, negative and all", () => {
    /*
     * "Nothing fits" and "this period is already underwater" are different
     * pieces of news, and the screen needs to be able to tell them apart.
     * Clamping here would throw the second one away.
     */
    expect(result.availableCents).toBe(-4_000n);
  });
});

describe("the arithmetic holds together", () => {
  it("allocates exactly what it says, with nothing lost or invented", () => {
    for (const available of [0n, 1n, 25_000n, 49_999n, 50_000n, 50_001n, 91_143n]) {
      const result = allocateRoom({ availableCents: available, goals: [mortgage, vacation, someday] });
      const allocated = result.lines.reduce((sum, line) => sum + line.allocatedCents, 0n);

      // Every cent of the room is either allocated or unallocated.
      expect(allocated + result.unallocatedCents, `available ${String(available)}`).toBe(available);
      // And every cent of the plan is either met or short.
      expect(allocated + result.shortCents, `available ${String(available)}`).toBe(
        result.intendedCents,
      );
    }
  });
});
