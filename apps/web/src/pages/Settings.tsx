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
import "./Settings.css";

export function Settings({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const [appearance, setAppearance] = useAppearance();

  return (
    <div className="settings">
      <header className="settings__head">
        <h1 className="settings__title">Settings</h1>
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
