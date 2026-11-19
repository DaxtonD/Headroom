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
 * ## The bug this file shipped with, because it is the whole subtlety
 *
 * The first version asked `!isIntersecting && boundingClientRect.top < 0`,
 * and the bar never appeared once.
 *
 * Those two halves are measured against different edges. `isIntersecting` is
 * against the root as `rootMargin` has adjusted it - the header's bottom, say
 * y=69 - while `boundingClientRect.top` is against the raw viewport. So at
 * the one moment the callback fires, the marker is at y≈68: it has stopped
 * intersecting, and 68 is nowhere near below 0. And because an observer only
 * fires when intersection CHANGES, no later callback ever came to correct it.
 * Scrolling on produced nothing at all.
 *
 * So the comparison is against the root's own top edge, which is the line
 * that decided the callback in the first place. `isPastTheHeader` is exported
 * and tested with real numbers, because the grep that was guarding this
 * asserted the broken expression itself and passed all the way to a phone.
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
 * in it and the one line that was wrong. `rootBounds.top` is where
 * `rootMargin` put the root's top edge - the header's bottom - and it is the
 * same line the observer used to decide to call us, so the two agree by
 * construction.
 *
 * Note what is NOT here: a check on `isIntersecting`. It is not needed and it
 * was half of the original mistake. A marker still below the fold is not
 * intersecting either, and this returns false for it because its `top` is a
 * large positive number - well below nothing.
 *
 * `rootBounds` is null in a cross-origin frame, which this app is never in;
 * the fallback is the same figure the margin was built from rather than 0,
 * which would quietly reintroduce the original bug.
 */
export function isPastTheHeader(
  entry: {
    readonly boundingClientRect: { readonly top: number };
    readonly rootBounds: { readonly top: number } | null;
  },
  headerPx: number,
): boolean {
  return entry.boundingClientRect.top < (entry.rootBounds?.top ?? headerPx);
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
