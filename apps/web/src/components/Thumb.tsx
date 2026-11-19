/**
 * The little square beside a name.
 *
 * Asked for by the household: "it'll appear to the left of the name of the
 * account, expense or category... this tweak will really make it easy to
 * identify the item."
 *
 * ## The placeholder, and why the first version did not have one
 *
 * It was built with nothing drawn where there was no picture, on the reasoning
 * that a column of grey letters identifies nothing and every screen should
 * look unchanged until pictures start arriving.
 *
 * That was wrong about the thing that actually matters, and the household said
 * so as soon as they saw it: **"to ensure visual continuity on the ledger,
 * items with no image should still show the image placeholder."** A list where
 * some names start 36px further left than others does not read as "those ones
 * have no picture yet" - it reads as broken. The letter is not there to
 * identify anything; it is there so the column is a column.
 *
 * ## Which is why `fallback` is a prop and not a default
 *
 * The screen decides, because two places genuinely should not have one:
 *
 *  - a **paycheque** row already carries its own green mark and a tinted
 *    background, so a letter square beside that is noise competing with a
 *    signal;
 *  - the **picker** itself, where an empty square next to "Add a picture"
 *    would read as a picture that failed to load.
 *
 * ## Why `alt=""` and `aria-hidden`
 *
 * Both are decorative. The name sits beside them, in text, always - so a
 * screen reader announcing the picture or reading out "V" would be saying the
 * same item twice. A picture must never be the only way to tell two rows
 * apart.
 */
import { initialFor } from "../lib/initials.js";
import "./Thumb.css";

/** How big, by where it is being used. The CSS holds the actual sizes. */
export type ThumbSize = "row" | "line" | "picker";

export function Thumb({
  imageId,
  size = "row",
  fallback = null,
}: {
  readonly imageId: string | null | undefined;
  readonly size?: ThumbSize;
  /**
   * The name, when this should show a lettered square rather than nothing in
   * the absence of a picture. Null draws nothing at all.
   */
  readonly fallback?: string | null;
}): React.JSX.Element | null {
  const hasImage = imageId !== null && imageId !== undefined && imageId !== "";

  if (!hasImage) {
    const initial = fallback === null ? null : initialFor(fallback);
    // Nothing to draw, and nothing worth drawing: an empty square against an
    // unnamed row would be a hole rather than a placeholder.
    if (initial === null) return null;

    return (
      <span className={`thumb thumb--${size} thumb--empty`} aria-hidden="true">
        <span className="thumb__initial">{initial}</span>
      </span>
    );
  }

  return (
    <span className={`thumb thumb--${size}`}>
      <img
        className="thumb__image"
        /*
         * Content-addressed, so this URL is immutable and the browser and the
         * service worker can both keep it for ever. A re-crop produces a
         * different id rather than different bytes at the same one, which is
         * what makes that safe - see `routes/images.ts`.
         */
        src={`/api/images/${imageId}`}
        alt=""
        /*
         * Lazy, because a long ledger can hold a few dozen of these and none
         * of them is the reason the screen exists. Async decoding so a slow
         * one cannot hold up a frame of scrolling.
         */
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}
