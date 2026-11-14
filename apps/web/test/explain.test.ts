/**
 * The working shown behind each headline figure.
 *
 * Worth testing because the failure mode is the worst kind: an explanation
 * that is confidently wrong. Somebody opens it precisely because they do not
 * trust the number, so an explanation that does not add up, or that explains
 * a different number than the one on screen, destroys the only thing it was
 * there to build.
 *
 * So each of these checks that the lines add up to the figure being explained.
 * Amounts are invented.
 */
import { describe, expect, it } from "vitest";
import {
  explainInChequing,
  explainLeftThisCycle,
  explainSafeToSpend,
  type Working,
} from "../src/lib/explain.js";

/** The figure a panel finishes on: what it claims to be explaining. */
function total(working: Working): bigint {
  const last = working.lines.at(-1);
  expect(last?.total).toBe(true);
  return last?.cents ?? 0n;
}

/** Start, plus or minus every line between, should reach the total. */
function addsUp(working: Working): boolean {
  const lines = working.lines.slice(0, -1);
  let running = 0n;
  for (const [index, line] of lines.entries()) {
    const cents = line.cents ?? 0n;
    if (index === 0) running = cents;
    else running += line.negative ? -(cents < 0n ? -cents : cents) : cents;
  }
  return running === total(working);
}

describe("in chequing", () => {
  it("says who typed it in and when", () => {
    const working = explainInChequing({
      cents: 200_000n,
      snapshotCents: 200_000n,
      asOf: new Date("2026-11-13T15:00:00.000Z"),
      enteredBy: { name: "Carol" },
    });

    expect(working.lines[0]?.label).toContain("Carol");
    expect(working.lines[0]?.label).toContain("Nov");
    expect(total(working)).toBe(200_000n);
    expect(addsUp(working)).toBe(true);
  });

  it("leaves out the settled line when there is nothing settled", () => {
    const working = explainInChequing({
      cents: 200_000n,
      snapshotCents: 200_000n,
      asOf: new Date("2026-11-13T15:00:00.000Z"),
      enteredBy: null,
    });

    // Two lines: what was typed, and the total. A line reading "less $0.00"
    // invites the question it is supposed to answer.
    expect(working.lines.length).toBe(2);
    expect(working.notes?.join(" ")).toContain("only changes when you enter a new balance");
  });

  it("shows what has been settled since, and still adds up", () => {
    const working = explainInChequing({
      cents: 181_400n,
      snapshotCents: 200_000n,
      asOf: new Date("2026-11-13T15:00:00.000Z"),
      enteredBy: { name: "Carol" },
    });

    expect(working.lines.length).toBe(3);
    expect(total(working)).toBe(181_400n);
    expect(addsUp(working)).toBe(true);
  });

  it("copes with no balance ever entered", () => {
    const working = explainInChequing({
      cents: 0n,
      snapshotCents: 0n,
      asOf: null,
      enteredBy: null,
    });

    expect(working.lines[0]?.label).toBe("Not entered yet");
    expect(addsUp(working)).toBe(true);
  });
});

describe("safe to spend now", () => {
  it("names the row the dip comes after", () => {
    const working = explainSafeToSpend({
      safeToSpendNowCents: 110_000n,
      cushionCents: 0n,
      lowest: { cents: 110_000n, date: "2026-11-17" },
      lowestAfterName: "Rent",
      horizonEnd: "2026-12-24",
    });

    expect(working.lines[0]?.label).toContain("Rent");
    expect(total(working)).toBe(110_000n);
    expect(addsUp(working)).toBe(true);
  });

  it("explains the case that looks like a mistake", () => {
    /*
     * The whole reason the button was asked for: $2,000.00 in the account,
     * $1,500.00 of bills, and "safe to spend" says $2,000.00. It is right -
     * the pay lands before the bills - and it reads as broken until the
     * working says why.
     */
    const working = explainSafeToSpend({
      safeToSpendNowCents: 200_000n,
      cushionCents: 0n,
      lowest: { cents: 200_000n, date: null },
      lowestAfterName: null,
      horizonEnd: "2026-12-24",
    });

    expect(working.lines[0]?.label).toContain("right now");
    const notes = working.notes?.join(" ") ?? "";
    expect(notes).toContain("arrives before it goes out");
    expect(total(working)).toBe(200_000n);
  });

  it("says so when the cushion is set to nothing", () => {
    const working = explainSafeToSpend({
      safeToSpendNowCents: 200_000n,
      cushionCents: 0n,
      lowest: { cents: 200_000n, date: null },
      lowestAfterName: null,
      horizonEnd: "2026-12-24",
    });

    // Dax's cushion is 0.00, which means this figure permits spending to
    // exactly zero. The panel is the right place to make that visible.
    expect(working.notes?.join(" ")).toContain("cushion is set to nothing");
  });

  it("does not nag about the cushion once one is set", () => {
    const working = explainSafeToSpend({
      safeToSpendNowCents: 190_000n,
      cushionCents: 10_000n,
      lowest: { cents: 200_000n, date: null },
      lowestAfterName: null,
      horizonEnd: "2026-12-24",
    });

    expect(working.notes?.join(" ")).not.toContain("cushion is set to nothing");
    expect(addsUp(working)).toBe(true);
    expect(total(working)).toBe(190_000n);
  });

  it("explains that the dip is what limits you, not the end", () => {
    const working = explainSafeToSpend({
      safeToSpendNowCents: 110_000n,
      cushionCents: 0n,
      lowest: { cents: 110_000n, date: "2026-11-17" },
      lowestAfterName: "Rent",
      horizonEnd: "2026-12-24",
    });

    // The misunderstanding this is for: safe-to-spend is not the final total.
    expect(working.notes?.join(" ")).toContain("not what is left at the end");
  });
});

describe("left this cycle", () => {
  it("adds up from the balance through what comes and goes", () => {
    const working = explainLeftThisCycle({
      breakdown: {
        startBalanceCents: 200_000n,
        inCents: 630_000n,
        inCount: 3,
        outCents: 300_000n,
        outCount: 6,
        endCents: 530_000n,
      },
      horizonEnd: "2026-12-24",
    });

    expect(total(working)).toBe(530_000n);
    expect(addsUp(working)).toBe(true);
    expect(working.lines[1]?.label).toContain("3 items");
    expect(working.lines[2]?.label).toContain("6 items");
  });

  it("says one item rather than 1 items", () => {
    const working = explainLeftThisCycle({
      breakdown: {
        startBalanceCents: 200_000n,
        inCents: 210_000n,
        inCount: 1,
        outCents: 18_600n,
        outCount: 1,
        endCents: 391_400n,
      },
      horizonEnd: "2026-12-24",
    });

    expect(working.lines[1]?.label).toContain("1 item)");
    expect(working.lines[2]?.label).toContain("1 item)");
  });

  it("says that marking something paid does not move it", () => {
    const working = explainLeftThisCycle({
      breakdown: {
        startBalanceCents: 200_000n,
        inCents: 0n,
        inCount: 0,
        outCents: 0n,
        outCount: 0,
        endCents: 200_000n,
      },
      horizonEnd: "2026-12-24",
    });

    expect(working.notes?.join(" ")).toContain("Marking something paid does not change this");
  });
});
