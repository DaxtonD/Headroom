/**
 * The app shell: header, offline state, and navigation
 * (HANDOFF section 7 and 16.2).
 *
 * The bottom tab bar is for phones; at 1024px and up it becomes a left nav,
 * which is the layout the brief asks for on desktop.
 *
 * When there is no connection the app says so and editing is switched off.
 * Writes are online-only on purpose: queueing an edit to money and replaying
 * it later is the failure this design exists to prevent (section 16.2 rule 2).
 */
import { useEffect, useRef } from "react";
import { NavLink } from "react-router";
import { useAppearance } from "../lib/appearance.js";
import { trackHeaderHeight } from "../lib/pinnedHeader.js";
import { useSettingsRoute } from "../lib/settingsRoute.js";
import type { LiveStatus } from "../lib/useLiveUpdates.js";
import "./Shell.css";

const TABS = [
  // The balance, every event with its running balance, and the per-cheque
  // subtotals. This was Home, Upcoming and Pay plan until they merged.
  { to: "/", label: "Ledger" },
  // Months with a third paycheque or a third mortgage payment. Needs only the
  // schedules, so it is accurate far further out than the timeline.
  { to: "/year", label: "Year" },
  { to: "/budget", label: "Budget" },
  // The one real savings account, what it is earmarked for, and what a lump
  // sum takes off the mortgage.
  { to: "/savings", label: "Savings" },
  // Where the household is set up and kept current.
  { to: "/manage", label: "Manage" },
] as const;

export function Shell({
  live,
  onSignOut,
  activityOpen,
  onToggleActivity,
  children,
}: {
  live: LiveStatus;
  onSignOut: () => void;
  /** The activity panel is open, so the button reads as pressed. */
  activityOpen: boolean;
  onToggleActivity: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const settings = useSettingsRoute();

  /*
   * The compact ledger, switched from the header.
   *
   * Asked for here rather than in Settings on 2026-11-21: "move the compact
   * view button to the app header." It is a way of looking at the screen you
   * are already on, so it belongs where you can see what it does to it -
   * Settings would mean leaving the ledger to change how the ledger looks and
   * coming back to find out.
   *
   * The choice is stored against the person, so it survives the browser being
   * cleared; see `preferences.ts`.
   */
  const [appearance, setAppearance] = useAppearance();
  const compact = appearance.density === "compact";

  /*
   * Publish the header's own height, so a screen can pin something directly
   * below it - the ledger's balance line does. `pinnedHeader.ts` says why it
   * has to be measured rather than written down, and owns the measuring; this
   * only hands it the element and tidies up after.
   */
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return undefined;
    return trackHeaderHeight(header);
  }, []);

  return (
    <div className="shell-layout">
      <header className="shell-header" ref={headerRef}>
        <p className="shell-header__wordmark">Headroom</p>

        <div className="shell-header__right">
          {/*
            "Hi <name>" was here until 2026-11-21, when it was dropped on
            request to make room for the button below. It answered a question
            nobody was asking: there are two people, both of them know which
            of them is holding the phone, and the header is the narrowest
            space in the app.
          */}
          {/*
            Comfortable or compact rows. The glyph draws what you will get -
            three rows or five - because the one thing a density toggle must
            not be is a mystery icon that rearranges the screen.
          */}
          <button
            className={`shell-header__settings ${
              compact ? "shell-header__settings--active" : ""
            }`}
            type="button"
            aria-pressed={compact}
            aria-label={compact ? "Comfortable rows" : "Compact rows"}
            onClick={() =>
              setAppearance({ ...appearance, density: compact ? "comfortable" : "compact" })
            }
          >
            <RowsIcon dense={compact} />
          </button>
          {/*
            Settings lives here rather than in the tab bar: five tabs is
            already as many as a phone holds, and this is opened once in a
            while rather than several times a day. Sign out stays beside it,
            where it has always been.

            A button rather than a link, because it is a toggle: a second tap
            closes Settings and goes back to what was open. As a link it was
            a one-way trip, since a link to the page you are already on does
            nothing at all.
          */}
          {/*
            Activity sits next to Settings for the same reason Settings is
            here: the five tabs are as many as a phone holds, and this is
            read now and then rather than several times a day. A toggle, so
            a second tap closes it and leaves you where you were.
          */}
          <button
            className={`shell-header__settings ${
              activityOpen ? "shell-header__settings--active" : ""
            }`}
            type="button"
            aria-pressed={activityOpen}
            aria-label={activityOpen ? "Close activity" : "Activity"}
            onClick={onToggleActivity}
          >
            <ActivityIcon />
          </button>
          <button
            className={`shell-header__settings ${
              settings.isOpen ? "shell-header__settings--active" : ""
            }`}
            type="button"
            aria-pressed={settings.isOpen}
            aria-label={settings.isOpen ? "Close settings" : "Settings"}
            onClick={settings.toggle}
          >
            <GearIcon />
          </button>
          <button className="shell-header__signout" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {!live.online ? (
        <p className="shell-offline" role="status">
          <strong>Offline.</strong> These are the last numbers Headroom had
          {live.lastSyncedAt ? `, as of ${formatTime(live.lastSyncedAt)}` : ""}. Saving is paused
          until you are back on.
        </p>
      ) : null}

      <nav className="shell-nav" aria-label="Sections">
        <ul className="shell-nav__list">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink
                className={({ isActive }) => `shell-nav__link ${isActive ? "shell-nav__link--active" : ""}`}
                to={tab.to}
                end={tab.to === "/"}
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="shell-main">{children}</main>
    </div>
  );
}

/**
 * Comfortable or compact: a framed box with rows in it.
 *
 * Drawn here rather than taken from Lucide, which is the opposite of the
 * decision made for the gear beside it - and for the opposite reason. A gear
 * is a shape everybody recognises and there is nothing to gain by having our
 * own slightly wrong one. This is not a standard icon at all: it has to say
 * "this many rows", which means the number of lines is the content, not the
 * styling. Three evenly spaced lines in a rounded rectangle has no geometry
 * to get subtly wrong.
 *
 * `dense` draws what the ledger looks like NOW, so the button shows its state
 * rather than its effect. The label says the effect, which is the half a
 * screen reader needs.
 */
function RowsIcon({ dense }: { dense: boolean }): React.JSX.Element {
  // Evenly spaced inside the frame: two dividers make three rows, four make
  // five. Computed rather than written out so they cannot drift apart.
  const rows = dense ? 5 : 3;
  const top = 4;
  const height = 16;
  const dividers = Array.from({ length: rows - 1 }, (_unused, index) =>
    top + (height * (index + 1)) / rows,
  );

  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y={top} width="18" height={height} rx="2.5" />
      {dividers.map((at) => (
        <path d={`M3 ${at.toFixed(2)}h18`} key={at} />
      ))}
    </svg>
  );
}

/**
 * Activity: Lucide's `history` icon, inlined.
 *
 * A clock with an arrow going back round it, which is as close to "what has
 * happened" as a 22-pixel glyph gets. Chosen over a list or a bell: a list
 * says nothing about time, and a bell means notifications, which is a
 * different thing in this app and now a real setting of its own.
 *
 * Taken verbatim from lucide-static 0.456.0, ISC - see
 * `THIRD-PARTY-NOTICES.md`, same as the gear below it.
 */
function ActivityIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

/**
 * The settings gear: Lucide's `settings` icon, inlined.
 *
 * Standard rather than drawn here, which was the problem with the one before
 * it - eight teeth placed by eye, and visibly lopsided. A gear is a shape
 * everybody already recognises, so there is nothing to gain by having our own
 * and a real cost to getting it slightly wrong.
 *
 * Inlined rather than installed: one icon is not worth a dependency, a font
 * or a second request on a phone, and an icon that arrives separately is an
 * icon that can be missing while the rest of the header is there.
 *
 * Lucide is ISC, which asks only that its notice travel with it; see
 * `THIRD-PARTY-NOTICES.md`. Font Awesome Free would have been the other
 * obvious choice, and its icons are CC BY 4.0 - an attribution requirement on
 * anything that ships them, which is not worth taking on for a gear.
 *
 * Taken verbatim from lucide-static 0.456.0, including its stroke width and
 * round joins. Changing any of it means this is no longer the icon it says
 * it is.
 */
function GearIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function formatTime(at: Date): string {
  return at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
