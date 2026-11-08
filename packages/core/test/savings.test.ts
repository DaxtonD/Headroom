/**
 * One savings account, several earmarks.
 *
 * Every amount here is invented.
 *
 * The case that drives the design is a trip with no target: Dax's words were
 * that trips "never have a set date or set cost". An earmark therefore has to
 * work with `targetCents: null`, and reporting progress against a target
 * nobody set would be a fiction.
 */
import { describe, expect, it } from "vitest";
import { computeSavings, earmarkProgress, mortgageEarmark } from "../src/savings.js";
import type { Earmark } from "../src/savings.js";

const TRIP: Earmark = {
  id: "trip",
  name: "Trip",
  setAsideCents: 300_000n,
  targetCents: null,
  sortIndex: 0,
};

const LUMP_SUM: Earmark = {
  id: "lump",
  name: "Mortgage lump sum",
  setAsideCents: 150_000n,
  targetCents: 1_000_000n,
  purpose: "mortgage_lump_sum",
  sortIndex: 1,
};

describe("reconciling the account against its earmarks", () => {
  it("reports what is not spoken for", () => {
    const summary = computeSavings({
      balanceCents: 500_000n,
      earmarks: [TRIP, LUMP_SUM],
    });

    expect(summary.earmarkedCents).toBe(450_000n);
    expect(summary.unallocatedCents).toBe(50_000n);
    expect(summary.isOverAllocated).toBe(false);
  });

  it("says so when more has been promised than exists", () => {
    // The thing a spreadsheet will not tell you. Clamping this to zero would
    // lose the fact that a plan does not fit.
    const summary = computeSavings({
      balanceCents: 400_000n,
      earmarks: [TRIP, LUMP_SUM],
    });

    expect(summary.unallocatedCents).toBe(-50_000n);
    expect(summary.isOverAllocated).toBe(true);
  });

  it("treats an empty account as entirely unallocated", () => {
    const summary = computeSavings({ balanceCents: 0n, earmarks: [] });

    expect(summary.earmarkedCents).toBe(0n);
    expect(summary.unallocatedCents).toBe(0n);
    expect(summary.isOverAllocated).toBe(false);
  });

  it("counts a balance with no earmarks as all unallocated", () => {
    const summary = computeSavings({ balanceCents: 500_000n, earmarks: [] });

    expect(summary.unallocatedCents).toBe(500_000n);
  });

  it("orders earmarks by sortIndex, not by amount", () => {
    const summary = computeSavings({
      balanceCents: 500_000n,
      earmarks: [LUMP_SUM, TRIP],
    });

    expect(summary.earmarks.map((earmark) => earmark.id)).toEqual(["trip", "lump"]);
  });
});

describe("an earmark with no target", () => {
  it("accumulates without pretending to have progress", () => {
    const progress = earmarkProgress(TRIP);

    expect(progress.targetCents).toBeNull();
    expect(progress.remainingCents).toBeNull();
    expect(progress.percent).toBeNull();
    expect(progress.isMet).toBe(false);
  });

  it("defaults to a general purpose", () => {
    expect(earmarkProgress(TRIP).purpose).toBe("general");
  });
});

describe("an earmark with a target", () => {
  it("reports what is left and how far along it is", () => {
    const progress = earmarkProgress(LUMP_SUM);

    expect(progress.remainingCents).toBe(850_000n);
    expect(progress.percent).toBe(15);
    expect(progress.isMet).toBe(false);
  });

  it("never reports a negative remainder once it is met", () => {
    const progress = earmarkProgress({ ...LUMP_SUM, setAsideCents: 1_200_000n });

    expect(progress.remainingCents).toBe(0n);
    expect(progress.percent).toBe(120);
    expect(progress.isMet).toBe(true);
  });

  it("treats a target of nothing as a deliberately paused pot", () => {
    // This is the mortgage lump sum in a year the household decided to skip:
    // a real state, not a division to guard against.
    const paused = earmarkProgress({ ...LUMP_SUM, targetCents: 0n, setAsideCents: 0n });

    expect(paused.percent).toBe(100);
    expect(paused.isMet).toBe(true);
    expect(paused.remainingCents).toBe(0n);
  });
});

describe("finding the pot that feeds the payoff projection", () => {
  it("picks it out by purpose, not by name", () => {
    const summary = computeSavings({ balanceCents: 500_000n, earmarks: [TRIP, LUMP_SUM] });
    const found = mortgageEarmark(summary);

    expect(found?.id).toBe("lump");
  });

  it("returns nothing when no pot is for the mortgage", () => {
    const summary = computeSavings({ balanceCents: 500_000n, earmarks: [TRIP] });

    expect(mortgageEarmark(summary)).toBeNull();
  });
});

describe("inputs the engine refuses", () => {
  it("rejects a negative amount set aside", () => {
    expect(() => earmarkProgress({ ...TRIP, setAsideCents: -1n })).toThrow(/negative amount/);
  });

  it("rejects a negative target", () => {
    expect(() => earmarkProgress({ ...LUMP_SUM, targetCents: -1n })).toThrow(/negative target/);
  });
});
