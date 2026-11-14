/**
 * Opening and closing Settings.
 *
 * Settings is a screen, not a panel, so the gear in the header is a one-way
 * trip unless something sends you back - and there was nothing: no close
 * button, and a second tap on the gear did nothing at all, because a link to
 * the page you are already on is a no-op. Reported from use.
 *
 * Shared by the gear and by the button on the screen itself so the two cannot
 * disagree about where "back" is.
 *
 * Closing goes back through history rather than navigating to a fixed screen,
 * so it returns to whatever was open - the ledger scrolled to December, say,
 * rather than the top of the ledger. That only works when this app is what
 * put Settings there, which is what the location state records. Opened by a
 * reload or a shortcut straight to /settings, there is nothing behind it to
 * go back to, and going back anyway would leave the app.
 */
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

export const SETTINGS_PATH = "/settings";

/** Marks a Settings screen this app navigated to, rather than one loaded cold. */
interface SettingsState {
  readonly fromInsideTheApp?: boolean;
}

export function useSettingsRoute(): {
  /** Whether Settings is the screen being shown. */
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  /** Open it, or close it if it is already open. */
  readonly toggle: () => void;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const isOpen = location.pathname === SETTINGS_PATH;
  const cameFromInsideTheApp =
    (location.state as SettingsState | null)?.fromInsideTheApp === true;

  const openSettings = useCallback(() => {
    navigate(SETTINGS_PATH, { state: { fromInsideTheApp: true } satisfies SettingsState });
  }, [navigate]);

  const close = useCallback(() => {
    if (cameFromInsideTheApp) {
      // The same step Android's Back takes, so the two agree.
      navigate(-1);
      return;
    }
    // Nothing behind it. Replace, so Back does not come straight back here.
    navigate("/", { replace: true });
  }, [cameFromInsideTheApp, navigate]);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else openSettings();
  }, [isOpen, close, openSettings]);

  return { isOpen, open: openSettings, close, toggle };
}
