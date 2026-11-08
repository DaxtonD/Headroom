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
  { to: "/", label: "Home" },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/pay-plan", label: "Pay plan" },
  { to: "/budget", label: "Budget" },
  { to: "/goals", label: "Goals" },
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

function formatTime(at: Date): string {
  return at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
