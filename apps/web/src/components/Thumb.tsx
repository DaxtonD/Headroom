/**
 * The little square beside a name.
 *
 * Asked for by the household: "it'll appear to the left of the name of the
 * account, expense or category... this tweak will really make it easy to
 * identify the item."
 *
 * ## Nothing is drawn when there is no picture
 *
 * No placeholder, no grey initial. Three reasons, in order of how much they
 * matter:
 *
 *  1. Every screen looks exactly as it does today until the household starts
 *     adding pictures, so this cannot make anything worse on the way in.
 *  2. A column of grey letters on the ledger - the screen opened several times
 *     a day - is real visual noise in exchange for nothing: the name is right
 *     there, and a letter is not identification.
 *  3. The misalignment it leaves is temporary by nature. They are adding
 *     pictures *because* they want to recognise things, so the end state is
 *     that most rows have one.
 *
 * It is the reversible direction, too: adding a placeholder later is a change
 * to this file alone. Taking a bad one away would be a change to every screen.
 *
 * ## Why `alt=""`
 *
 * It is decorative. The name it sits beside says what the thing is, in text,
 * always - so a screen reader announcing the picture as well would be reading
 * the same item twice. The one thing a picture must never be here is the only
 * way to tell two rows apart.
 */
import "./Thumb.css";

/** How big, by where it is being used. The CSS holds the actual sizes. */
export type ThumbSize = "row" | "line" | "picker";

export function Thumb({
  imageId,
  size = "row",
}: {
  readonly imageId: string | null | undefined;
  readonly size?: ThumbSize;
}): React.JSX.Element | null {
  if (imageId === null || imageId === undefined || imageId === "") return null;

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
