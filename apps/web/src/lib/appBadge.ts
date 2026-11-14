/**
 * The number on the app icon: bills still waiting for their real amount.
 *
 * The brief asks for a home-screen widget, which a PWA on Android cannot
 * have (HANDOFF section 3). Three things stand in for it, and this is the
 * second: the icon itself carries the one count worth knowing without
 * opening anything.
 *
 * Why that count and not, say, money. A badge is a small number with no
 * units and no context, so it has to mean something that is true whatever
 * the figure behind it is. "Four bills are still guesses" is an amount of
 * work left to do, and it goes to zero when the work is done. A dollar
 * figure on an icon would be read as how much is left to spend, which is a
 * number nobody should act on without seeing what it was worked out from.
 *
 * Support is patchy on purpose-built grounds rather than ours: Android Chrome
 * only shows it for an installed app, and iOS does not implement it at all.
 * So this is written to do nothing, quietly, wherever it is not available -
 * never to be a feature somebody is told about and cannot find.
 */

/** The bits of `navigator` this needs, which TypeScript does not know about. */
interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

function badging(): BadgingNavigator | null {
  if (typeof navigator === "undefined") return null;
  const candidate = navigator as BadgingNavigator;
  return typeof candidate.setAppBadge === "function" ? candidate : null;
}

/** Whether this browser can show a badge at all. */
export function badgeSupported(): boolean {
  return badging() !== null;
}

/**
 * Show `count` on the icon, or take the badge off when it is zero.
 *
 * Every failure is swallowed. The call rejects in a browser that has the API
 * but will not use it right now - a tab that is not an installed app, a
 * permission the user has turned off - and none of that is worth a line in
 * the console on every refresh, let alone anything on screen.
 */
export async function setAppBadge(count: number): Promise<void> {
  const nav = badging();
  if (!nav) return;

  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    /* Not available here. The app is no worse off without it. */
  }
}

/**
 * Take the badge off.
 *
 * Used on sign-out: the badge is a count of this household's work, and it
 * must not sit on the icon of a phone nobody is signed in on.
 */
export async function clearAppBadge(): Promise<void> {
  await setAppBadge(0);
}
