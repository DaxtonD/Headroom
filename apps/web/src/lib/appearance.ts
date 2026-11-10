/**
 * How the app looks on *this* device: the theme and the text size.
 *
 * Deliberately not in the database, unlike everything else the app stores.
 * These are not household facts, they are per-eye, per-screen preferences: a
 * phone held at arm's length in a dark room wants a different answer from a
 * desktop monitor in a bright kitchen, and neither person should be able to
 * change the other's. So they live in `localStorage`, which is per device and
 * per browser, and they never cross the wire.
 *
 * That also means they survive no sign-out and reach no backup, which is
 * correct: losing them costs two taps.
 *
 * `localStorage` can throw rather than return null - a browser with site data
 * blocked, or a private window - so every read and write is guarded and the
 * app renders correctly when it is unavailable.
 */
import { useCallback, useEffect, useState } from "react";

/* -------------------------------------------------------------------------- */
/* Themes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A theme as it is stored. `system` is not a palette: it means "whichever of
 * Daylight and Night the device is asking for", resolved here rather than in
 * CSS so the stylesheet only ever deals in real palettes.
 */
export type ThemeChoice = "system" | "daylight" | "paper" | "clear" | "night" | "slate";

/** A palette that actually exists in `tokens.css`. */
export type Palette = Exclude<ThemeChoice, "system">;

export interface ThemeOption {
  readonly key: ThemeChoice;
  readonly name: string;
  /** Said in the person's terms: when you would want this one. */
  readonly description: string;
  /** Which palette the swatch should preview. */
  readonly previews: Palette;
}

export const THEMES: readonly ThemeOption[] = [
  {
    key: "system",
    name: "Match my device",
    description: "Light by day and dark at night, following the phone's own setting.",
    previews: "daylight",
  },
  {
    key: "daylight",
    name: "Daylight",
    description: "The original: warm paper, dark green.",
    previews: "daylight",
  },
  {
    key: "paper",
    name: "Paper",
    description: "Warmer and softer, with less glare. Easiest in a bright room.",
    previews: "paper",
  },
  {
    key: "clear",
    name: "Clear",
    description: "The most legible: firm edges and the strongest contrast.",
    previews: "clear",
  },
  {
    key: "night",
    name: "Night",
    description: "Dark, in the app's own green.",
    previews: "night",
  },
  {
    key: "slate",
    name: "Slate",
    description: "Dark and softer than Night. Kindest late in the evening.",
    previews: "slate",
  },
];

const THEME_KEYS = new Set<string>(THEMES.map((theme) => theme.key));

/* -------------------------------------------------------------------------- */
/* Text size                                                                  */
/* -------------------------------------------------------------------------- */

export interface TextSizeOption {
  readonly key: string;
  readonly name: string;
  readonly scale: number;
  readonly description: string;
}

/**
 * Text sizes, largest first.
 *
 * The app was designed at 1, and that is as large as anybody wanted it, so the
 * scale only goes down from there. The steps are about 7% apart, which is
 * enough to notice and small enough that no layout jumps between two of them.
 */
export const TEXT_SIZES: readonly TextSizeOption[] = [
  { key: "largest", name: "Largest", scale: 1, description: "The size the app was designed at." },
  { key: "large", name: "Large", scale: 0.94, description: "A little smaller." },
  { key: "medium", name: "Medium", scale: 0.88, description: "More on the screen at once." },
  { key: "small", name: "Small", scale: 0.82, description: "More again." },
  { key: "smallest", name: "Smallest", scale: 0.76, description: "As small as it goes." },
];

/* -------------------------------------------------------------------------- */
/* Reading and writing the choice                                             */
/* -------------------------------------------------------------------------- */

export interface Appearance {
  readonly theme: ThemeChoice;
  /** The multiplier itself, not a name for it. See `TEXT_SCALE_STORAGE_KEY`. */
  readonly scale: number;
}

export const THEME_STORAGE_KEY = "headroom.theme";
/**
 * The scale is stored as the number, deliberately.
 *
 * `index.html` applies both of these before the first paint, or the app would
 * flash Daylight at full size on every load. Storing "medium" would mean that
 * inline script needed its own copy of the table above, and the two copies
 * would drift the first time a step changed. A number needs no table.
 */
export const TEXT_SCALE_STORAGE_KEY = "headroom.textScale";

/**
 * What a device with nothing stored gets.
 *
 * Daylight rather than `system`, so installing an update never changes how the
 * app looks without being asked.
 */
export const DEFAULT_APPEARANCE: Appearance = { theme: "daylight", scale: 1 };

export function readAppearance(): Appearance {
  let theme = DEFAULT_APPEARANCE.theme;
  let scale = DEFAULT_APPEARANCE.scale;

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme !== null && THEME_KEYS.has(storedTheme)) theme = storedTheme as ThemeChoice;

    // Only a scale this build offers is accepted, so a value left behind by an
    // older build - or edited by hand - cannot leave the text at a size the
    // settings screen has no button for.
    /* eslint-disable-next-line no-restricted-properties --
       A text-size multiplier, not an amount. The rule that bans floats is
       about money, and this never goes near a cent. */
    const storedScale = Number.parseFloat(
      window.localStorage.getItem(TEXT_SCALE_STORAGE_KEY) ?? "",
    );
    if (TEXT_SIZES.some((size) => size.scale === storedScale)) scale = storedScale;
  } catch {
    // Site data blocked, or a private window. The defaults are a fine answer.
  }

  return { theme, scale };
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do and nothing worth saying: the choice still applies to
    // this session, it just will not be remembered.
  }
}

/* -------------------------------------------------------------------------- */
/* Applying it                                                                */
/* -------------------------------------------------------------------------- */

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** The palette a choice resolves to right now. */
export function paletteFor(theme: ThemeChoice): Palette {
  if (theme !== "system") return theme;
  return prefersDark() ? "night" : "daylight";
}

/**
 * Put the choice on the document.
 *
 * `data-theme` selects the palette in `tokens.css` and `--hr-text-scale`
 * multiplies the root font size. The `theme-color` meta is kept in step so the
 * phone's status bar matches the hero rather than staying the green of a theme
 * that is no longer on.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const palette = paletteFor(appearance.theme);

  root.dataset["theme"] = palette;
  root.style.setProperty("--hr-text-scale", String(appearance.scale));

  const hero = getComputedStyle(root).getPropertyValue("--hr-hero-bg").trim();
  if (hero !== "") {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", hero);
  }
}

export function saveAppearance(appearance: Appearance): void {
  write(THEME_STORAGE_KEY, appearance.theme);
  write(TEXT_SCALE_STORAGE_KEY, String(appearance.scale));
  applyAppearance(appearance);
}

/**
 * Follow the device while "Match my device" is chosen.
 *
 * Returns the unsubscribe function. Without this, switching the phone to dark
 * mode in the evening would leave an open tab on the light palette until it
 * was reloaded.
 */
export function watchDevicePreference(onChange: () => void): () => void {
  try {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  } catch {
    return () => undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* The hook the settings screen uses                                          */
/* -------------------------------------------------------------------------- */

/**
 * The current choice, and a setter that stores and applies it at once.
 *
 * Applying is not React's job - it is an attribute and a custom property on
 * `<html>`, outside the tree - so the setter does it directly rather than
 * going through an effect. That keeps the change instant on the tap.
 */
export function useAppearance(): readonly [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);

  // Someone switching their phone to dark mode in the evening should see this
  // tab follow, while "Match my device" is the choice.
  useEffect(() => {
    if (appearance.theme !== "system") return;
    return watchDevicePreference(() => applyAppearance(appearance));
  }, [appearance]);

  const update = useCallback((next: Appearance): void => {
    setAppearance(next);
    saveAppearance(next);
  }, []);

  return [appearance, update] as const;
}
