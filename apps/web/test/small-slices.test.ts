/**
 * Thin wedges, and being able to see them.
 *
 * Reported from use on 2026-11-21: "small slices don't appear well. They look
 * like they're behind the other slices, and the thick white border is more
 * than the slice. Can we make sure they're brought to the front? Maybe zoom
 * it a bit more?"
 *
 * Both halves of that were right, and neither was a drawing-order problem in
 * the way it reads. The ring is built largest first, so the thin wedges at
 * the end of it are already painted last and already on top. What was
 * covering them was their own gap: the 2px stroke in the card colour that
 * separates one fill from the next is centred on the path, so it eats a unit
 * inward from each of the two radial edges, and a 1.6% wedge is only about
 * five units across at its inner radius. Two of those five were border.
 *
 * So three changes, and the first is the one that matters:
 *
 *  - the gap is a quarter of the wedge's narrowest crossing, capped at 2;
 *  - the chosen wedge is painted last, which is the only real depth bug -
 *    it lifts and grows out of the ring, and painted early it did both of
 *    those underneath its neighbours;
 *  - the chosen wedge reaches further out than the ring, which is the "zoom
 *    it a bit more": a five-pixel sliver lifted five pixels is still a
 *    sliver.
 *
 * The angles are untouched throughout. The angle is the only part of a pie
 * chart that is data, and nothing here may move it.
 *
 * Every amount here is invented.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlices, gapFor, paintOrder, sharePctOf, type DonutSlice } from "../src/lib/donut.js";

const TAU = Math.PI * 2;

/** The ring's own inner radius, which is where a sector is narrowest. */
const INNER = 50;

/** A wedge of a given share of the turn, starting at twelve o'clock. */
function wedge(sharePct: number, id = "w"): DonutSlice {
  return {
    id,
    name: id,
    cents: 1n,
    start: 0,
    end: (sharePct / 100) * TAU,
    slot: 0,
    members: [],
  };
}

describe("the gap between two wedges", () => {
  it("is the full 2 units wherever the wedge can afford it", () => {
    expect(gapFor(wedge(50), INNER, 2)).toBe(2);
    expect(gapFor(wedge(12), INNER, 2)).toBe(2);
    expect(gapFor(wedge(4), INNER, 2)).toBe(2);
  });

  /**
   * The promise worth holding to. A stroke of width w on a sector covers w of
   * the sector's narrowest crossing - half from each radial edge - so a
   * quarter leaves three quarters of the fill at every size. A gap exists to
   * separate two marks and must never be more of the mark than the fill is.
   */
  it("never costs a wedge more than a quarter of its narrowest crossing", () => {
    for (const sharePct of [0.1, 0.4, 0.8, 1.6, 2, 2.5, 3, 7, 25, 99]) {
      const slice = wedge(sharePct);
      const narrowest = (slice.end - slice.start) * INNER;
      expect(gapFor(slice, INNER, 2), `${String(sharePct)}% of the turn`).toBeLessThanOrEqual(
        narrowest / 4 + 1e-9,
      );
    }
  });

  /** The reported wedge: two units of five were border, and now is not. */
  it("leaves a 1.6% wedge with most of itself", () => {
    const slice = wedge(1.6);
    const narrowest = (slice.end - slice.start) * INNER;
    expect(narrowest).toBeCloseTo(5.027, 3);
    expect(gapFor(slice, INNER, 2)).toBeCloseTo(1.257, 3);
    // Three quarters of the fill survives, where two fifths of it did not.
    expect(narrowest - gapFor(slice, INNER, 2)).toBeCloseTo(3.77, 2);
  });

  /**
   * Where the cap stops binding, stated once so a change to the radii shows
   * up here rather than on a phone. A quarter of the crossing reaches 2 when
   * the crossing reaches 8 units, which at an inner radius of 50 is a sweep
   * of 0.16 radians - a hair over two and a half per cent of the turn.
   */
  it("starts narrowing at about two and a half per cent, and not before", () => {
    expect(gapFor(wedge(2.6), INNER, 2)).toBe(2);
    expect(gapFor(wedge(2.5), INNER, 2)).toBeLessThan(2);
  });

  it("gives a wedge of no width no stroke at all", () => {
    expect(gapFor({ start: 1, end: 1 }, INNER, 2)).toBe(0);
    // A wedge the tween has not opened yet, rather than a real one.
    expect(gapFor({ start: 2, end: 1 }, INNER, 2)).toBe(0);
  });

  /** Scales with the ring rather than being a number for one radius. */
  it("is measured against the radius it is given", () => {
    expect(gapFor(wedge(2), 25, 2)).toBeCloseTo(gapFor(wedge(4), 12.5, 2), 10);
  });
});

describe("what is painted on top", () => {
  const ring = buildSlices([
    { id: "mortgage", name: "Mortgage", cents: 180_000n },
    { id: "insurance", name: "Insurance", cents: 24_000n },
    { id: "water", name: "Water", cents: 6_000n },
    { id: "licence", name: "Licence", cents: 900n },
  ]);

  it("leaves the ring in its own order when nothing is chosen", () => {
    expect(paintOrder(ring, null).map((slice) => slice.id)).toEqual([
      "mortgage",
      "insurance",
      "water",
      "licence",
    ]);
  });

  /**
   * The actual depth bug. A chosen wedge lifts out of the ring and grows past
   * it; svg has no z-index, so painted in rank order a chosen MORTGAGE came
   * out from under the ring underneath the three smaller wedges.
   */
  it("moves the chosen wedge to the end, wherever it ranked", () => {
    expect(paintOrder(ring, "mortgage").map((slice) => slice.id)).toEqual([
      "insurance",
      "water",
      "licence",
      "mortgage",
    ]);
  });

  it("leaves every other wedge in the order it had", () => {
    expect(paintOrder(ring, "water").map((slice) => slice.id)).toEqual([
      "mortgage",
      "insurance",
      "licence",
      "water",
    ]);
  });

  /** A thin wedge was already last, and must not be moved twice. */
  it("is a no-op for a wedge that is last already", () => {
    expect(paintOrder(ring, "licence").map((slice) => slice.id)).toEqual([
      "mortgage",
      "insurance",
      "water",
      "licence",
    ]);
  });

  /**
   * The ring can be rebuilt underneath a selection - a figure changes, a line
   * is archived - and the id then names nothing. Drawing the ring unchanged
   * is the right answer; throwing is not.
   */
  it("is unbothered by an id that is no longer in the ring", () => {
    expect(paintOrder(ring, "gone").map((slice) => slice.id)).toEqual([
      "mortgage",
      "insurance",
      "water",
      "licence",
    ]);
  });

  it("never drops or duplicates a wedge", () => {
    for (const chosen of [null, "mortgage", "water", "gone"]) {
      const order = paintOrder(ring, chosen);
      expect(order).toHaveLength(ring.length);
      expect(new Set(order.map((slice) => slice.id)).size).toBe(ring.length);
    }
  });

  /** Reordering is for the painter. It cannot be allowed to touch a share. */
  it("changes no angle", () => {
    for (const slice of paintOrder(ring, "mortgage")) {
      const was = ring.find((other) => other.id === slice.id) as DonutSlice;
      expect(slice.start).toBe(was.start);
      expect(slice.end).toBe(was.end);
      expect(sharePctOf(slice)).toBe(sharePctOf(was));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The wiring, since there is no DOM in this suite                            */
/* -------------------------------------------------------------------------- */

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

const donutTsx = source("src/components/BudgetDonut.tsx");
const donutCss = source("src/components/BudgetDonut.css");

describe("the ring uses all three", () => {
  it("paints the chosen wedge last", () => {
    expect(donutTsx).toContain("{paintOrder(shown, selectedId).map((slice) => {");
  });

  it("works the gap out per wedge rather than declaring one width for all", () => {
    expect(donutTsx).toMatch(
      /strokeWidth: gapFor\(slice, INNER, isChosen \? CHOSEN_STROKE : GAP\)/,
    );
    // A single width in the stylesheet is what put a 2px border on a 5px
    // wedge, so there must not be one left to inherit.
    expect(donutCss).not.toMatch(/stroke-width/);
  });

  it("grows the chosen wedge outward, and only outward", () => {
    expect(donutTsx).toContain("outer: isChosen ? OUTER + GROW : OUTER,");
    // Pulling the inner radius in would make the thin end of a thin wedge
    // thinner, which is the opposite of the point.
    expect(donutTsx).toContain("inner: INNER,");
    expect(donutTsx).not.toMatch(/inner: .*INNER -/);
  });

  /**
   * The svg has to let the chosen wedge out of its box, or growing it only
   * clips it against the edge of the plot.
   */
  it("still lets a lifted wedge out of the drawing", () => {
    expect(donutCss).toMatch(/\.donut__svg\s*\{[^}]*overflow:\s*visible/);
  });
});
