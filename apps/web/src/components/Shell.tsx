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
import { InitialBubble, type Person } from "./Badges.js";
import type { LiveStatus } from "../lib/useLiveUpdates.js";
import "./Shell.css";

export interface ShellMember extends Person {
  readonly colorFg: string;
  readonly colorBg: string;
}

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
  members,
  live,
  onSignOut,
  children,
}: {
  members: readonly ShellMember[];
  live: LiveStatus;
  onSignOut: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="shell-layout">
      <header className="shell-header">
        <p className="shell-header__wordmark">Headroom</p>

        <div className="shell-header__right">
          <ul className="shell-header__people" aria-label="Household">
            {members.map((member) => (
              <li key={member.id}>
                <InitialBubble person={member} colorFg={member.colorFg} colorBg={member.colorBg} />
              </li>
            ))}
          </ul>
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

/** A gear, drawn rather than loaded: one icon is not worth a font or a file. */
function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.4 2h-3.6l-.3 2.4a7.6 7.6 0 0 0-2.6 1.5l-2-.8L4.1 8.2l1.7 1.3a7.6 7.6 0 0 0 0 3L4.1 13.8l1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.4h3.6l.3-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatTime(at: Date): string {
  return at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
