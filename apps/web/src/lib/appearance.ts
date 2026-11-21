/**
 * How the app looks: the theme, the text size, and how tightly the ledger
 * packs its rows.
 *
 * These are not household facts. They are per-eye, per-screen preferences - a
 * phone held at arm's length in a dark room wants a different answer from a
 * desktop monitor in a bright kitchen - and neither person may change the
 * other's. That much has been true since they were built.
 *
 * What changed on 2026-11-21 is where they are kept. They were in
 * `localStorage` and nowhere else, which made them per *browser* as well as
 * per person - and one of the two clears their browser every day, so every
 * morning the app greeted them in a theme and a size they had not chosen.
 * They are now stored against the person on the server and loaded at sign-in
 * (`preferences.ts`), with `localStorage` kept as well for the one job it is
 * still the only thing that can do: `index.html` applies the theme and the
 * text scale before the first paint, and nothing that needs a round trip can
 * be read that early.
 *
 * So the division of labour:
 *
 *  - this file owns the TABLES - which themes, which sizes, which densities -
 *    the reading and writing of `localStorage`, putting the choice onto the
 *    document, and the little store every component reads it from;
 *  - `preferences.ts` owns the round trip to the server.
 *
 * `localStorage` can throw rather than return null - a browser with site data
 * blocked, or a private window - so every read and write is guarded and the
 * app renders correctly when it is unavailable.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

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

/**
 * The step a multiplier belongs to, and the multiplier a step's name means.
 *
 * Two representations of one choice, which is worth a word. `localStorage`
 * holds the NUMBER, because `index.html` applies it before the first paint and
 * a name would mean that inline script carrying its own copy of the table
 * above - two copies, drifting the first time a step changes. The server holds
 * the NAME, because a multiplier is a float and nothing in this repository
 * stores a float if a name will do. The table is the only source of either.
 *
 * Both directions fall back to the default rather than throwing: a value left
 * behind by an older build, or edited by hand, must not leave the text at a
 * size the settings screen has no button for.
 */
export function textSizeKeyFor(scale: number): string {
  return TEXT_SIZES.find((size) => size.scale === scale)?.key ?? DEFAULT_TEXT_SIZE.key;
}

export function scaleForTextSize(key: string): number {
  return TEXT_SIZES.find((size) => size.key === key)?.scale ?? DEFAULT_TEXT_SIZE.scale;
}

/** The size the app was designed at, and what a device with nothing gets. */
const DEFAULT_TEXT_SIZE: TextSizeOption = TEXT_SIZES[0] as TextSizeOption;

/* -------------------------------------------------------------------------- */
/* Ledger density                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How tightly the ledger packs its rows.
 *
 * Asked for on 2026-11-21, for the person who came to this app from the
 * spreadsheet: "I like the current UI. She might appreciate seeing more at a
 * glance, like her spreadsheet."
 *
 * `compact` keeps the ledger's shape and loses what the shape can spare: the
 * paid/verified badge, the second line of chips, the line saying whose bill it
 * is. The date and the kind of row survive as the one chip that is left, and
 * every figure survives untouched - a view that showed fewer numbers would be
 * a different ledger rather than a tighter one. Roughly twice as many rows fit
 * on a screen, and no row goes under the 44px the brief sets as the floor for
 * anything you have to hit with a thumb.
 *
 * Everything hidden is hidden VISUALLY, not removed: the badge and the chips
 * stay in the accessibility tree, so what a screen reader is told is the same
 * in both views. Compact is a way of looking at the ledger, not a second one.
 */
export type Density = "comfortable" | "compact";

export interface DensityOption {
  readonly key: Density;
  readonly name: string;
  readonly description: string;
}

export const DENSITIES: readonly DensityOption[] = [
  {
    key: "comfortable",
    name: "Comfortable",
    description: "Every badge and chip, on two or three lines a row.",
  },
  {
    key: "compact",
    name: "Compact",
    description: "One line a row, about twice as many on the screen.",
  },
];

const DENSITY_KEYS = new Set<string>(DENSITIES.map((density) => density.key));

/* -------------------------------------------------------------------------- */
/* Reading and writing the choice                                             */
/* -------------------------------------------------------------------------- */

export interface Appearance {
  readonly theme: ThemeChoice;
  /** The multiplier itself, not a name for it. See `TEXT_SCALE_STORAGE_KEY`. */
  readonly scale: number;
  readonly density: Density;
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
 * The ledger's density.
 *
 * Kept here as well as on the server for the same reason as the other two: it
 * is read on the way to the first paint, before anything has been fetched, and
 * a ledger that lays itself out twice on every open would be worse than one
 * that waits.
 */
export const DENSITY_STORAGE_KEY = "headroom.ledgerDensity";

/**
 * What a device with nothing stored gets.
 *
 * Daylight rather than `system`, so installing an update never changes how the
 * app looks without being asked.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: "daylight",
  scale: 1,
  // The ledger as it was built and as it is in daily use. A new device, or a
  // person who has never chosen, gets the view the app was designed around.
  density: "comfortable",
};

export function readAppearance(): Appearance {
  let theme = DEFAULT_APPEARANCE.theme;
  let scale = DEFAULT_APPEARANCE.scale;
  let density = DEFAULT_APPEARANCE.density;

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

    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (storedDensity !== null && DENSITY_KEYS.has(storedDensity)) density = storedDensity as Density;
  } catch {
    // Site data blocked, or a private window. The defaults are a fine answer.
  }

  return { theme, scale, density };
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
 * `data-theme` selects the palette in `tokens.css`, `--hr-text-scale`
 * multiplies the root font size, and `data-density` is what the ledger's
 * compact rules key off. The `theme-color` meta is kept in step so the phone's
 * status bar matches the hero rather than staying the green of a theme that is
 * no longer on.
 *
 * An attribute rather than a prop threaded down to every row: the compact
 * ledger is a stylesheet, which is the only way it could be while keeping one
 * row component. A second row written for the compact view would be two
 * components to keep in step on every future change to a row, and the first
 * thing to drift would be the money.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const palette = paletteFor(appearance.theme);

  root.dataset["theme"] = palette;
  root.dataset["density"] = appearance.density;
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
  write(DENSITY_STORAGE_KEY, appearance.density);
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
/* One copy of the choice, for every component that reads it                  */
/* -------------------------------------------------------------------------- */

/**
 * The choice lives in a module, not in a component.
 *
 * It used to be `useState` inside the hook, which was right while Settings was
 * the only screen that could change it. The compact toggle in the app header
 * made it wrong: two components each holding their own copy means tapping the
 * header leaves the Settings screen still showing the old answer, and the
 * sync to the server (`preferences.ts`) would have no single thing to watch.
 *
 * `useSyncExternalStore` rather than a context and a provider: there is one
 * value, it is read in three places, and it has to be readable from outside
 * React as well - the server's answer arrives in a query and is applied by
 * calling `setAppearance` directly.
 *
 * `current` is cached so the snapshot is referentially stable between
 * changes, which is what `useSyncExternalStore` requires of it.
 */
let current: Appearance | null = null;
const listeners = new Set<() => void>();

/** The choice as it stands, reading storage once on first use. */
export function getAppearance(): Appearance {
  current ??= readAppearance();
  return current;
}

/**
 * Change it everywhere: the store, `localStorage` and the document.
 *
 * Applying is not React's job - it is an attribute and a custom property on
 * `<html>`, outside the tree - so this does it directly rather than going
 * through an effect. That keeps the change instant on the tap.
 */
export function setAppearance(next: Appearance): void {
  current = next;
  saveAppearance(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The choice, for anything that reads it and never sets it.
 *
 * Separate from `useAppearance` because of what that one also does: it watches
 * the device's dark-mode preference while "Match my device" is chosen, and one
 * component should own that watcher rather than every reader starting its own.
 */
export function useAppearanceValue(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

/** The current choice, and a setter that stores and applies it at once. */
export function useAppearance(): readonly [Appearance, (next: Appearance) => void] {
  const appearance = useAppearanceValue();

  // Someone switching their phone to dark mode in the evening should see this
  // tab follow, while "Match my device" is the choice.
  useEffect(() => {
    if (appearance.theme !== "system") return;
    return watchDevicePreference(() => applyAppearance(appearance));
  }, [appearance]);

  const update = useCallback((next: Appearance): void => {
    setAppearance(next);
  }, []);

  return [appearance, update] as const;
}
