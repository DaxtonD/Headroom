/**
 * "Move Hydro to Dec 9 and it clears."
 *
 * Asked for on 2026-11-22, from what the household already does by hand: when
 * chequing runs low, one of them pushes a variable bill into a later pay
 * period and mentions it the next morning.
 *
 * ## What has to be true of a suggestion
 *
 * **It must be verified, not estimated.** Every candidate move is applied and
 * the whole timeline is run again; it survives only if coverage then passes
 * everywhere. A suggestion that fixes this fortnight by breaking the next one
 * is worse than no suggestion, because the person acts on it and finds out a
 * fortnight later.
 *
 * **It must simulate the move that will actually be made.** A flexible row
 * with a date of its own is ordered BY that date, so re-anchoring it leaves it
 * exactly where it was. Simulating the wrong edit would promise an outcome the
 * move cannot produce - and the figures beside it would be correct about a
 * world nobody can reach.
 *
 * **It must not claim to know due dates.** A flexible item's date is "the day
 * you plan to pay it", not a day anybody is owed, so nothing here can tell
 * whether a bill can wait. That judgment stays with the household; this only
 * answers which moves are arithmetically safe.
 *
 * ## A note on the fixtures
 *
 * Every one of these is arranged so that something is genuinely short, and the
 * first draft of this file got that wrong: four fixtures left the balance at
 * exactly zero, which with no cushion is *covered*, so four tests asserted
 * "no suggestion" against a timeline that had nothing to suggest anything for
 * and would have passed whatever the code did. Each fixture below states the
 * running balance it produces for that reason.
 */
import { describe, expect, it } from "vitest";
import { suggestMoves } from "../src/suggestMoves.js";
import { computeTimeline } from "../src/timeline.js";
import type { TimelineInput } from "../src/types.js";

function paycheque(id: string, date: string, cents: bigint): TimelineInput {
  return { id, name: "Pay", cents, kind: "paycheque", placement: "auto", date };
}

function autoBill(id: string, date: string, cents: bigint, name = id): TimelineInput {
  return { id, name, cents, kind: "bill", placement: "auto", date };
}

/** Hangs off a payday, with no date of its own: moved by re-anchoring. */
function anchored(id: string, anchorId: string, cents: bigint, name = id): TimelineInput {
  return { id, name, cents, kind: "bill", placement: "flexible", anchorId, sortIndex: 0 };
}

/** Has a day the household picked: moved by changing that day. */
function dated(id: string, date: string, cents: bigint, name = id): TimelineInput {
  return { id, name, cents, kind: "bill", placement: "flexible", date, sortIndex: 0 };
}

describe("when nothing is short", () => {
  it("suggests nothing at all", () => {
    // The common case, and why this is cheap to ask on every load: the first
    // timeline run answers it.
    const events = [
      paycheque("p1", "2026-11-26", 200_000n),
      autoBill("rent", "2026-11-27", -50_000n),
    ];

    expect(suggestMoves({ events, startBalanceCents: 100_000n })).toEqual([]);
  });
});

/*
 * 50,000 -> pay 150,000 -> Visa 90,000 -> rent **-10,000** -> pay 90,000.
 * Rent is short by 10,000, and the Visa payment is the only thing that could
 * move out of its way.
 */
const ONE_MOVE: readonly TimelineInput[] = [
  paycheque("p1", "2026-11-26", 100_000n),
  anchored("visa", "p1", -60_000n, "Visa payment"),
  autoBill("rent", "2026-11-27", -100_000n, "Rent"),
  paycheque("p2", "2026-12-10", 100_000n),
];

describe("a shortfall one move can clear", () => {
  it("names the bill to move, where to, and what it clears", () => {
    const [first] = suggestMoves({ events: ONE_MOVE, startBalanceCents: 50_000n });

    expect(first?.name).toBe("Visa payment");
    expect(first?.toDate).toBe("2026-12-10");
    expect(first?.clearsName).toBe("Rent");
    expect(first?.cents).toBe(60_000n);
  });

  it("says to re-anchor a row that has no date of its own", () => {
    // This is the edit a screen will actually make, so it is the edit that
    // was simulated.
    const [first] = suggestMoves({ events: ONE_MOVE, startBalanceCents: 50_000n });

    expect(first?.toAnchorId).toBe("p2");
  });

  it("is actually true: applying it covers everything", () => {
    /*
     * The test that makes the rest of them worth having. The suggestion is
     * applied exactly as the API would apply it, and coverage is asked again
     * from scratch rather than trusted.
     */
    const [first] = suggestMoves({ events: ONE_MOVE, startBalanceCents: 50_000n });
    if (!first) throw new Error("expected a suggestion");

    const moved = ONE_MOVE.map((event) =>
      event.id === first.eventId
        ? { ...event, anchorId: first.toAnchorId, date: undefined }
        : event,
    );
    const after = computeTimeline({ events: moved, startBalanceCents: 50_000n });

    expect(after.coverage.allCovered).toBe(true);
    // And the figure shown beside it is that timeline's, not an estimate.
    expect(after.lowest.cents).toBe(first.lowestAfterCents);
  });

  it("does not suggest moving the automatic bill itself", () => {
    // The bank chose that date. There is nothing to move.
    const names = suggestMoves({ events: ONE_MOVE, startBalanceCents: 50_000n }).map((s) => s.name);
    expect(names).not.toContain("Rent");
  });
});

/*
 * The same arithmetic, with the Visa payment on a day the household picked
 * rather than hanging off the cheque.
 */
const DATED_MOVE: readonly TimelineInput[] = [
  paycheque("p1", "2026-11-26", 100_000n),
  dated("visa", "2026-11-26", -60_000n, "Visa payment"),
  autoBill("rent", "2026-11-27", -100_000n, "Rent"),
  paycheque("p2", "2026-12-10", 100_000n),
];

/**
 * A row with a day the household picked moves the same way as any other.
 *
 * Worth its own block because the obvious reading is wrong. A flexible row is
 * ordered BY its own date when it has one, so it looks as though such a row
 * would have to be moved by changing that date - and this module was written
 * that way first. It is not how the app works: anchoring a row to a paycheque
 * **drops its date**, in `toPrismaData` on the `anchorOccurrenceId` branch,
 * because the engine refuses a row that has both.
 *
 * So there is one kind of move, and these hold the simulation to it.
 */
describe("a row that has a day the household picked", () => {
  it("is moved by anchoring it, like every other flexible row", () => {
    const [first] = suggestMoves({ events: DATED_MOVE, startBalanceCents: 50_000n });

    expect(first?.name).toBe("Visa payment");
    expect(first?.toAnchorId).toBe("p2");
    expect(first?.toDate).toBe("2026-12-10");
  });

  it("is actually true when applied the way the API applies it", () => {
    /*
     * Anchor set, date dropped - both halves. This mirrors `toPrismaData`,
     * and it is the assertion that would fail if either half of the
     * simulation were missing.
     */
    const [first] = suggestMoves({ events: DATED_MOVE, startBalanceCents: 50_000n });
    if (!first) throw new Error("expected a suggestion");

    const moved = DATED_MOVE.map((event) =>
      event.id === first.eventId
        ? { ...event, anchorId: first.toAnchorId, date: undefined }
        : event,
    );
    const after = computeTimeline({ events: moved, startBalanceCents: 50_000n });

    expect(after.coverage.allCovered).toBe(true);
    expect(after.lowest.cents).toBe(first.lowestAfterCents);
  });

  it("would be refused outright if the date were left on", () => {
    /*
     * Why dropping the date is not a detail. A row with both is not merely
     * placed oddly - the engine throws, so a simulation that kept the date
     * would have taken the whole ledger down rather than giving a wrong
     * answer quietly.
     */
    const both = DATED_MOVE.map((event) =>
      event.id === "visa" ? { ...event, anchorId: "p2" } : event,
    );

    expect(() => computeTimeline({ events: both, startBalanceCents: 50_000n })).toThrow(
      /both a date and an anchor/u,
    );
  });
});

describe("a move that would break something later", () => {
  it("is not offered", () => {
    /*
     * The whole reason each candidate is re-run rather than sized up.
     *
     * 50,000 -> pay 150,000 -> Visa 90,000 -> rent **-10,000** -> pay 90,000
     * -> insurance **-5,000**. Moving the Visa payment onto the second cheque
     * clears the rent and leaves the insurance short, so it is not an answer -
     * and it is exactly the move somebody doing this in their head would make.
     */
    const events = [
      paycheque("p1", "2026-11-26", 100_000n),
      anchored("visa", "p1", -60_000n, "Visa payment"),
      autoBill("rent", "2026-11-27", -100_000n, "Rent"),
      paycheque("p2", "2026-12-10", 100_000n),
      autoBill("insurance", "2026-12-11", -95_000n, "Insurance"),
    ];

    expect(suggestMoves({ events, startBalanceCents: 50_000n })).toEqual([]);
  });
});

describe("what it will not try to move", () => {
  it("leaves a charge on a card alone, however flexible it is", () => {
    /*
     * It never drained this account, so moving it puts nothing back. The test
     * is `deltaCents`, which is the one place that decides whether a row
     * touched the account being projected.
     *
     * 50,000 -> pay 150,000 -> groceries (nothing here) -> rent **-10,000**.
     */
    const events = [
      paycheque("p1", "2026-11-26", 100_000n),
      { ...anchored("groceries", "p1", -60_000n, "Groceries"), fromAccountId: "card" },
      autoBill("rent", "2026-11-27", -160_000n, "Rent"),
      paycheque("p2", "2026-12-10", 100_000n),
    ];

    expect(suggestMoves({ events, startBalanceCents: 50_000n })).toEqual([]);
  });

  it("leaves a settled row alone, because that money has gone", () => {
    // 50,000 -> pay 150,000 -> Visa (already gone) -> rent **-10,000**.
    const events = [
      paycheque("p1", "2026-11-26", 100_000n),
      { ...anchored("visa", "p1", -60_000n, "Visa payment"), settled: true },
      autoBill("rent", "2026-11-27", -160_000n, "Rent"),
      paycheque("p2", "2026-12-10", 100_000n),
    ];

    expect(suggestMoves({ events, startBalanceCents: 50_000n })).toEqual([]);
  });

  it("leaves money coming in alone", () => {
    // Moving money that ARRIVES before the shortfall to a later day makes it
    // worse, not better. 50,000 -> 150,000 -> 210,000 -> rent **-50,000**.
    const events = [
      paycheque("p1", "2026-11-26", 100_000n),
      anchored("refund", "p1", 60_000n, "Refund"),
      autoBill("rent", "2026-11-27", -260_000n, "Rent"),
      paycheque("p2", "2026-12-10", 100_000n),
    ];

    expect(suggestMoves({ events, startBalanceCents: 50_000n })).toEqual([]);
  });

  it("leaves a row that falls after the shortfall alone", () => {
    /*
     * It cannot put money back before the shortfall, so moving it later
     * changes nothing about the thing that was short.
     *
     * 50,000 -> pay 150,000 -> rent **-40,000** -> pay 60,000 -> Visa 0.
     */
    const events = [
      paycheque("p1", "2026-11-26", 100_000n),
      autoBill("rent", "2026-11-27", -190_000n, "Rent"),
      paycheque("p2", "2026-12-10", 100_000n),
      anchored("visa", "p2", -60_000n, "Visa payment"),
    ];

    expect(suggestMoves({ events, startBalanceCents: 50_000n })).toEqual([]);
  });
});

/*
 * Two flexible bills, either of which clears the rent on its own.
 *
 * 110,000 -> pay 210,000 -> big 130,000 -> small 70,000 -> rent **-20,000**.
 * There is a third cheque, so a further move is available and has to be
 * passed over in favour of the nearer one.
 */
const TWO_WAYS: readonly TimelineInput[] = [
  paycheque("p1", "2026-11-26", 100_000n),
  anchored("big", "p1", -80_000n, "Big one"),
  anchored("small", "p1", -60_000n, "Small one"),
  autoBill("rent", "2026-11-27", -90_000n, "Rent"),
  paycheque("p2", "2026-12-10", 100_000n),
  paycheque("p3", "2026-12-24", 100_000n),
];

describe("choosing between moves", () => {
  it("moves a bill the shortest distance that works", () => {
    // A bill that only waits until the next cheque is a smaller ask than one
    // pushed a month, so every suggestion is to the earliest payday that
    // actually clears it.
    const list = suggestMoves({ events: TWO_WAYS, startBalanceCents: 110_000n });

    expect(list).not.toHaveLength(0);
    for (const suggestion of list) {
      expect(suggestion.toDate).toBe("2026-12-10");
    }
  });

  it("offers both when both work, smallest first", () => {
    const list = suggestMoves({ events: TWO_WAYS, startBalanceCents: 110_000n });

    expect(list.map((s) => s.name)).toEqual(["Small one", "Big one"]);
    // Among moves to the same day, the small one is the easier yes.
    expect(list[0]?.cents).toBe(60_000n);
  });

  it("returns a short list rather than every possibility", () => {
    expect(suggestMoves({ events: TWO_WAYS, startBalanceCents: 110_000n, limit: 1 })).toHaveLength(
      1,
    );
  });

  it("is in the same order on every run", () => {
    // It is rendered on a screen opened several times a day; a list that
    // reshuffles is a list nobody trusts.
    const once = suggestMoves({ events: TWO_WAYS, startBalanceCents: 110_000n });
    const twice = suggestMoves({ events: TWO_WAYS, startBalanceCents: 110_000n });

    expect(once.map((s) => s.eventId)).toEqual(twice.map((s) => s.eventId));
  });
});

describe("the cushion counts", () => {
  /*
   * 100,000 -> pay 200,000 -> Visa 160,000 -> rent **10,000** -> pay 110,000.
   *
   * Ten thousand left is covered by a household that keeps no float, and
   * short for one that keeps three hundred. Same events, same balance, only
   * the cushion differs - which is the point, because coverage in this engine
   * includes the cushion and a suggestion has to clear it to that standard
   * rather than merely to zero.
   */
  const events = [
    paycheque("p1", "2026-11-26", 100_000n),
    anchored("visa", "p1", -40_000n, "Visa payment"),
    autoBill("rent", "2026-11-27", -150_000n, "Rent"),
    paycheque("p2", "2026-12-10", 100_000n),
  ];

  it("has nothing to suggest to a household that keeps no float", () => {
    expect(suggestMoves({ events, startBalanceCents: 100_000n, cushionCents: 0n })).toEqual([]);
  });

  it("clears the cushion, not just zero", () => {
    const [first] = suggestMoves({
      events,
      startBalanceCents: 100_000n,
      cushionCents: 30_000n,
    });

    expect(first?.name).toBe("Visa payment");
    expect(first?.lowestAfterCents).toBeGreaterThanOrEqual(30_000n);
  });
});
