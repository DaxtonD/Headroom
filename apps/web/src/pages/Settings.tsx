/**
 * Settings: how the app looks on this device.
 *
 * Separate from Manage on purpose. Manage holds household facts - the paydays,
 * the expenses, the cushion - which both people share and which change the
 * numbers. Nothing on this screen changes a single figure, and nothing on it
 * is shared: the theme and the text size are stored on this device only, so
 * one person turning the text down does not shrink the other's.
 *
 * Both choices apply on the tap rather than on a Save, because the only way to
 * judge a theme or a text size is to look at it.
 */
import { TEXT_SIZES, THEMES, useAppearance } from "../lib/appearance.js";
import { BUILD_ID, isStamped, shortBuild } from "../lib/buildId.js";
import { usePushNotifications } from "../lib/pushNotifications.js";
import { loadServerBuild, useServerBuild, useWorkerBuild } from "../lib/serverBuild.js";
import { useSettingsRoute } from "../lib/settingsRoute.js";
import "./Settings.css";

/**
 * What to say for each state.
 *
 * Five of the six are not errors, and collapsing them into "notifications
 * are off" is what produces a toggle that does nothing when pressed with no
 * explanation. "Blocked" in particular is the one this app cannot fix, so it
 * has to say where the fix is.
 */
/** "5 hours 51 minutes ahead of", or "3 minutes behind". */
function describeSkew(seconds: number): string {
  const total = Math.abs(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [
    ...(hours > 0 ? [`${String(hours)} hour${hours === 1 ? "" : "s"}`] : []),
    ...(minutes > 0 ? [`${String(minutes)} minute${minutes === 1 ? "" : "s"}`] : []),
  ];
  const span = parts.length > 0 ? parts.join(" ") : "seconds";
  return `${span} ${seconds > 0 ? "ahead of" : "behind"}`;
}

const NOTIFICATION_NOTE: Record<ReturnType<typeof usePushNotifications>["state"], string> = {
  checking: "Checking…",
  unsupported: "This browser cannot show notifications.",
  unconfigured: "Notifications are not set up on this server yet.",
  blocked:
    "Notifications are blocked for Headroom in this browser. Allow them in the browser’s own site settings, then come back.",
  off: "Get told when the other of you updates a balance, deals with something on the ledger, or buys or submits a work expense. This device only.",
  on: "On for this device. The other of you gets told what you do here, and you get told what they do — never your own.",
};

export function Settings({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const [appearance, setAppearance] = useAppearance();
  const settings = useSettingsRoute();
  const { serverBuild, clockSkewSeconds, stale, recheck } = useServerBuild();
  const push = usePushNotifications();
  const workerBuild = useWorkerBuild();

  return (
    <div className="settings">
      <header className="settings__head">
        <div className="settings__head-row">
          <h1 className="settings__title">Settings</h1>
          {/*
            The way out, said in words. The gear in the header closes this
            too, but a gear is a symbol for "open settings" everywhere else,
            so nobody tries it to leave - and there was nothing else to try.
          */}
          <button
            className="hr-button hr-button--secondary settings__close"
            type="button"
            onClick={settings.close}
          >
            Close settings
          </button>
        </div>
        <p className="settings__intro">
          How Headroom looks on this phone or computer. These are not shared, so you and anyone
          else in the household can each have your own.
        </p>
      </header>

      {/* ---------------------------------------------------------- theme ---- */}
      <section className="hr-card settings__section" aria-labelledby="settings-theme">
        <h2 className="settings__section-title" id="settings-theme">
          Theme
        </h2>
        <p className="settings__section-note">Changes as soon as you pick one.</p>

        <ul className="settings__themes">
          {THEMES.map((theme) => {
            const chosen = appearance.theme === theme.key;
            return (
              <li key={theme.key}>
                <button
                  className={`settings__theme ${chosen ? "settings__theme--chosen" : ""}`}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => setAppearance({ ...appearance, theme: theme.key })}
                >
                  <Swatch palette={theme.previews} device={theme.key === "system"} />
                  <span className="settings__theme-words">
                    <span className="settings__theme-name">
                      {theme.name}
                      {chosen ? <span className="settings__chosen-mark"> · on</span> : null}
                    </span>
                    <span className="settings__theme-note">{theme.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ------------------------------------------------------ text size ---- */}
      <section className="hr-card settings__section" aria-labelledby="settings-text">
        <h2 className="settings__section-title" id="settings-text">
          Text size
        </h2>
        <p className="settings__section-note">
          Largest is the size the app was built at. The smaller ones fit more on the screen at
          once — the sample below is the real thing, so it changes as you pick.
        </p>

        <ul className="settings__sizes">
          {TEXT_SIZES.map((size) => {
            const chosen = appearance.scale === size.scale;
            return (
              <li key={size.key}>
                <button
                  className={`settings__size ${chosen ? "settings__size--chosen" : ""}`}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => setAppearance({ ...appearance, scale: size.scale })}
                >
                  <span className="settings__size-name">
                    {size.name}
                    {chosen ? <span className="settings__chosen-mark"> · on</span> : null}
                  </span>
                  <span className="settings__size-note">{size.description}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {/*
          A sample built out of the real classes, at the real scale, so what it
          shows is what the ledger will do. A picture of some text would not
          be affected by the setting at all.
        */}
        <div className="settings__sample" aria-hidden="true">
          <p className="settings__sample-label">In chequing</p>
          <p className="settings__sample-amount hr-amount">$1,482.60</p>
          <p className="settings__sample-row">
            <span className="settings__sample-name">Mortgage</span>
            <span className="settings__sample-figure hr-amount">−$862.07</span>
          </p>
          <p className="settings__sample-meta">Comes out automatically on Fri, Nov 13</p>
        </div>
      </section>

      {/* --------------------------------------------------- notifications ---- */}
      {/*
        Per browser, and it says so.

        A subscription belongs to one browser on one device, so turning
        these on here does nothing for the other phone. Leaving that implicit
        is how somebody turns notifications "off" and keeps being buzzed.

        Permission is asked for on the button press, never on arrival. A
        prompt nobody asked for is the most reliable way to be refused, and
        "denied" is a state this app cannot undo - only the person can, in
        their browser's own settings.
      */}
      <section className="hr-card settings__section" aria-labelledby="settings-notifications">
        <h2 className="settings__section-title" id="settings-notifications">
          Notifications
        </h2>
        <p className="settings__section-note">{NOTIFICATION_NOTE[push.state]}</p>

        {push.error ? (
          <p className="hr-alert settings__section-note" role="alert">
            {push.error}
          </p>
        ) : null}

        {push.testResult ? (
          <p className="settings__section-note" role="status">
            {push.testResult}
          </p>
        ) : null}

        {push.state === "off" || push.state === "on" ? (
          <div className="settings__actions">
            <button
              className={`hr-button ${push.state === "on" ? "hr-button--secondary" : ""}`}
              type="button"
              disabled={push.busy}
              onClick={push.state === "on" ? push.turnOff : push.turnOn}
            >
              {push.busy
                ? "Working…"
                : push.state === "on"
                  ? "Turn off on this device"
                  : "Turn on for this device"}
            </button>
            {/*
              Only once they are on, and deliberately to this device rather
              than the other person's. Notifications normally go the other
              way, which makes "it does not work" impossible to test alone -
              and impossible to tell apart from "nothing happened worth
              telling you about".
            */}
            {push.state === "on" ? (
              <button
                className="hr-button hr-button--secondary"
                type="button"
                disabled={push.busy}
                onClick={push.sendTest}
              >
                Send a test
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* --------------------------------------------------------- version ---- */}
      {/*
        Which build is running, where anyone can read it.

        This is here because the question "what version are you actually on?"
        could not be answered from inside the app at all. A deployed install
        sat on an old bundle for an afternoon while the server served a new
        one, and the only way to establish that was to open the site in a
        browser that had never been used before. `/api/health` reported a
        version constant that has not changed since M0, so it was no help.

        Two values, because the interesting case is them disagreeing: what
        this app was built from, and what the server says it is serving.
      */}
      <section className="hr-card settings__section" aria-labelledby="settings-version">
        <h2 className="settings__section-title" id="settings-version">
          Version
        </h2>
        <p className="settings__section-note">
          {stale
            ? "This app is older than the server. Reload to get the current one."
            : "What this app is running, and what the server is serving."}
        </p>

        <dl className="settings__facts">
          <div>
            <dt>This app</dt>
            <dd>{isStamped(BUILD_ID) ? shortBuild(BUILD_ID) : "not a released build"}</dd>
          </div>
          <div>
            <dt>The server</dt>
            <dd>
              {serverBuild === null
                ? "could not ask"
                : isStamped(serverBuild)
                  ? shortBuild(serverBuild)
                  : "not a released build"}
            </dd>
          </div>
          {/*
            The third answer, and the one that was still being guessed at.
            The service worker is the half that receives a notification, so
            a worker older than this page means nothing arrives while every
            screen looks perfectly current.
          */}
          <div>
            <dt>Background worker</dt>
            <dd>
              {workerBuild === null
                ? "did not answer"
                : isStamped(workerBuild)
                  ? shortBuild(workerBuild)
                  : "not a released build"}
            </dd>
          </div>
        </dl>

        {/*
          Two clocks that have to agree. Found in production nearly six
          hours apart, which put every balance's date in the future and -
          far worse - moved the server's idea of *today*, which every figure
          on every screen is derived from. Nothing said so at the time.
        */}
        {clockSkewSeconds !== null && Math.abs(clockSkewSeconds) > 120 ? (
          <p className="hr-alert settings__section-note" role="alert">
            <strong>The server&rsquo;s clock is wrong.</strong> It is{" "}
            {describeSkew(clockSkewSeconds)} its own database. Dates and
            &ldquo;today&rdquo; will be off until the clock on the machine running Headroom is
            corrected.
          </p>
        ) : null}

        <div className="settings__actions">
          <button className="hr-button hr-button--secondary" type="button" onClick={recheck}>
            Check again
          </button>
          {stale ? (
            <button className="hr-button" type="button" onClick={() => void loadServerBuild()}>
              Reload
            </button>
          ) : null}
        </div>
      </section>

      {/* --------------------------------------------------------- account ---- */}
      <section className="hr-card settings__section" aria-labelledby="settings-account">
        <h2 className="settings__section-title" id="settings-account">
          This device
        </h2>
        <p className="settings__section-note">
          Signing out leaves the household data untouched. Your theme and text size stay as you
          set them.
        </p>
        <button className="hr-button hr-button--secondary" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </div>
  );
}

/**
 * A miniature of the theme: its page, a card, the hero and the accent.
 *
 * Drawn with that theme's own tokens by scoping `data-theme` to this element,
 * which is the same mechanism the whole app uses - so a swatch can never show
 * a colour the theme does not actually have.
 */
function Swatch({
  palette,
  device,
}: {
  palette: string;
  device: boolean;
}): React.JSX.Element {
  return (
    <span className="settings__swatch" data-theme={palette} aria-hidden="true">
      <span className="settings__swatch-hero" />
      <span className="settings__swatch-card" />
      <span className="settings__swatch-accent" />
      {device ? <span className="settings__swatch-split" data-theme="night" /> : null}
    </span>
  );
}
