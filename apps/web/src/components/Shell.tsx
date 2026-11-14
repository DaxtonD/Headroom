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
import { NavLink } from "react-router";
import { firstNameOf } from "../lib/people.js";
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
  you,
  live,
  onSignOut,
  children,
}: {
  /** Whoever is signed in on this phone. */
  you: { readonly name: string };
  live: LiveStatus;
  onSignOut: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="shell-layout">
      <header className="shell-header">
        <p className="shell-header__wordmark">Headroom</p>

        <div className="shell-header__right">
          {/*
            Who is signed in on this phone, not who is in the household.
            Two initials side by side answered a question nobody was asking -
            and read as a pair of avatars, so the obvious guess was that one
            of them was a button.
          */}
          <p className="shell-header__greeting">Hi {firstNameOf(you.name)}</p>
          {/*
            Settings lives here rather than in the tab bar: five tabs is
            already as many as a phone holds, and this is opened once in a
            while rather than several times a day. Sign out stays beside it,
            where it has always been.
          */}
          <NavLink
            className={({ isActive }) =>
              `shell-header__settings ${isActive ? "shell-header__settings--active" : ""}`
            }
            to="/settings"
            aria-label="Settings"
          >
            <GearIcon />
          </NavLink>
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
 * A gear, drawn rather than loaded: one icon is not worth a font or a file.
 *
 * The path is generated, not hand-written. The first one was eyeballed and
 * came out lopsided, because eight teeth placed by hand means eight chances
 * to be a degree out. These are eight identical teeth at 45 degree spacing,
 * each a tip arc at r=9.5 and a valley arc at r=6.9 joined by straight
 * flanks, so every tooth is the same shape and the whole thing is symmetric
 * about both axes by construction.
 */
function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M21.36 10.35 A9.5 9.5 0 0 1 21.36 13.65 L18.66 13.79 A6.9 6.9 0 0 1 17.98 15.45 L19.78 17.45 A9.5 9.5 0 0 1 17.45 19.78 L15.45 17.98 A6.9 6.9 0 0 1 13.79 18.66 L13.65 21.36 A9.5 9.5 0 0 1 10.35 21.36 L10.21 18.66 A6.9 6.9 0 0 1 8.55 17.98 L6.55 19.78 A9.5 9.5 0 0 1 4.22 17.45 L6.02 15.45 A6.9 6.9 0 0 1 5.34 13.79 L2.64 13.65 A9.5 9.5 0 0 1 2.64 10.35 L5.34 10.21 A6.9 6.9 0 0 1 6.02 8.55 L4.22 6.55 A9.5 9.5 0 0 1 6.55 4.22 L8.55 6.02 A6.9 6.9 0 0 1 10.21 5.34 L10.35 2.64 A9.5 9.5 0 0 1 13.65 2.64 L13.79 5.34 A6.9 6.9 0 0 1 15.45 6.02 L17.45 4.22 A9.5 9.5 0 0 1 19.78 6.55 L17.98 8.55 A6.9 6.9 0 0 1 18.66 10.21 L21.36 10.35 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function formatTime(at: Date): string {
  return at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
