/**
 * The crop arithmetic, with real numbers.
 *
 * This file exists because of bugs 24 and 25. Both were arithmetic, both were
 * "covered" by a grep that asserted the code said what the code said, and both
 * reached a phone. There is no DOM in this suite, so the rule that came out of
 * it is: anything with numbers in it gets extracted into a pure function and
 * tested against numbers, and the rest gets a source check.
 *
 * Four numbers map a square viewport onto a source image, and the failure mode
 * is not a crash - it is a picture that comes out slightly off-centre, or a
 * sliver of blank at one edge, which nobody can diagnose by reading the code.
 *
 * The central claim is the last block: **a clamped pan means the crop is
 * always inside the image.** Everything else in `cropImage.ts` leans on it -
 * `cropRect` deliberately does no clamping of its own, because a second rule
 * that could disagree with the first is precisely what went wrong twice.
 */
import { describe, expect, it } from "vitest";
import {
  clampPan,
  coverScale,
  cropRect,
  displayedSize,
  imageOffset,
  panLimit,
  type CropView,
} from "../src/lib/cropImage.js";

/** The default view of an image: zoomed out, centred. */
function view(sourceWidth: number, sourceHeight: number, over: Partial<CropView> = {}): CropView {
  return {
    sourceWidth,
    sourceHeight,
    viewport: 280,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    ...over,
  };
}

describe("fitting the image to the square", () => {
  it("covers the viewport rather than fitting inside it", () => {
    /*
     * `max`, not `min`. `min` would fit the whole image in and leave bars at
     * two edges - a crop surface with gaps in it, which invites a crop with
     * gaps in it.
     */
    expect(coverScale(view(560, 280))).toBe(1);
    expect(coverScale(view(280, 560))).toBe(1);
    expect(coverScale(view(140, 140))).toBe(2);
  });

  it("survives a source with no size", () => {
    // An image that failed to decode should not produce NaN all the way
    // through to a canvas call.
    expect(coverScale(view(0, 0))).toBe(1);
    expect(cropRect(view(0, 0))).toEqual({ sx: 0, sy: 0, size: 0 });
  });

  it("draws a landscape image wider than the square and exactly as tall", () => {
    expect(displayedSize(view(560, 280))).toEqual({ width: 560, height: 280 });
  });
});

describe("how far it can be dragged", () => {
  it("slides sideways but not at all vertically, zoomed out and landscape", () => {
    // The axis the image only just covers has no slack, and saying it has
    // would let a gap open at the top.
    expect(panLimit(view(560, 280))).toEqual({ x: 140, y: 0 });
  });

  it("slides vertically but not sideways, zoomed out and portrait", () => {
    expect(panLimit(view(280, 560))).toEqual({ x: 0, y: 140 });
  });

  it("gains slack on both axes once zoomed in", () => {
    // A square image at 2x is 560 across inside a 280 square.
    expect(panLimit(view(280, 280, { scale: 2 }))).toEqual({ x: 140, y: 140 });
  });

  it("holds a drag inside its limits", () => {
    const dragged = clampPan(view(560, 280, { offsetX: 9999, offsetY: 9999 }));
    expect(dragged).toEqual({ offsetX: 140, offsetY: 0 });

    const other = clampPan(view(560, 280, { offsetX: -9999, offsetY: -9999 }));
    expect(other).toEqual({ offsetX: -140, offsetY: 0 });
  });

  it("leaves a drag inside the limits alone", () => {
    expect(clampPan(view(560, 280, { offsetX: 40 }))).toEqual({ offsetX: 40, offsetY: 0 });
  });
});

describe("the square of pixels that gets stored", () => {
  it("is the whole of a square image, zoomed out", () => {
    expect(cropRect(view(400, 400))).toEqual({ sx: 0, sy: 0, size: 400 });
  });

  it("is the middle of a landscape image, zoomed out", () => {
    /*
     * The default crop anybody would expect: the largest square that fits,
     * taken from the centre. 320x180 gives a 180 square starting 70 in.
     */
    expect(cropRect(view(320, 180))).toEqual({ sx: 70, sy: 0, size: 180 });
  });

  it("is the middle of a portrait image, zoomed out", () => {
    expect(cropRect(view(180, 320))).toEqual({ sx: 0, sy: 70, size: 180 });
  });

  it("takes half as much when zoomed to twice the size", () => {
    // 400 square at 2x: a 200 square from the middle.
    expect(cropRect(view(400, 400, { scale: 2 }))).toEqual({ sx: 100, sy: 100, size: 200 });
  });

  it("follows a drag, in source pixels rather than screen ones", () => {
    /*
     * The conversion that is easy to get wrong. The pan is in DISPLAYED
     * pixels, and the crop is in SOURCE pixels, so dragging 70 across a
     * 320x180 image shown at 280 high - a scale of 280/180 - moves the crop
     * by 70 / (280/180) = 45 source pixels.
     *
     * Dragging the image right shows what is further LEFT in it, so `sx` goes
     * down. Getting that sign backwards is a crop that moves the wrong way,
     * which looks like the control is broken rather than like a maths error.
     */
    const dragged = cropRect(view(320, 180, { offsetX: 70 }));
    expect(dragged.size).toBe(180);
    expect(dragged.sx).toBeCloseTo(70 - 45, 6);
  });

  it("stops at the edge of the image rather than past it", () => {
    // Dragged as far as it will go, the crop sits flush with the left edge.
    expect(cropRect(view(320, 180, { offsetX: 9999 }))).toEqual({ sx: 0, sy: 0, size: 180 });
    // And flush with the right edge the other way: 320 - 180.
    expect(cropRect(view(320, 180, { offsetX: -9999 }))).toEqual({ sx: 140, sy: 0, size: 180 });
  });

  it("puts the image's top-left at or above the square's, always", () => {
    // What `cropRect` relies on to need no clamping of its own: the image
    // overhangs the viewport on every side it can.
    for (const scale of [1, 1.5, 3]) {
      for (const offsetX of [-500, -20, 0, 20, 500]) {
        const offset = imageOffset(view(320, 180, { scale, offsetX }));
        expect(offset.left).toBeLessThanOrEqual(1e-9);
        expect(offset.top).toBeLessThanOrEqual(1e-9);
      }
    }
  });
});

describe("the property everything else leans on", () => {
  it("never crops outside the image, at any zoom or pan", () => {
    /*
     * The claim in one test. If this can be broken then `cropRect` needs a
     * clamp of its own - and two clamps that can disagree is exactly the
     * shape of the two sticky-header bugs. So it is stated here rather than
     * trusted.
     *
     * A crop that ran off the edge would draw transparent or smeared pixels
     * into the square, which on a phone reads as a corrupted image.
     */
    const shapes: readonly [number, number][] = [
      [400, 400],
      [320, 180],
      [180, 320],
      [1200, 90],
      [90, 1200],
      [4032, 3024],
      [1, 1],
    ];

    for (const [w, h] of shapes) {
      for (const scale of [1, 1.01, 1.5, 2, 3, 4]) {
        for (const offsetX of [-10_000, -137, 0, 137, 10_000]) {
          for (const offsetY of [-10_000, -137, 0, 137, 10_000]) {
            const current = view(w, h, { scale, offsetX, offsetY });
            const rect = cropRect(current);
            const where = `${w}x${h} scale ${scale} offset ${offsetX},${offsetY}`;

            expect(rect.size, where).toBeGreaterThan(0);
            // A tiny tolerance for floating point, not for being wrong.
            expect(rect.sx, where).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.sy, where).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.sx + rect.size, where).toBeLessThanOrEqual(w + 1e-9);
            expect(rect.sy + rect.size, where).toBeLessThanOrEqual(h + 1e-9);
          }
        }
      }
    }
  });

  it("crops the largest square available when zoomed out", () => {
    // Which is what "no zoom" has to mean, or the default crop throws away
    // detail for nothing.
    for (const [w, h] of [
      [400, 400],
      [320, 180],
      [180, 320],
      [4032, 3024],
    ] as const) {
      expect(cropRect(view(w, h)).size).toBeCloseTo(Math.min(w, h), 6);
    }
  });
});
