/**
 * Android's Back button closes what is open, instead of leaving the screen.
 *
 * On a phone, Back is the universal "undo this step". In an installed PWA
 * there is no other way out of a modal except its own Cancel button, so a
 * form opened over the Manage screen that answers Back by navigating to the
 * ledger loses whatever was being typed and throws away the screen as well.
 * Reported from use, in those words.
 *
 * The fix is the usual one: while something is open, it owns a history entry
 * of its own. Back pops that entry, the thing closes, and the page underneath
 * has not moved. The URL never changes - this is one step in the stack, not a
 * route - so a reload, a share or an installed shortcut all still land on a
 * real screen rather than on a modal that cannot be reconstructed.
 *
 * Closing any other way (Cancel, Save, Escape, a tap on the backdrop) has to
 * take that entry back out again, or Back would need pressing twice.
 */
import { useEffect, useRef } from "react";

/** Marks the entries this hook pushes, so it never pops anybody else's. */
const MARKER = "headroomOverlay";

function isOurs(state: unknown): boolean {
  return typeof state === "object" && state !== null && MARKER in state;
}

function pushOverlayEntry(): void {
  window.history.pushState({ [MARKER]: true }, "");
}

export function useBackDismiss(
  /** Whether anything is open to dismiss. */
  active: boolean,
  close: () => void,
  /**
   * Swallow Back instead of closing - for a save already in flight, which
   * Escape and the backdrop refuse to interrupt for the same reason.
   */
  blocked = false,
): void {
  /*
   * Both of these are read through a ref so the effect below depends on
   * `active` alone.
   *
   * It would otherwise re-run whenever the caller re-rendered, because an
   * `onClose` written inline is a new function every time - and each re-run
   * means a `history.back()` and a `pushState` racing each other, several
   * times a second, over the entry the whole thing depends on.
   */
  const closeRef = useRef(close);
  const blockedRef = useRef(blocked);
  useEffect(() => {
    closeRef.current = close;
    blockedRef.current = blocked;
  });

  useEffect(() => {
    if (!active) return undefined;

    pushOverlayEntry();

    let poppedByBack = false;
    const onPopState = (): void => {
      // Mid-save: put the entry straight back and do nothing, so Back is
      // inert rather than hiding the outcome of a request in flight.
      if (blockedRef.current) {
        pushOverlayEntry();
        return;
      }
      poppedByBack = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      if (poppedByBack) return;

      /*
       * Closed from inside the app, so the entry pushed above is still there
       * and has to go. Only when it is still the current one: if a route
       * change is what unmounted this, the router has already pushed its own
       * entry on top, and going back would undo the navigation the person
       * just asked for. Leaving a spare entry behind is the lesser fault, and
       * it costs one extra Back press at worst.
       */
      if (isOurs(window.history.state)) window.history.back();
    };
  }, [active]);
}
