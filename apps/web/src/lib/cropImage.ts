/**
 * Cropping a picture to a square: the arithmetic, and the encode.
 *
 * The household asked to be able to crop and zoom rather than have the app
 * decide, which is the right call - a logo and a photograph want opposite
 * treatment, and only the person looking at it knows which this is.
 *
 * ## Why the arithmetic is a pure function
 *
 * Because bugs 24 and 25 were arithmetic hidden behind a grep that asserted
 * the code said what the code said. There is no DOM in the web test suite, so
 * anything with numbers in it has to be extracted to be testable at all -
 * and this is four numbers mapping a viewport onto a source image, which is
 * exactly the shape of thing that is subtly wrong in a way nobody notices
 * until a picture comes out off-centre.
 *
 * ## The model
 *
 * One square viewport of side `V`. A source image `W x H`. Two controls: a
 * zoom `scale` and a pan `offsetX/offsetY` in displayed pixels from centred.
 *
 * `scale` is relative to the image just covering the viewport, so `scale = 1`
 * is "as far out as it goes" and there is never a gap at the edges. That is
 * the one decision that makes everything else fall out: with the pan clamped
 * so the viewport stays covered, the crop rectangle is *always* inside the
 * source image, and `cropRect` needs no clamping of its own. The tests state
 * that as a property rather than trusting it.
 *
 * At `scale = 1` the crop is the largest square that fits in the image -
 * `min(W, H)` on a side - which is what a sensible default crop means.
 */

/** The viewport and the two controls, as the picker holds them. */
export interface CropView {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** The side of the square crop surface, in CSS pixels. */
  readonly viewport: number;
  /** 1 is "fully zoomed out", where the image just covers the viewport. */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** A square of source pixels, for `drawImage`. */
export interface CropRect {
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
}

/** How far out the zoom slider goes. Four times is plenty for an icon. */
export const MAX_SCALE = 4;

/**
 * The side of the stored square, in pixels.
 *
 * 256 for a square drawn at up to 64 CSS pixels on a 3x screen, with room to
 * grow. Larger would cost bytes in the database - which is also the backup -
 * for detail nothing displays.
 */
export const OUTPUT_EDGE = 256;

/**
 * The most the picker will send.
 *
 * The server's own limit is the same number, in `apps/api/src/lib/images.ts`,
 * and it is the one that decides - this is here so the picker can step its
 * quality down and stay well under rather than find out by being refused. Two
 * copies of a number, but two different kinds of number: a target and a bound.
 */
export const MAX_UPLOAD_BYTES = 48 * 1024;

/** Tried in order until one fits. The first is what nearly every crop uses. */
export const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.45] as const;

/**
 * Negative zero, turned back into zero.
 *
 * `-left / base` is `-0` whenever the image sits flush against an edge, which
 * is the common case rather than a rare one. It behaves as zero everywhere it
 * is used, but it is not zero to anything comparing values, so canonical
 * output is worth one line.
 */
function zeroed(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * The scale at which the image exactly covers the viewport.
 *
 * `max` and not `min`: `min` would fit the whole image inside the square and
 * leave bars at two edges, and a crop surface with gaps in it invites a crop
 * with gaps in it.
 */
export function coverScale(view: {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly viewport: number;
}): number {
  if (view.sourceWidth <= 0 || view.sourceHeight <= 0) return 1;
  return Math.max(view.viewport / view.sourceWidth, view.viewport / view.sourceHeight);
}

/** How big the image is drawn, at this zoom. */
export function displayedSize(view: CropView): { readonly width: number; readonly height: number } {
  const base = coverScale(view) * view.scale;
  return { width: view.sourceWidth * base, height: view.sourceHeight * base };
}

/**
 * How far the image may be dragged before a gap would show.
 *
 * Zero on an axis the image only just covers, which is correct: a landscape
 * photo zoomed all the way out can slide sideways and not at all vertically.
 */
export function panLimit(view: CropView): { readonly x: number; readonly y: number } {
  const { width, height } = displayedSize(view);
  return {
    x: Math.max(0, (width - view.viewport) / 2),
    y: Math.max(0, (height - view.viewport) / 2),
  };
}

/** The pan, held inside its limits. The only place that clamping happens. */
export function clampPan(view: CropView): {
  readonly offsetX: number;
  readonly offsetY: number;
} {
  const limit = panLimit(view);
  return {
    offsetX: zeroed(Math.min(limit.x, Math.max(-limit.x, view.offsetX))),
    offsetY: zeroed(Math.min(limit.y, Math.max(-limit.y, view.offsetY))),
  };
}

/**
 * Where the image's top-left corner sits inside the viewport, for CSS.
 *
 * Always zero or negative once the pan is clamped - the image overhangs the
 * square on every side it can - which is the same fact `cropRect` relies on.
 */
export function imageOffset(view: CropView): { readonly left: number; readonly top: number } {
  const { width, height } = displayedSize(view);
  const { offsetX, offsetY } = clampPan(view);
  return {
    left: (view.viewport - width) / 2 + offsetX,
    top: (view.viewport - height) / 2 + offsetY,
  };
}

/**
 * The square of source pixels the viewport is showing.
 *
 * No clamping here on purpose. `clampPan` has already guaranteed the viewport
 * is covered, and covered means this rectangle is inside the image - so a
 * second clamp here would be a second rule that could disagree with the
 * first, which is how the two sticky-header bugs happened.
 */
export function cropRect(view: CropView): CropRect {
  /*
   * A source with no size has nothing to crop.
   *
   * Guarded on the source and not on the scale, which is where this check was
   * first written and where it did nothing: `coverScale` already answers 1 for
   * a degenerate image, so the scale is never zero and a 0x0 source produced a
   * rectangle at -140 with a side of 280. Not a crash - a `drawImage` call
   * that quietly draws nothing recognisable. A picture that failed to decode
   * is the way in.
   */
  if (view.sourceWidth <= 0 || view.sourceHeight <= 0) return { sx: 0, sy: 0, size: 0 };

  const base = coverScale(view) * view.scale;
  if (base <= 0) return { sx: 0, sy: 0, size: 0 };

  const { left, top } = imageOffset(view);
  return {
    sx: zeroed(-left / base),
    sy: zeroed(-top / base),
    size: view.viewport / base,
  };
}

/** Thrown when the browser cannot produce a WebP, so the message can say so. */
export class WebpUnsupportedError extends Error {
  constructor() {
    super(
      "This browser cannot save pictures in the format Headroom stores. Try adding it from another phone or browser.",
    );
    this.name = "WebpUnsupportedError";
  }
}

/** Thrown when even the lowest quality will not fit, so the UI can say so. */
export class ImageTooBigError extends Error {
  constructor() {
    super("That picture is too detailed to store. Try zooming in on a smaller part of it.");
    this.name = "ImageTooBigError";
  }
}

/**
 * Draw the crop and encode it, returning base64 ready for `/api/images`.
 *
 * Quality is stepped down until it fits. The first step is what nearly every
 * crop uses; the rest are for a busy photograph, where detail nothing can see
 * at 48 pixels would otherwise cost real bytes in the household's database and
 * in every backup of it.
 *
 * `toDataURL` rather than `toBlob` plus a reader: the route takes base64, so
 * this is the shorter path to it and there is no intermediate object URL - which
 * matters, because the Content-Security-Policy allows `data:` images and not
 * `blob:` ones.
 *
 * A browser that cannot encode WebP silently returns a PNG instead, which the
 * server would then refuse with a message about the file being wrong. So the
 * prefix is checked, and the failure is named here where it can be explained.
 */
export function encodeCrop(
  source: CanvasImageSource,
  view: CropView,
  edge = OUTPUT_EDGE,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;

  const context = canvas.getContext("2d");
  if (!context) throw new WebpUnsupportedError();

  // Smooth on the way down, which is always the direction here.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const rect = cropRect(view);
  context.drawImage(source, rect.sx, rect.sy, rect.size, rect.size, 0, 0, edge, edge);

  for (const quality of QUALITY_STEPS) {
    const url = canvas.toDataURL("image/webp", quality);
    if (!url.startsWith("data:image/webp")) throw new WebpUnsupportedError();

    const base64 = url.slice(url.indexOf(",") + 1);
    // Base64 carries 3 bytes in every 4 characters, padding aside.
    if (Math.ceil((base64.length * 3) / 4) <= MAX_UPLOAD_BYTES) return base64;
  }

  throw new ImageTooBigError();
}
