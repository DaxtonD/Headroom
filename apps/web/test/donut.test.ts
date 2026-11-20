/**
 * The budget donut's arithmetic, against values.
 *
 * A chart that disagrees with the list beside it is worse than no chart, and
 * the only way to know the two agree is to check the numbers rather than look
 * at the picture. These are the numbers.
 *
 * Every amount here is invented.
 */
import { describe, expect, it } from "vitest";
import {
  arcPath,
  buildSlices,
  liftOf,
  MAX_SLICES,
  OTHER_NAME,
  pointOn,
  ringFor,
  sharePctOf,
  slotOf,
  tweenSlices,
  type DonutDatum,
} from "../src/lib/donut.js";

const TAU = Math.PI * 2;

function datum(id: string, cents: bigint, name = id): DonutDatum {
  return { id, name, cents };
}

describe("building the ring", () => {
  it("gives each wedge its share of the turn", () => {
    const slices = buildSlices([
      datum("a", 5000n),
      datum("b", 3000n),
      datum("c", 2000n),
    ]);

    expect(slices.map((slice) => slice.name)).toEqual(["a", "b", "c"]);
    expect(sharePctOf(slices[0]!)).toBeCloseTo(50, 10);
    expect(sharePctOf(slices[1]!)).toBeCloseTo(30, 10);
    expect(sharePctOf(slices[2]!)).toBeCloseTo(20, 10);
  });

  it("tiles the whole turn exactly, with no gap at the end", () => {
    // Thirds: the case where adding up each wedge's own share leaves a
    // hairline the running total does not.
    const slices = buildSlices([datum("a", 1n), datum("b", 1n), datum("c", 1n)]);

    expect(slices[0]!.start).toBe(0);
    expect(slices[2]!.end).toBeCloseTo(TAU, 12);
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i]!.start).toBe(slices[i - 1]!.end);
    }
  });

  it("orders by amount, largest first, whatever order it is given", () => {
    const slices = buildSlices([
      datum("small", 100n),
      datum("big", 900n),
      datum("middling", 500n),
    ]);

    expect(slices.map((slice) => slice.name)).toEqual(["big", "middling", "small"]);
  });

  it("breaks a tie by name, so the ring is the same twice running", () => {
    const first = buildSlices([datum("b", 100n), datum("a", 100n)]);
    const second = buildSlices([datum("a", 100n), datum("b", 100n)]);

    expect(first.map((slice) => slice.name)).toEqual(["a", "b"]);
    expect(second.map((slice) => slice.name)).toEqual(["a", "b"]);
  });

  /** A line costing nothing has no wedge; a zero-width one cannot be tapped. */
  it("drops anything that costs nothing", () => {
    const slices = buildSlices([datum("real", 100n), datum("nothing", 0n)]);

    expect(slices.map((slice) => slice.name)).toEqual(["real"]);
  });

  it("has nothing to draw when everything is zero", () => {
    expect(buildSlices([datum("a", 0n), datum("b", 0n)])).toEqual([]);
    expect(buildSlices([])).toEqual([]);
  });

  it("gives one line the whole ring", () => {
    const slices = buildSlices([datum("only", 4200n)]);

    expect(slices).toHaveLength(1);
    expect(sharePctOf(slices[0]!)).toBeCloseTo(100, 10);
  });
});

describe("folding the tail", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    datum(`line${index}`, BigInt(1200 - index * 100)),
  );

  it("never draws more wedges than there are colours", () => {
    const slices = buildSlices(many);

    expect(slices).toHaveLength(MAX_SLICES);
    expect(slices.map((slice) => slice.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("puts the whole tail in the last wedge, and keeps what is in it", () => {
    const slices = buildSlices(many);
    const other = slices[slices.length - 1]!;

    expect(other.name).toBe(OTHER_NAME);
    // Twelve lines, seven shown by name, five folded.
    expect(other.members).toHaveLength(5);
    expect(other.cents).toBe(
      other.members.reduce((sum, member) => sum + member.cents, 0n),
    );
  });

  it("folds the smallest, never the largest", () => {
    const other = buildSlices(many).at(-1)!;
    const foldedNames = other.members.map((member) => member.name);

    expect(foldedNames).toContain("line11");
    expect(foldedNames).not.toContain("line0");
  });

  it("leaves a ring that exactly fits the palette alone", () => {
    const exactly = Array.from({ length: MAX_SLICES }, (_, index) =>
      datum(`line${index}`, BigInt(100 + index)),
    );
    const slices = buildSlices(exactly);

    expect(slices).toHaveLength(MAX_SLICES);
    // No fold, so no wedge carries members.
    expect(slices.every((slice) => slice.members.length === 0)).toBe(true);
  });

  it("still adds up to the whole turn once folded", () => {
    const slices = buildSlices(many);

    expect(slices.at(-1)!.end).toBeCloseTo(TAU, 12);
  });
});

describe("where a point lands", () => {
  it("starts at twelve o'clock, not three", () => {
    const top = pointOn(50, 50, 10, 0);

    expect(top.x).toBeCloseTo(50, 10);
    expect(top.y).toBeCloseTo(40, 10);
  });

  it("runs clockwise", () => {
    const quarter = pointOn(50, 50, 10, Math.PI / 2);

    // A quarter turn clockwise from the top is the right-hand side.
    expect(quarter.x).toBeCloseTo(60, 10);
    expect(quarter.y).toBeCloseTo(50, 10);
  });
});

describe("the path for a wedge", () => {
  const base = { cx: 50, cy: 50, outer: 40, inner: 24 };

  it("draws nothing for a wedge with no width", () => {
    expect(arcPath({ ...base, start: 1, end: 1 })).toBe("");
  });

  it("closes the shape, so it can be filled and tapped", () => {
    const path = arcPath({ ...base, start: 0, end: 1 });

    expect(path.startsWith("M ")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    // Out along one edge, round the outside, in, and round the inside.
    expect(path.match(/A /g)).toHaveLength(2);
  });

  it("sets the large-arc flag past a half turn, and not before", () => {
    expect(arcPath({ ...base, start: 0, end: Math.PI * 0.9 })).toContain("0 0 1");
    expect(arcPath({ ...base, start: 0, end: Math.PI * 1.1 })).toContain("0 1 1");
  });

  /**
   * An arc whose two ends are the same point draws nothing, so a single line
   * owning the whole budget would have vanished rather than filled the ring.
   */
  it("draws a complete ring as two half turns", () => {
    const path = arcPath({ ...base, start: 0, end: TAU });

    expect(path).not.toBe("");
    expect(path.match(/A /g)).toHaveLength(4);
  });
});

describe("lifting the chosen wedge", () => {
  it("moves it along its own bisector", () => {
    // A wedge from twelve to three o'clock points at half past one.
    const lift = liftOf({ start: 0, end: Math.PI / 2 }, 10);

    expect(lift.x).toBeCloseTo(Math.SQRT1_2 * 10, 10);
    expect(lift.y).toBeCloseTo(-Math.SQRT1_2 * 10, 10);
  });

  it("lifts the top wedge straight up", () => {
    const lift = liftOf({ start: -0.2, end: 0.2 }, 6);

    expect(lift.x).toBeCloseTo(0, 10);
    expect(lift.y).toBeCloseTo(-6, 10);
  });
});

describe("morphing one ring into another", () => {
  const from = buildSlices([datum("a", 50n), datum("b", 50n)]);
  const to = buildSlices([datum("a", 75n), datum("b", 25n)]);

  it("is the old ring at nought", () => {
    const tween = tweenSlices(from, to, 0);

    expect(tween[0]!.end).toBeCloseTo(from[0]!.end, 12);
  });

  it("is the new ring at one", () => {
    const tween = tweenSlices(from, to, 1);

    expect(tween[0]!.end).toBeCloseTo(to[0]!.end, 12);
  });

  it("is between them in the middle", () => {
    const tween = tweenSlices(from, to, 0.5);

    // Half of a turn growing to three quarters is five eighths.
    expect(sharePctOf(tween[0]!)).toBeCloseTo(62.5, 8);
  });

  /**
   * The point of matching by id. Without it every wedge would be redrawn from
   * whatever happened to be in the same position, and a ring that gains one
   * line would appear to shuffle all of them.
   */
  it("keeps a line on its own wedge rather than the one in its position", () => {
    const grew = buildSlices([datum("b", 50n), datum("a", 50n), datum("c", 100n)]);
    const tween = tweenSlices(from, grew, 0.5);

    const a = tween.find((slice) => slice.id === "a")!;
    const was = from.find((slice) => slice.id === "a")!;
    const will = grew.find((slice) => slice.id === "a")!;

    expect(a.start).toBeCloseTo((was.start + will.start) / 2, 10);
  });

  it("opens a wedge that is new from a hairline, not from nowhere", () => {
    const grew = buildSlices([datum("a", 50n), datum("b", 50n), datum("c", 100n)]);
    const atStart = tweenSlices(from, grew, 0);

    const c = atStart.find((slice) => slice.id === "c")!;
    expect(c.end - c.start).toBeCloseTo(0, 12);
  });

  it("clamps, so an overshooting curve cannot leave the turn", () => {
    expect(tweenSlices(from, to, 1.4)[0]!.end).toBeCloseTo(to[0]!.end, 12);
    expect(tweenSlices(from, to, -0.4)[0]!.end).toBeCloseTo(from[0]!.end, 12);
  });
});

describe("which ring is open", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    datum(`line${index}`, BigInt(1200 - index * 100)),
  );

  it("is the top ring when nothing is drilled into", () => {
    expect(ringFor(many, null).map((slice) => slice.name)).toEqual(
      buildSlices(many).map((slice) => slice.name),
    );
  });

  it("is the folded lines once the fold is opened", () => {
    const other = buildSlices(many).at(-1)!;
    const inside = ringFor(many, other.id);

    expect(inside).toHaveLength(other.members.length);
    expect(inside.map((slice) => slice.name).sort()).toEqual(
      other.members.map((member) => member.name).sort(),
    );
  });

  it("re-shares the opened ring over the whole turn", () => {
    const other = buildSlices(many).at(-1)!;
    const inside = ringFor(many, other.id);

    // The point of drilling in: five lines that were 3% each become readable.
    expect(inside.at(-1)!.end).toBeCloseTo(TAU, 12);
    expect(sharePctOf(inside[0]!)).toBeGreaterThan(20);
  });

  /**
   * The ring can be rebuilt underneath a drill - a figure changes and what
   * was folded no longer is. Falling back to the top ring shows something
   * true; drawing nothing would look like a bug.
   */
  it("falls back to the top ring when the fold is gone", () => {
    expect(ringFor(many, "__nonsense__")).toEqual(buildSlices(many));
    // An id that exists but is a plain line, not a fold.
    expect(ringFor(many, "line0")).toEqual(buildSlices(many));
  });
});

describe("the colour a row wears", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    datum(`line${index}`, BigInt(1200 - index * 100)),
  );
  const slices = buildSlices(many);

  it("is its own wedge's, for a line with one", () => {
    expect(slotOf(slices, "line0")).toBe(0);
    expect(slotOf(slices, "line1")).toBe(1);
  });

  /** The honest answer: that is the wedge it is part of. */
  it("is the fold's, for a line inside the fold", () => {
    const other = slices.at(-1)!;
    const inside = other.members[0]!;

    expect(slotOf(slices, inside.id)).toBe(other.slot);
  });

  it("is nothing for a line that is not drawn at all", () => {
    expect(slotOf(slices, "__not-here__")).toBeNull();
  });
});

/**
 * The part of "look at it" that can be checked without eyes.
 *
 * Label collisions need a person; geometry escaping its box does not. These
 * run the real drawing numbers the component uses against a ring the size of
 * the household's own - twelve lines, several of them tiny - and assert that
 * every coordinate it emits lands where it should.
 */
describe("the drawing stays inside its box", () => {
  const BOX = 200;
  const CENTRE = BOX / 2;
  const OUTER = 92;
  const INNER = 50;

  /*
   * Twelve lines with a long thin tail, which is the shape that breaks a pie
   * chart. The amounts are invented - this file must never carry a real one
   * - but the SHAPE is the point: two lines taking most of it and six under
   * three percent each.
   */
  const twelveLines = [
    datum("one", 400_000n),
    datum("two", 300_000n),
    datum("three", 90_000n),
    datum("four", 60_000n),
    datum("five", 50_000n),
    datum("six", 40_000n),
    datum("seven", 30_000n),
    datum("eight", 20_000n),
    datum("nine", 10_000n),
    datum("ten", 7_000n),
    datum("eleven", 5_000n),
    datum("twelve", 3_000n),
  ];

  /**
   * The points a path visits.
   *
   * Only the points: a path also carries radii and the two arc flags, and an
   * earlier version of this read those as coordinates and failed on a flag
   * of 0 that was never a position at all.
   */
  function pointsIn(path: string): number[] {
    const points: number[] = [];
    const pattern =
      /[ML] (-?[\d.]+) (-?[\d.]+)|A [\d.]+ [\d.]+ \d+ \d+ \d+ (-?[\d.]+) (-?[\d.]+)/g;

    for (const match of path.matchAll(pattern)) {
      const x = match[1] ?? match[3];
      const y = match[2] ?? match[4];
      if (x !== undefined) points.push(Number(x));
      if (y !== undefined) points.push(Number(y));
    }
    return points;
  }

  it("emits a drawable path for every wedge, tiny ones included", () => {
    const slices = buildSlices(twelveLines);

    for (const slice of slices) {
      const path = arcPath({
        cx: CENTRE,
        cy: CENTRE,
        outer: OUTER,
        inner: INNER,
        start: slice.start,
        end: slice.end,
      });
      expect(path, `${slice.name} has no path`).not.toBe("");
      expect(path.endsWith("Z"), `${slice.name} is not closed`).toBe(true);
    }
  });

  it("keeps every coordinate within the outer radius", () => {
    for (const slice of buildSlices(twelveLines)) {
      const path = arcPath({
        cx: CENTRE,
        cy: CENTRE,
        outer: OUTER,
        inner: INNER,
        start: slice.start,
        end: slice.end,
      });

      const points = pointsIn(path);
      expect(points.length, `${slice.name} has no points`).toBeGreaterThan(0);

      for (const value of points) {
        expect(value, `${slice.name} emits ${value}`).toBeGreaterThanOrEqual(CENTRE - OUTER);
        expect(value, `${slice.name} emits ${value}`).toBeLessThanOrEqual(CENTRE + OUTER);
      }
    }
  });

  /**
   * The lift moves a wedge outside the viewBox by design, which is why the
   * svg does not clip. It must stay small enough that the ring still reads
   * as a ring - a wedge pushed further than the ring is thick would float
   * away from it.
   */
  it("lifts a wedge by less than the ring is thick", () => {
    const LIFT = 7;
    for (const slice of buildSlices(twelveLines)) {
      const lift = liftOf(slice, LIFT);
      expect(Math.hypot(lift.x, lift.y)).toBeCloseTo(LIFT, 9);
      expect(LIFT).toBeLessThan(OUTER - INNER);
    }
  });

  it("never overlaps two wedges, however many there are", () => {
    const slices = buildSlices(twelveLines);

    for (let i = 1; i < slices.length; i += 1) {
      // Shared edges, in order, with nothing doubled back.
      expect(slices[i]!.start).toBe(slices[i - 1]!.end);
      expect(slices[i]!.end).toBeGreaterThan(slices[i]!.start);
    }
  });
});
