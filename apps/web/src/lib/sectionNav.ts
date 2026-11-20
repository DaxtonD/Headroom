/**
 * Getting to one of eleven sections without scrolling past the other ten.
 *
 * Asked for from use, 2026-11-20: "on the Manage screen, make tabs for each
 * section. Scrolling to find the desired section is a little cumbersome. It
 * doesn't need to be tabs, just a really easy way to navigate to them."
 *
 * ## Why a jump bar and not tabs
 *
 * Tabs would have been shorter to build and worse to use. Manage is where you
 * go to change one thing, and the things are related: an expense paid from a
 * card, the card it is paid from, the payday the whole lot hangs off. Tabs put
 * each of those behind a different tap and make it impossible to see two at
 * once. A pinned bar leaves the page exactly as it is - one scroll, nothing
 * hidden - and only adds a way to skip.
 *
 * ## Why the highlight is an observer and not a scroll handler
 *
 * Same reason as `pinnedHeader.ts`: a scroll handler runs on every frame of
 * every flick, on the main thread. An `IntersectionObserver` with a band at
 * the top of the content area fires only when a section enters or leaves it.
 *
 * The band is the strip just under the pinned things - header plus this bar -
 * down to 30% of the screen. Whatever is in that strip is what you are
 * reading. This is a far more forgiving arrangement than the ledger's pinned
 * bar, which is why there is no equivalent of that file's careful predicate: a
 * few pixels of error here moves the highlight a few pixels of scroll early,
 * and the band always holds something, so nothing can get stuck.
 */
import { useCallback, useEffect, useState } from "react";
import { useHeaderHeight } from "./pinnedHeader.js";

/**
 * How tall the jump bar is, in pixels.
 *
 * Written down rather than measured, unlike the header's height. The header
 * is a line of text plus 44px controls plus `env(safe-area-inset-top)`, which
 * genuinely cannot be known in advance; this bar is one row of chips at a
 * fixed size, and `section-nav.test.ts` holds it to the stylesheet. Being a
 * few pixels out would cost a few pixels of scroll in where the highlight
 * changes, and nothing else.
 */
export const JUMP_BAR_PX = 53;

/** How far down the screen the "what am I reading" band reaches. */
const BAND_BOTTOM_PCT = 70;

/** One jumpable section: the element's id, and what the chip says. */
export interface JumpTarget {
  readonly id: string;
  /**
   * Deliberately allowed to be shorter than the heading it jumps to -
   * "Categories" for "Budget-only categories". Eleven full headings is more
   * text than a phone's width holds, and the chips are read as a set while
   * the heading is read on its own.
   */
  readonly label: string;
}

/**
 * Which chip is lit.
 *
 * The FIRST section in document order that is inside the band, because when
 * two sections straddle it the upper one is the one being read into. When
 * nothing is in the band - the end of the page, where the last section is
 * shorter than the band is tall - whatever was lit stays lit, which is both
 * correct and the only answer that never blanks the bar.
 *
 * Pure and exported so it can be tested with real orderings; the hook below
 * is the only caller.
 */
export function chooseActive(
  order: readonly string[],
  visible: ReadonlySet<string>,
  previous: string | null,
): string | null {
  for (const id of order) {
    if (visible.has(id)) return id;
  }
  if (previous !== null && order.includes(previous)) return previous;
  return order[0] ?? null;
}

/**
 * Where the bar has to scroll sideways for the lit chip to be on screen.
 *
 * Returns `null` when the chip is already fully in view, so the common case
 * writes nothing and cannot fight a finger that is scrolling the bar by hand.
 *
 * The padding is kept on whichever side the chip came in from, so a chip
 * scrolled to never sits flush against the edge looking like it has been cut
 * off - which is the one thing a horizontal scroller must not do, because it
 * is also how it signals that there is more.
 */
export function scrollLeftFor({
  scrollLeft,
  viewWidth,
  chipLeft,
  chipWidth,
  pad = 12,
}: {
  scrollLeft: number;
  viewWidth: number;
  chipLeft: number;
  chipWidth: number;
  pad?: number;
}): number | null {
  const wanted = chipLeft - pad;
  if (wanted < scrollLeft) return Math.max(0, wanted);

  const past = chipLeft + chipWidth + pad - (scrollLeft + viewWidth);
  // Never further than the chip's own start, so a chip too wide for the strip
  // shows where its label begins rather than being scrolled until only its
  // last few letters are left. The clamp can only ever reduce the offset, and
  // the branch above has already settled that the start is not behind us.
  if (past > 0) return Math.max(0, Math.min(scrollLeft + past, wanted));

  return null;
}

/** Jump without a smooth scroll for anyone who has asked not to have one. */
function scrollBehaviour(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * The lit chip, and a way to jump.
 *
 * Sections are found by `document.getElementById` rather than by threading a
 * ref through five different components, three of which are their own
 * top-level section and one of which is written inline. The ids are already
 * needed - they are what `scroll-margin-top` is applied to - so this adds
 * nothing to carry around.
 */
export function useSectionSpy(targets: readonly JumpTarget[]): {
  readonly activeId: string | null;
  readonly jumpTo: (id: string) => void;
  readonly barRef: (node: HTMLElement | null) => void;
} {
  const ids = targets.map((target) => target.id);
  const key = ids.join("|");
  const headerPx = useHeaderHeight();

  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);
  const [bar, setBar] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;

    const order = key.split("|").filter((id) => id !== "");
    const elements = order
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return undefined;

    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        /*
         * The updater form, not `chooseActive(order, visible, activeId)`.
         * The fallback needs the answer as it is at the moment the observer
         * fires, and reading it from the closure would both capture a stale
         * one and put it in this effect's dependencies - which would rebuild
         * the observer every time the highlight moved.
         */
        setActiveId((previous) => chooseActive(order, visible, previous));
      },
      {
        // A strip under the pinned header and bar. `Math.trunc` because a
        // fractional length is the one thing `rootMargin` throws on, and this
        // is a scroll offset rather than money - the rule that forbids
        // rounding is about the latter.
        rootMargin: `-${Math.trunc(headerPx + JUMP_BAR_PX)}px 0px -${BAND_BOTTOM_PCT}% 0px`,
        threshold: 0,
      },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [key, headerPx]);

  /* Keep the lit chip on screen, without ever moving the page itself. */
  useEffect(() => {
    if (bar === null || activeId === null) return;
    const chip = bar.querySelector<HTMLElement>(`[data-jump="${CSS.escape(activeId)}"]`);
    if (chip === null) return;

    const next = scrollLeftFor({
      scrollLeft: bar.scrollLeft,
      viewWidth: bar.clientWidth,
      chipLeft: chip.offsetLeft,
      chipWidth: chip.offsetWidth,
    });
    if (next !== null) bar.scrollTo({ left: next, behavior: scrollBehaviour() });
  }, [bar, activeId]);

  const jumpTo = useCallback((id: string): void => {
    const element = document.getElementById(id);
    if (element === null) return;

    // Lit straight away rather than waiting for the observer, which does not
    // fire until the scroll has actually arrived. On a long smooth scroll
    // that is most of a second of the bar disagreeing with the tap.
    setActiveId(id);
    // `scroll-margin-top` on the section is what keeps it clear of the header
    // and the bar; see `Manage.css`.
    element.scrollIntoView({ behavior: scrollBehaviour(), block: "start" });
  }, []);

  return { activeId, jumpTo, barRef: setBar };
}
