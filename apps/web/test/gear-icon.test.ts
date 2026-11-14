/**
 * The settings gear is symmetric.
 *
 * It was drawn by hand first and came out visibly lopsided - "like a
 * hand-drawn svg that isn't symmetrical", which is exactly what it was.
 * Eight teeth placed by eye is eight chances to be a degree or a tenth of a
 * unit out, and no other kind of check can see it.
 *
 * So the path is generated, and this reads the coordinates back out of the
 * shipped icon and measures them: every tip the same distance from the
 * centre, every valley the same distance, and the teeth evenly spaced all the
 * way round. It fails if anybody nudges a number.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shell = readFileSync(
  resolve(import.meta.dirname, "..", "src", "components", "Shell.tsx"),
  "utf8",
);

const CENTRE = 12;
const TEETH = 8;
const TIP_RADIUS = 9.5;
const VALLEY_RADIUS = 6.9;
/** The path is rounded to two decimals, so half of that is the honest slack. */
const TOLERANCE = 0.006;

const path = /<path\s+d="(M21[^"]+)"/.exec(shell)?.[1];

/**
 * The points the path actually draws to, as polar coordinates about the
 * centre.
 *
 * Every command here ends in its destination `x y`, but an arc carries five
 * numbers before it - two radii and three flags - so the pairs cannot simply
 * be read off the string. Each command is taken apart and only its last two
 * numbers kept.
 */
function polarPoints(d: string): readonly { radius: number; degrees: number }[] {
  const commands = d.match(/[MLA][^MLAZ]*/g) ?? [];

  return commands.map((command) => {
    const numbers = (command.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const expected = command.startsWith("A") ? 7 : 2;
    if (numbers.length !== expected) {
      throw new Error(`"${command.trim()}" has ${numbers.length} numbers, not ${expected}`);
    }

    const x = (numbers.at(-2) as number) - CENTRE;
    const y = (numbers.at(-1) as number) - CENTRE;
    const degrees = (Math.atan2(y, x) * 180) / Math.PI;
    return { radius: Math.hypot(x, y), degrees: degrees < 0 ? degrees + 360 : degrees };
  });
}

describe("the gear", () => {
  it("is in the file", () => {
    expect(path).toBeDefined();
  });

  it("puts every point on one of two circles", () => {
    for (const point of polarPoints(path as string)) {
      const nearest =
        Math.abs(point.radius - TIP_RADIUS) < Math.abs(point.radius - VALLEY_RADIUS)
          ? TIP_RADIUS
          : VALLEY_RADIUS;
      expect(point.radius).toBeCloseTo(nearest, 2);
    }
  });

  it("has eight teeth and eight valleys", () => {
    const points = polarPoints(path as string);
    const tips = points.filter((point) => Math.abs(point.radius - TIP_RADIUS) < 0.5);
    const valleys = points.filter((point) => Math.abs(point.radius - VALLEY_RADIUS) < 0.5);
    // Two tip points per tooth, plus the opening `M` onto the first of them.
    expect(tips.length).toBe(TEETH * 2 + 1);
    // Two valley points per tooth.
    expect(valleys.length).toBe(TEETH * 2);
  });

  it("spaces the teeth evenly all the way round", () => {
    const tips = polarPoints(path as string)
      .filter((point) => Math.abs(point.radius - TIP_RADIUS) < 0.5)
      .map((point) => point.degrees)
      .sort((a, b) => a - b);

    // The midpoint of each tip arc is where a tooth points. Pairs, in order.
    const centres: number[] = [];
    for (let i = 0; i + 1 < tips.length; i += 2) {
      centres.push(((tips[i] as number) + (tips[i + 1] as number)) / 2);
    }

    const step = 360 / TEETH;
    for (let i = 1; i < centres.length; i += 1) {
      expect((centres[i] as number) - (centres[i - 1] as number)).toBeCloseTo(step, 1);
    }
  });

  it("fits inside the viewBox once it is stroked", () => {
    const strokeWidth = Number(/strokeWidth="([\d.]+)"/.exec(shell)?.[1]);
    expect(strokeWidth).toBeGreaterThan(0);
    // Half the stroke sits outside the path, and the box is 24 wide.
    expect(TIP_RADIUS + strokeWidth / 2).toBeLessThanOrEqual(CENTRE);
  });

  it("is within the two-decimal rounding it was generated at", () => {
    const radii = polarPoints(path as string)
      .filter((point) => Math.abs(point.radius - TIP_RADIUS) < 0.5)
      .map((point) => point.radius);
    const spread = Math.max(...radii) - Math.min(...radii);
    expect(spread).toBeLessThan(TOLERANCE * 2);
  });
});
