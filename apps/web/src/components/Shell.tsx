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
  const settings = useSettingsRoute();

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

            A button rather than a link, because it is a toggle: a second tap
            closes Settings and goes back to what was open. As a link it was
            a one-way trip, since a link to the page you are already on does
            nothing at all.
          */}
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
