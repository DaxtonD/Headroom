/**
 * Opening the app straight into one job, from a long-press on its icon.
 *
 * A PWA on Android cannot have the home-screen widget the brief asks for
 * (HANDOFF section 3), so the manifest's shortcuts are the nearest real
 * thing: hold the icon, pick the job, and the app opens with it already
 * started. They turned out to be the part of the install that landed best,
 * so there are now three.
 *
 * Each arrives as a query parameter on the URL the shortcut points at. Two
 * things have to be true of that, and both are easy to get wrong:
 *
 * * **It is read once.** The parameter says how the app was launched, not
 *   what state it is in. Reading it on every render would reopen the sheet
 *   the moment somebody closed it.
 * * **It is taken back out.** Otherwise a reload reopens the sheet, the
 *   address bar carries an instruction around, and the back button walks
 *   through states nobody chose.
 *
 * The parameter is removed with `replaceState` rather than by navigating, so
 * it leaves no entry of its own for Back to land on.
 */
import { useEffect, useState } from "react";

/** The query parameters the manifest's shortcuts use. Keep in step with manifest.config.ts. */
export type LaunchAction = "update-balance" | "update-savings" | "add-one-off";

function launchedWith(action: LaunchAction): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(action);
}

function forget(action: LaunchAction): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(action)) return;
  url.searchParams.delete(action);
  // Keep whatever the router put in history state; only the URL changes.
  window.history.replaceState(window.history.state, "", url);
}

/**
 * Was the app opened by this shortcut?
 *
 * True on the first render after such a launch and never again, so it can be
 * used as the initial value of whatever opens the sheet.
 */
export function useLaunchedBy(action: LaunchAction): boolean {
  const [launched] = useState(() => launchedWith(action));

  useEffect(() => {
    if (launched) forget(action);
  }, [launched, action]);

  return launched;
}
