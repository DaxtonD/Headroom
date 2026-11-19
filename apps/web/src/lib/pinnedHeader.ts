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
 * which is several thresholds and some arithmetic. A zero-height marker at
 * the bottom of it answers the only question being asked: has the whole thing
 * gone? And a marker never changes size, so nothing here can start the loop
 * that watching a collapsing element invites.
 */
import { useEffect, useState } from "react";

/**
 * The value `tokens.css` declares, for before the shell has measured.
 *
 * Only a fallback, and only a few pixels out: one line of text, 44px
 * controls, 12px of padding each side and the hairline under it, with no
 * safe-area inset - which is the part that cannot be guessed.
 */
const FALLBACK_HEADER_PX = 69;

/** What the shell last measured. `null` until it has. */
let measured: number | null = null;

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
    measured = height;
    document.documentElement.style.setProperty("--hr-header-h", `${height}px`);
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
 * A ref to put on a marker, and whether the page has scrolled past it.
 *
 * "Past" means off the top, behind the header - not merely out of view. A
 * marker still below the fold has not been reached yet, and treating that as
 * past would pin the bar before the screen had been scrolled at all.
 *
 * A callback ref rather than `useRef`, because the effect has to re-run when
 * the node appears: the ledger renders a loading state first, so on the first
 * pass there is nothing to observe and a `useRef` would still be null when an
 * effect with an empty dependency list looked at it.
 */
export function useScrolledPast(): readonly [(node: HTMLElement | null) => void, boolean] {
  const [marker, setMarker] = useState<HTMLElement | null>(null);
  const [past, setPast] = useState(false);

  useEffect(() => {
    // No observer, no pinned bar - which is the state of the app today, and
    // perfectly usable. Never a broken screen.
    if (marker === null || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      {
        /*
         * The viewport, with its top edge pushed down to where the header
         * ends. Without this the marker would still count as visible while it
         * sat behind the header, and the bar would arrive a header's height of
         * scrolling late - long enough to read as a glitch.
         *
         * A whole number of pixels: a screen at a non-integer text scale
         * measures fractionally, and `rootMargin` is the one place a bad
         * length throws rather than being ignored. `Math.trunc` and not the
         * rounding this codebase forbids - that rule is about money, and this
         * is a scroll offset.
         *
         * Read once, when the observer is made. A rotation can change the
         * safe-area inset and leave this a few pixels stale until the screen
         * is next mounted, which is not worth rebuilding an observer for.
         */
        rootMargin: `-${Math.trunc(measured ?? FALLBACK_HEADER_PX)}px 0px 0px 0px`,
        threshold: 0,
      },
    );

    observer.observe(marker);
    return () => observer.disconnect();
  }, [marker]);

  return [setMarker, past];
}
