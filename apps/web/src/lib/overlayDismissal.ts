/**
 * The four ways out of an open sheet, in one place.
 *
 * A modal has to be closable by Cancel, by Escape, by Android's Back and by a
 * tap outside it, and all four have to refuse while a save is in flight. That
 * is four behaviours, and writing them per sheet is how they drift: the
 * retirement-assumptions sheet on Net worth had the tap-outside and nothing
 * else, so Escape did nothing, Back left the screen entirely, and a tap on the
 * backdrop threw the form away while the save it had already started was
 * still running. Nothing about that is visible from the sheet's own code -
 * each missing piece is the absence of a line.
 *
 * So this is the single copy. A sheet asks for it once, spreads the two
 * handlers onto its backdrop, and gets the rest by having called it.
 *
 * ## Why `blocked` exists
 *
 * All four exits are inert while a request is in flight. Closing then does not
 * cancel the save - it just hides whether it worked, which on these screens
 * means not knowing whether an amount was recorded.
 */
import { useCallback, useEffect, useRef } from "react";
import { useBackDismiss } from "./backDismiss.js";

/** Spread onto the backdrop element. */
export interface BackdropHandlers {
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLElement>) => void;
}

export function useOverlayDismissal(
  close: () => void,
  /** A save is in flight, so every exit is inert. */
  blocked = false,
): BackdropHandlers {
  /*
   * Read through refs so the effect depends on `blocked` alone - an `onClose`
   * written inline at the call site is a new function on every render, and the
   * listener would otherwise be torn down and rebuilt each time.
   */
  const closeRef = useRef(close);
  const blockedRef = useRef(blocked);
  useEffect(() => {
    closeRef.current = close;
    blockedRef.current = blocked;
  });

  // Back closes the sheet rather than leaving the screen behind it.
  useBackDismiss(true, close, blocked);

  // Escape, as for any dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !blockedRef.current) closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Did this click's press begin on the backdrop itself?
   *
   * A `click` is dispatched on the nearest common ancestor of where the
   * pointer went down and where it came up. Select some text in the sheet,
   * drag past its edge and release, and that ancestor is the backdrop - so a
   * plain `onClick={close}` threw the form away mid-selection, losing whatever
   * had been typed. `stopPropagation` on the sheet cannot help: the sheet is
   * not in that event's path at all.
   *
   * So the press has to have started on the backdrop too. A deliberate click
   * outside still closes; a selection that merely ends outside does not.
   */
  const pressedBackdrop = useRef(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    pressedBackdrop.current = event.target === event.currentTarget;
  }, []);

  const onClick = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    const fromBackdrop = pressedBackdrop.current && event.target === event.currentTarget;
    pressedBackdrop.current = false;
    if (fromBackdrop && !blockedRef.current) closeRef.current();
  }, []);

  return { onPointerDown, onClick };
}
