/**
 * Bringing one row into view under whatever is pinned above it.
 *
 * Asked for 2026-11-21: "when a pie is selected, scroll the matching item
 * into view." Tapping a wedge puts that line's figures in the middle of the
 * ring and highlights its row in the list - and on a section with a dozen
 * lines the highlighted row is usually somewhere off the bottom of the
 * screen, so the half of the answer that is a real figure beside a real name
 * was being given to nobody.
 *
 * Pure, and in its own file, for the same reason `scrollLeftFor` in
 * `sectionNav.ts` is: the arithmetic of "is this already visible, and if not
 * how far" is the part that goes wrong, and it is the part that can be
 * checked with values. The DOM reading and the scrolling itself are two lines
 * at the call site.
 */

/**
 * Where the page should scroll to put an element in view, or null if it
 * already is.
 *
 * Null is the important half. A list row that is already on screen must not
 * move: the ring is pinned above the list and the list is operated by tapping
 * it, so a page that re-centres itself on every tap takes the row out from
 * under the finger that is using it.
 *
 * `obscuredTop` is how much of the top of the viewport something else is
 * sitting over - the app header plus the chart dock on Budget. Scrolling an
 * element to the top of the *viewport* would park it neatly behind both.
 */
export function revealTopFor({
  scrollY,
  elementTop,
  elementHeight,
  viewHeight,
  obscuredTop,
  pad = 8,
}: {
  /** The page's current scroll offset. */
  readonly scrollY: number;
  /** The element's top, relative to the viewport, as a rect reports it. */
  readonly elementTop: number;
  readonly elementHeight: number;
  readonly viewHeight: number;
  /** How many pixels at the top of the viewport are covered by something. */
  readonly obscuredTop: number;
  /** A little air, so a revealed row never sits flush against an edge. */
  readonly pad?: number;
}): number | null {
  /** Where the element would have to go to sit just below what is pinned. */
  const toTheTop = Math.max(0, scrollY + elementTop - obscuredTop - pad);

  // Hidden behind the pinned things, or above the top of the page. The only
  // case that is true whatever the element's height.
  if (elementTop < obscuredTop + pad) return toTheTop;

  /** The strip of screen that is actually free to show something in. */
  const band = viewHeight - obscuredTop - pad * 2;

  /*
   * Taller than that strip, with its start already visible: leave it alone.
   *
   * This is the branch that keeps the whole thing honest. Without it a tall
   * element - a whole section, rather than one of its rows - would always
   * have some of it below the fold, so "bring it into view" would always
   * scroll, and a page that scrolls on every tap is worse than one that
   * never does.
   */
  if (elementHeight > band) return null;

  // Off the bottom. Scrolled up by just enough, rather than to the top: a row
  // two lines below the fold should not send the page halfway down the
  // section, which reads as having jumped somewhere else entirely.
  const below = elementTop + elementHeight + pad - viewHeight;
  if (below > 0) return scrollY + below;

  return null;
}

/** Jump without a smooth scroll for anyone who has asked not to have one. */
export function scrollBehaviour(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Scroll an element into view below `obscuredTop` pixels of pinned furniture.
 *
 * Does nothing at all when it is already in view, which is most taps.
 */
export function revealElement(element: HTMLElement, obscuredTop: number): void {
  const rect = element.getBoundingClientRect();
  const top = revealTopFor({
    scrollY: window.scrollY,
    elementTop: rect.top,
    elementHeight: rect.height,
    viewHeight: window.innerHeight,
    obscuredTop,
  });
  if (top === null) return;

  window.scrollTo({ top, behavior: scrollBehaviour() });
}
