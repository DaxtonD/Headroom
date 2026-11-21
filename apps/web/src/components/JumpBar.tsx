/**
 * A pinned strip of chips that jumps to a section of the page it is on.
 *
 * Built for Manage on 2026-11-20 - eleven sections and no way past them - and
 * asked for again the same day for the ledger's pay periods: "you just
 * implemented amazing inline chips on the manage screen to help navigate it.
 * Let's do the same thing on the ledger to navigate the weeks."
 *
 * One component rather than two, because it is one control. The alternative
 * is what `routing.ts` was written to end: three screens answering the same
 * question inline, and one of them answering it wrongly.
 *
 * ## What belongs here and what does not
 *
 * The look, the markup and the accessibility are here. **Where it sticks is
 * not**, because the two screens pin it to different things: Manage hangs it
 * straight off the app header, and the ledger has to clear the balance line
 * that slides in over the top once the hero has gone. So each page passes a
 * class of its own and owns that one declaration.
 *
 * ## Not a tablist
 *
 * Nothing here is a tab, because nothing is hidden. Each chip scrolls the
 * page to a heading that was always on it, so `aria-current="location"` is
 * what marks the one you are in; `aria-selected` would be claiming a tab
 * panel that does not exist.
 */
import type { JumpTarget } from "../lib/sectionNav.js";
import "./JumpBar.css";

export function JumpBar({
  targets,
  activeId,
  onJump,
  barRef,
  label,
  className = "",
}: {
  readonly targets: readonly JumpTarget[];
  readonly activeId: string | null;
  readonly onJump: (id: string) => void;
  /** From `useSectionSpy`, so the lit chip can be kept on screen. */
  readonly barRef: (node: HTMLElement | null) => void;
  /** What this bar navigates, for anyone who cannot see it. */
  readonly label: string;
  /** The page's own class, which is where it sticks. */
  readonly className?: string;
}): React.JSX.Element {
  return (
    <nav className={`jump-bar ${className}`.trim()} aria-label={label}>
      <ul className="jump-bar__list" ref={barRef}>
        {targets.map((target) => (
          <li key={target.id}>
            <button
              className={`jump-bar__chip${
                target.id === activeId ? " jump-bar__chip--here" : ""
              }`}
              type="button"
              data-jump={target.id}
              aria-current={target.id === activeId ? "location" : undefined}
              onClick={() => onJump(target.id)}
            >
              {target.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
