/**
 * How tall the app header is, and whether something has scrolled behind it.
 *
 * The ledger is one long scroll with the balance at the top, which is the
 * right shape for the screen - it is read several times a day, and the first
 * thing the eye lands on has to be the figure. The cost is that the two
 * things you came to do, type in a balance and record a one-off, leave the
 * screen as soon as you look at anything. Asked for from use: keep the
 * balance and the buttons reachable all the way down.
 *
 * Both halves live here together because they are one fact. The header is
 * sticky at the top of the viewport, so anything else pinned up there has to
 * know where it ends - and that is not a number anybody can write down. It is
 * a line of text plus 44px controls plus `env(safe-area-inset-top)`, which is
 * 0 in a browser tab, something else again in an installed app, and changes
 * when the phone is turned on its side. So the shell measures it, and that
 * one measurement is what both the stylesheet and the observer below read.
 *
 * ## Why an observer and not a scroll handler
 *
 * A scroll handler runs on every frame of every flick, on the main thread.
 * `IntersectionObserver` fires twice - once going, once coming back - and
 * never while the finger is moving.
 *
 * ## Why a marker and not the element itself
 *
 * Observing the hero would mean reacting to it being *partly* out of view,
 * which is several thresholds and some arithmetic. A marker at the bottom of
 * it answers the only question being asked: has the whole thing gone? And a
 * marker never changes size, so nothing here can start the loop that watching
 * a collapsing element invites.
 *
 * ## The bug class this file shipped with twice, because it is the whole subtlety
 *
 * An observer fires only when intersection CHANGES. So the answer computed at
 * that instant is the answer until the next change - and if it is wrong there
 * is no second chance to correct it. A predicate that disagrees with the
 * observer's own test by even a pixel therefore does not produce a glitch, it
 * produces a stuck bar.
 *
 * It happened in both directions, which is what finally named the class:
 *
 *  1. `!isIntersecting && boundingClientRect.top < 0` - and the bar never
 *     appeared at all. Those halves are measured against different edges:
 *     `isIntersecting` against the root as `rootMargin` adjusted it (the
 *     header's bottom, say y=69), `top` against the raw viewport. At the one
 *     moment the callback fired the marker sat at y≈68, which has stopped
 *     intersecting and is nowhere near below 0.
 *  2. `boundingClientRect.top < rootBounds.top` - which fixed going down and
 *     broke coming back. A 1px marker starts intersecting again when its
 *     BOTTOM passes the edge, so its top is then at y≈68.4 - still less than
 *     69, so the bar stayed shown, and scrolling gently to the very top left
 *     it there, overlapping. Reported from use, in those words.
 *
 * Fix 1 also claimed `isIntersecting` "was never doing the work". That was
 * wrong, and bug 2 is what wrong looked like: it is the browser's own answer
 * to which side of the edge we are on, and it is the only part of this that
 * cannot disagree with the observer that produced it.
 *
 * So the predicate below is built to one rule: **every ambiguous case must
 * resolve to the answer a later callback can still correct.** Returning "not
 * past" while the marker is still intersecting is safe, because leaving will
 * fire. Returning "past" as it comes back was not, because nothing fires
 * afterwards. `isPastTheHeader` is exported and tested with real numbers at
 * both transitions, because the grep that guarded version 1 asserted the
 * broken expression itself and passed all the way onto a phone.
 */
import { useEffect, useState } from "react";

/**
 * The value `tokens.css` declares, for before the shell has measured.
 *
 * Only a fallback, and only a few pixels out in a browser tab: one line of
 * text, 44px controls, 12px of padding each side and the hairline under it,
 * with no safe-area inset - which is the part that cannot be guessed, and on
 * a notched phone is most of the answer.
 */
export const FALLBACK_HEADER_PX = 69;

/** What the shell last measured, and who wants telling when it changes. */
let measured: number | null = null;
const listeners = new Set<() => void>();

/**
 * Keep `--hr-header-h` in step with the real header. Returns the teardown.
 *
 * Published as a plain `69px` string on the document element, so a stylesheet
 * can use it directly, and kept here as a number as well so nothing has to
 * read a length back out of CSS and parse it.
 */
export function trackHeaderHeight(header: HTMLElement): () => void {
  const publish = (): void => {
    const { height } = header.getBoundingClientRect();
    document.documentElement.style.setProperty("--hr-header-h", `${height}px`);

    if (height === measured) return;
    measured = height;
    for (const listener of listeners) listener();
  };

  publish();

  // Without a ResizeObserver the one measurement above still stands, and the
  // only cost is a pinned bar a few pixels out after a rotation.
  if (typeof ResizeObserver === "undefined") return () => {};

  const observer = new ResizeObserver(publish);
  observer.observe(header);
  return () => observer.disconnect();
}

/**
 * Has the marker gone above the header's bottom edge?
 *
 * Pure, exported and tested, because this is the one line with real geometry
 * in it and the one line that has been wrong twice.
 *
 * Two parts, and each does a job the other cannot:
 *
 *  - **`isIntersecting` settles the direction.** It is the browser's own
 *    answer to which side of the edge the marker is on, so it cannot
 *    disagree with the observation it arrived in. Still intersecting means
 *    still on screen below the header, whatever the sub-pixel arithmetic
 *    says - and it is the half that makes coming back up correct, because
 *    the marker starts intersecting again while its top is still above the
 *    edge.
 *  - **The BOTTOM edge against the root's top** separates "above" from
 *    "below the fold", which `isIntersecting` alone cannot: a marker nobody
 *    has scrolled to yet is not intersecting either.
 *
 * The bottom edge and not the top, so this asks the same question the
 * observer asked - a marker is clear of the root exactly when its bottom has
 * passed the root's top. That also makes it independent of the marker's
 * height, which the previous version quietly depended on.
 *
 * `rootBounds` is null in a cross-origin frame, which this app is never in;
 * the fallback is the figure the margin was built from rather than 0, which
 * would be version 1 of this bug reached by another route.
 */
export function isPastTheHeader(
  entry: {
    readonly isIntersecting: boolean;
    readonly boundingClientRect: { readonly bottom: number };
    readonly rootBounds: { readonly top: number } | null;
  },
  headerPx: number,
): boolean {
  // On screen below the header. Said first, so a tie on the edge below can
  // never be read as "gone" - that is the one mistake with no way back.
  if (entry.isIntersecting) return false;

  return entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? headerPx);
}

/**
 * The header's height, re-rendering whoever asks when it changes.
 *
 * Not read once: React runs a child's effects before its parent's, so the
 * ledger can mount, observe and decide before the shell has measured
 * anything. With cached data on screen that is a real sequence, not a
 * theoretical one, and it would leave the observer built on the fallback -
 * out by the whole safe-area inset on an installed app.
 */
function useHeaderHeight(): number {
  const [height, setHeight] = useState(() => measured ?? FALLBACK_HEADER_PX);

  useEffect(() => {
    const onChange = (): void => setHeight(measured ?? FALLBACK_HEADER_PX);
    listeners.add(onChange);
    // And once now: the measurement can land between this component
    // rendering and this line, and waiting for a change that has already
    // happened would mean waiting for ever.
    onChange();
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return height;
}

/**
 * A ref to put on a marker, and whether the page has scrolled past it.
 *
 * A callback ref rather than `useRef`, because the effect has to re-run when
 * the node appears: the ledger renders a loading state first, so on the first
 * pass there is nothing to observe and a `useRef` would still be null when an
 * effect with an empty dependency list looked at it.
 */
export function useScrolledPast(): readonly [(node: HTMLElement | null) => void, boolean] {
  const [marker, setMarker] = useState<HTMLElement | null>(null);
  const [past, setPast] = useState(false);
  const headerPx = useHeaderHeight();

  useEffect(() => {
    // No observer, no pinned bar - which is the state of the app today, and
    // perfectly usable. Never a broken screen.
    if (marker === null || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        setPast(isPastTheHeader(entry, headerPx));
      },
      {
        /*
         * The viewport, with its top edge pushed down to where the header
         * ends. Without this the marker would still count as visible while it
         * sat behind the header, and the bar would arrive a header's height
         * of scrolling late - long enough to read as a glitch.
         *
         * A whole number of pixels: a screen at a non-integer text scale
         * measures fractionally, and `rootMargin` is the one place a bad
         * length throws rather than being ignored. `Math.trunc` and not the
         * rounding this codebase forbids - that rule is about money, and this
         * is a scroll offset.
         */
        rootMargin: `-${Math.trunc(headerPx)}px 0px 0px 0px`,
        threshold: 0,
      },
    );

    observer.observe(marker);
    return () => observer.disconnect();
    // Rebuilt when the header is measured or resized, so the margin is never
    // stale - including after a rotation changes the safe-area inset.
  }, [marker, headerPx]);

  return [setMarker, past];
}
