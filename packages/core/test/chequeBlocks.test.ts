/**
 * What is left of each cheque, and the one property that keeps it honest.
 *
 * The arithmetic is trivial - it is a running sum that restarts at every
 * paycheque - so almost nothing here is about addition. What is worth testing
 * is which entry starts a new block, because every awkward case on the ledger
 * turns on that: a cheque already in the bank, a charge that never touched
 * this account, a bill that sorts ahead of the payday its window begins on.
 *
 * The last `describe` is the one that matters most. The ledger prints a
 * block's leftover a few rows above the window's own total, so the two are
 * read together whether or not anybody intends to compare them. If they ever
 * disagree the screen is self-evidently wrong, and the household stops
 * believing the rest of it - which is the thing this app has least of and can
 * least afford to spend. The property is checked against every seed on the
 * machine, including the real one when it is there.
 */
import { describe, expect, it } from "vitest";
import { chequeBlocks, type BlockEntry } from "../src/chequeBlocks.js";
import { computePayPeriods } from "../src/payPeriods.js";
import { computeTimeline } from "../src/timeline.js";
import { availableSeeds, cents, paySchedules, timelineEvents, type NamedSeed } from "./helpers/seed.js";

/** A bill, which moves money and opens nothing. */
function bill(id: string, date: string | null, amount: number): BlockEntry {
  return { id, date, deltaCents: BigInt(amount), opensBlock: false };
}

/** A cheque still to arrive, which opens a block. */
function cheque(id: string, date: string, amount: number): BlockEntry {
  return { id, date, deltaCents: BigInt(amount), opensBlock: true };
}

describe("where a block begins", () => {
  it("starts a new one at every cheque still to come", () => {
    const blocks = chequeBlocks(
      [
        cheque("pay-1", "2026-11-26", 200_000),
        bill("mortgage", "2026-11-27", -120_000),
        cheque("pay-2", "2026-12-03", 180_000),
        bill("savings", "2026-12-04", -50_000),
      ],
      null,
    );

    expect(blocks.map((block) => block.openerId)).toEqual(["pay-1", "pay-2"]);
    expect(blocks.map((block) => block.leftCents)).toEqual([80_000n, 130_000n]);
  });

  /**
   * The whole reason the window's own total is not the answer. Two cheques
   * inside one fortnight produce one number between them, and it is not a
   * number anybody can act on: it does not say whether the tight week is the
   * first or the second.
   */
  it("says something the window total cannot", () => {
    const entries = [
      cheque("pay-1", "2026-11-26", 200_000),
      bill("mortgage", "2026-11-27", -190_000),
      cheque("pay-2", "2026-12-03", 180_000),
      bill("power", "2026-12-04", -20_000),
    ];

    const blocks = chequeBlocks(entries, null);
    const window = blocks.reduce((total, block) => total + block.leftCents, 0n);

    expect(window).toBe(170_000n);
    // The fortnight looks comfortable. The first week of it is not.
    expect(blocks[0]?.leftCents).toBe(10_000n);
    expect(blocks[1]?.leftCents).toBe(160_000n);
  });

  /**
   * A cheque in the bank is history: the balance the window opens with has
   * already been past it. Opening a block on one would put a heading over
   * the settled rows and a leftover of zero underneath them.
   */
  it("is not started by a cheque that has already landed", () => {
    const blocks = chequeBlocks(
      [
        { ...cheque("pay-old", "2026-11-12", 0), opensBlock: false },
        bill("power", "2026-11-13", 0),
        cheque("pay-next", "2026-11-26", 200_000),
      ],
      { cents: 52_300n },
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("balance");
    expect(blocks[0]?.entryIds).toEqual(["pay-old", "power"]);
    // Settled rows moved nothing, so the balance walks through untouched.
    expect(blocks[0]?.leftCents).toBe(52_300n);
  });

  it("opens the first block with the balance only where the window starts today", () => {
    const entries = [bill("licence", "2026-11-21", -6_250), cheque("pay", "2026-11-26", 200_000)];

    const today = chequeBlocks(entries, { cents: 52_300n });
    expect(today[0]?.kind).toBe("balance");
    expect(today[0]?.leftCents).toBe(46_050n);

    // A later window opens on a payday, so its cheque is what opens it. Handing
    // it the balance as well would spend the same money in two windows.
    const later = chequeBlocks(entries, null);
    expect(later).toHaveLength(1);
    expect(later[0]?.kind).toBe("cheque");
    expect(later[0]?.openerId).toBe("pay");
  });

  /**
   * Possible when a bill sorts ahead of the payday its window begins on.
   * Those rows join the cheque rather than forming a block of their own: a
   * leftover of minus ninety dollars, with no cheque above it to explain
   * where the money was supposed to come from, is not an answer.
   */
  it("folds rows that sort ahead of their own cheque into it", () => {
    const blocks = chequeBlocks(
      [bill("early", "2026-11-26", -9_000), cheque("pay", "2026-11-26", 200_000)],
      null,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("cheque");
    expect(blocks[0]?.openerId).toBe("pay");
    expect(blocks[0]?.entryIds).toEqual(["early", "pay"]);
    expect(blocks[0]?.leftCents).toBe(191_000n);
  });

  it("reports a window with no cheque at all rather than dropping it", () => {
    const blocks = chequeBlocks([bill("licence", "2026-11-21", -6_250)], null);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("unopened");
    expect(blocks[0]?.openerId).toBeNull();
  });

  it("still answers for a window that holds nothing", () => {
    expect(chequeBlocks([], { cents: 52_300n })).toEqual([
      {
        kind: "balance",
        openerId: null,
        date: null,
        inCents: 52_300n,
        outCents: 0n,
        leftCents: 52_300n,
        entryIds: [],
      },
    ]);

    expect(chequeBlocks([], null)).toEqual([]);
  });
});

describe("what a block counts", () => {
  /**
   * A charge on a credit card is a real cost on a real date and moves none of
   * this account's money. It arrives here as a delta of zero and so needs no
   * rule of its own - which is the point: `timeline.ts` decided it once.
   */
  it("counts what a row did to the account, not what it cost", () => {
    const blocks = chequeBlocks(
      [
        cheque("pay", "2026-11-26", 200_000),
        { id: "visa-charge", date: "2026-11-27", deltaCents: 0n, opensBlock: false },
        bill("power", "2026-11-28", -14_250),
      ],
      null,
    );

    expect(blocks[0]?.leftCents).toBe(185_750n);
    expect(blocks[0]?.outCents).toBe(14_250n);
    // Counted in nothing, and still part of the block, so the rows on screen
    // and the figure under them cover the same ground.
    expect(blocks[0]?.entryIds).toContain("visa-charge");
  });

  it("splits arrivals from departures", () => {
    const blocks = chequeBlocks(
      [
        cheque("pay", "2026-11-26", 200_000),
        bill("refund", "2026-11-27", 3_140),
        bill("water", "2026-11-28", -12_600),
      ],
      null,
    );

    expect(blocks[0]?.inCents).toBe(203_140n);
    expect(blocks[0]?.outCents).toBe(12_600n);
    expect(blocks[0]?.leftCents).toBe(190_540n);
  });

  /** Anchored to "now", which is where the timeline puts them. */
  it("puts undated rows first", () => {
    const blocks = chequeBlocks(
      [cheque("pay", "2026-11-26", 200_000), bill("overdue", null, -4_000)],
      { cents: 52_300n },
    );

    expect(blocks[0]?.entryIds).toEqual(["overdue"]);
    expect(blocks[0]?.leftCents).toBe(48_300n);
  });

  it("keeps the engine's order within one day", () => {
    const blocks = chequeBlocks(
      [
        cheque("pay", "2026-11-26", 200_000),
        bill("second", "2026-11-27", -1_000),
        bill("first", "2026-11-27", -2_000),
      ],
      null,
    );

    expect(blocks[0]?.entryIds).toEqual(["pay", "second", "first"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The property: a block's figure and the window's figure cannot disagree      */
/* -------------------------------------------------------------------------- */

const seeds = availableSeeds();

describe.each(seeds.map((named) => [named.label, named] as const))(
  "%s",
  (_label, named: NamedSeed) => {
    const { seed } = named;
    const fixture = seed.fixture;

    const schedules = paySchedules(seed);
    const timeline = computeTimeline({
      events: timelineEvents(seed),
      startBalanceCents: cents(fixture.startBalanceCents),
      cushionCents: cents(seed.household.cushionCents),
    });
    const periods = computePayPeriods({
      timeline,
      paySchedules: schedules,
      today: fixture.today,
      periodCount: fixture.expected.payPeriods.length,
      anchorScheduleId: schedules[0]?.id,
      cushionCents: cents(seed.household.cushionCents),
    });

    it("gives every window at least one block", () => {
      for (const period of periods) {
        expect(period.blocks.length, period.label).toBeGreaterThan(0);
      }
    });

    /**
     * The one that would show on screen. The blocks are printed a few rows
     * above the band carrying `leftCents`, so a household reading down the
     * page compares them whether or not anyone meant them to.
     */
    it("has its blocks add up to the window's own left-over", () => {
      for (const period of periods) {
        const summed = period.blocks.reduce((total, block) => total + block.leftCents, 0n);
        expect(summed, period.label).toBe(period.leftCents);
      }
    });

    /** No row counted twice, none counted by nothing. */
    it("puts every row of a window in exactly one block", () => {
      for (const period of periods) {
        const placed = period.blocks.flatMap((block) => block.entryIds);
        expect(new Set(placed).size, `${period.label} has a row in two blocks`).toBe(placed.length);

        const expectedIds = [...period.rowIds, ...period.projectedPaychequeIds].sort();
        expect([...placed].sort(), period.label).toEqual(expectedIds);
      }
    });

    /**
     * A block opened by a cheque is the thing the ledger prints a figure for,
     * so the screen depends on the opener being findable among the rows the
     * same window published.
     */
    it("names an opener the window actually holds", () => {
      const known = new Set([...periods.flatMap((p) => p.rowIds), ...periods.flatMap((p) => p.projectedPaychequeIds)]);

      for (const period of periods) {
        for (const block of period.blocks) {
          if (block.kind !== "cheque") continue;
          expect(block.openerId, period.label).not.toBeNull();
          expect(known.has(block.openerId ?? ""), `${period.label}: ${block.openerId ?? ""}`).toBe(
            true,
          );
        }
      }
    });

    /**
     * Only the window that starts today opens with money already in hand.
     * Any later one opening on a balance would be counting it twice.
     */
    it("opens on the balance only in the window that starts today", () => {
      for (const period of periods) {
        const opensOnBalance = period.blocks.some((block) => block.kind === "balance");
        expect(opensOnBalance, period.label).toBe(period.isCurrentPartial);
      }
    });
  },
);
