/**
 * Every theme is complete, and its text is readable.
 *
 * Themes are the one kind of change where "it looks fine" is the least
 * reliable test there is: a palette judged on a bright monitor indoors can be
 * unreadable on a phone in the sun, and the person who picked the colours is
 * the worst placed to notice. So the two things that actually break are
 * checked by arithmetic.
 *
 *  1. **Completeness.** A theme block that leaves a token out does not fall
 *     back to something sensible - it inherits Daylight's value. In a dark
 *     theme that means a white card in the middle of a dark screen, or black
 *     text on a near-black surface. There is no warning of any kind.
 *
 *  2. **Contrast.** HANDOFF's accessibility rules require 4.5:1 for text, and
 *     it is a stated M5 acceptance criterion. Borders and rings carry meaning
 *     without being text, so they are held to the 3:1 that WCAG asks of
 *     non-text UI.
 *
 * The pairs below are the ones the stylesheets actually draw. They were taken
 * from the `color:` and `background:` declarations across `src`, not invented:
 * a pair nobody renders would be busywork, and a pair that is rendered and not
 * listed here is the gap this file exists to close.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
  resolve(import.meta.dirname, "..", "src", "styles", "tokens.css"),
  "utf8",
);

/* -------------------------------------------------------------------------- */
/* Reading the stylesheet                                                     */
/* -------------------------------------------------------------------------- */

/** Every `:root` or `:root[data-theme="x"]` block, as name -> declarations. */
function readThemes(source: string): Map<string, Map<string, string>> {
  const themes = new Map<string, Map<string, string>>();

  const blocks = source.matchAll(
    /:root(?:\[data-theme="(?<name>[a-z-]+)"\])?\s*\{(?<body>[^}]*)\}/g,
  );

  for (const block of blocks) {
    const name = block.groups?.["name"] ?? "daylight";
    const declarations = themes.get(name) ?? new Map<string, string>();

    for (const declaration of (block.groups?.["body"] ?? "").matchAll(
      /(--hr-[a-z0-9-]+)\s*:\s*([^;]+);/g,
    )) {
      declarations.set(declaration[1] as string, (declaration[2] as string).trim());
    }

    themes.set(name, declarations);
  }

  return themes;
}

const themes = readThemes(TOKENS);
const daylight = themes.get("daylight");

/** The colour tokens, as opposed to spacing, radii and fonts. */
function colourTokens(declarations: Map<string, string>): string[] {
  return [...declarations.keys()].filter((token) => {
    const value = declarations.get(token) as string;
    return value.startsWith("#") || value.startsWith("rgb") || value === "none";
  });
}

/* -------------------------------------------------------------------------- */
/* Contrast                                                                   */
/* -------------------------------------------------------------------------- */

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const digits = hex.replace("#", "");
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;

  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded to one place, for a failure message that says what to aim at. */
function ratio(foreground: string, background: string): number {
  /* eslint-disable-next-line no-restricted-properties -- a contrast ratio, not money. */
  return Math.round(contrast(foreground, background) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* What is drawn on what                                                      */
/* -------------------------------------------------------------------------- */

/** Text colours, and every surface each one is used on. */
const TEXT_ON: readonly { readonly text: string; readonly on: readonly string[] }[] = [
  // Body text appears on the page, on cards, and on the tinted rows.
  {
    text: "--hr-ink",
    on: ["--hr-ground", "--hr-card", "--hr-payday-row", "--hr-green-tint", "--hr-green-tint-soft"],
  },
  {
    text: "--hr-text-secondary",
    on: ["--hr-ground", "--hr-card", "--hr-payday-row", "--hr-green-tint-soft"],
  },
  {
    text: "--hr-text-muted",
    on: ["--hr-ground", "--hr-card", "--hr-payday-row", "--hr-green-tint-soft"],
  },
  // Amounts, which are the whole point of the screen.
  { text: "--hr-positive", on: ["--hr-ground", "--hr-card", "--hr-payday-row", "--hr-green-tint"] },
  { text: "--hr-negative", on: ["--hr-ground", "--hr-card"] },
  // Links and the active tab.
  { text: "--hr-primary", on: ["--hr-ground", "--hr-card", "--hr-green-tint-soft"] },
  // The hero, where the balance lives.
  { text: "--hr-hero-text", on: ["--hr-hero-bg"] },
  { text: "--hr-hero-muted", on: ["--hr-hero-bg"] },
  // A button's own label.
  { text: "--hr-on-primary", on: ["--hr-primary", "--hr-primary-hover"] },
  { text: "--hr-on-negative", on: ["--hr-negative", "--hr-negative-hover"] },
  // Chips and the alert, each of which is a pair.
  { text: "--hr-oneoff-fg", on: ["--hr-oneoff-bg"] },
  { text: "--hr-flexible-fg", on: ["--hr-flexible-bg"] },
  { text: "--hr-warning-fg", on: ["--hr-warning-bg"] },
  { text: "--hr-neutral-fg", on: ["--hr-neutral-bg"] },
];

/** Borders and rings: meaningful, but not text. */
const EDGE_ON: readonly { readonly edge: string; readonly on: readonly string[] }[] = [
  { edge: "--hr-estimate-ring", on: ["--hr-ground", "--hr-card"] },
  { edge: "--hr-focus", on: ["--hr-ground", "--hr-card"] },
];

const TEXT_MINIMUM = 4.5;
const EDGE_MINIMUM = 3;

/* -------------------------------------------------------------------------- */

describe("themes", () => {
  it("finds them, and finds the tokens in them", () => {
    // If the parser stops matching, every check below would pass having tested
    // nothing at all.
    expect(daylight).toBeDefined();
    expect(colourTokens(daylight as Map<string, string>).length).toBeGreaterThan(25);
    expect([...themes.keys()].length).toBeGreaterThan(3);
  });

  it("offers a light theme, a dark one, and more than one of each", () => {
    // What was asked for: light, dark, and a few easy-reading ones. A theme is
    // dark when it says so, and `color-scheme` is what tells the browser too.
    const dark = [...themes.keys()].filter((name) =>
      new RegExp(`:root\\[data-theme="${name}"\\][^}]*color-scheme:\\s*dark`).test(TOKENS),
    );
    const light = [...themes.keys()].filter((name) => !dark.includes(name));

    expect(dark.length).toBeGreaterThanOrEqual(2);
    expect(light.length).toBeGreaterThanOrEqual(2);
  });

  it("defines every colour Daylight defines", () => {
    const expected = colourTokens(daylight as Map<string, string>).sort();

    const incomplete: string[] = [];
    for (const [name, declarations] of themes) {
      if (name === "daylight") continue;
      for (const token of expected) {
        if (!declarations.has(token)) incomplete.push(`${name}: ${token}`);
      }
    }

    // A missing token is not a missing colour - it is Daylight's colour,
    // which in a dark theme is a white card on a dark page.
    expect(incomplete.sort()).toEqual([]);
  });

  it("says whether it is light or dark, so native controls follow", () => {
    // Without `color-scheme`, a date picker and the scrollbars stay light on a
    // dark page. The ledger has date inputs, so this is visible.
    const missing = [...themes.keys()].filter(
      (name) =>
        !new RegExp(
          `:root(?:\\[data-theme="${name}"\\])?[^}]*color-scheme:\\s*(light|dark)`,
        ).test(TOKENS) ||
        (name !== "daylight" &&
          !new RegExp(`:root\\[data-theme="${name}"\\][^}]*color-scheme:\\s*(light|dark)`).test(
            TOKENS,
          )),
    );

    expect(missing).toEqual([]);
  });

  it("keeps every text colour at 4.5:1 on the surfaces it is drawn on", () => {
    const failures: string[] = [];

    for (const [name, declarations] of themes) {
      for (const pair of TEXT_ON) {
        const text = declarations.get(pair.text);
        if (text === undefined || !text.startsWith("#")) continue;

        for (const surfaceToken of pair.on) {
          const surface = declarations.get(surfaceToken);
          if (surface === undefined || !surface.startsWith("#")) continue;

          const found = ratio(text, surface);
          if (found < TEXT_MINIMUM) {
            failures.push(
              `${name}: ${pair.text} (${text}) on ${surfaceToken} (${surface}) is ${found}:1, needs ${TEXT_MINIMUM}`,
            );
          }
        }
      }
    }

    expect(failures.sort()).toEqual([]);
  });

  it("keeps borders and focus rings at 3:1", () => {
    const failures: string[] = [];

    for (const [name, declarations] of themes) {
      for (const pair of EDGE_ON) {
        const edge = declarations.get(pair.edge);
        if (edge === undefined || !edge.startsWith("#")) continue;

        for (const surfaceToken of pair.on) {
          const surface = declarations.get(surfaceToken);
          if (surface === undefined || !surface.startsWith("#")) continue;

          const found = ratio(edge, surface);
          if (found < EDGE_MINIMUM) {
            failures.push(
              `${name}: ${pair.edge} (${edge}) on ${surfaceToken} (${surface}) is ${found}:1, needs ${EDGE_MINIMUM}`,
            );
          }
        }
      }
    }

    expect(failures.sort()).toEqual([]);
  });

  it("agrees with itself about the arithmetic", () => {
    // The contrast function is the thing every check above trusts, so it is
    // checked against the two ratios everybody knows.
    expect(ratio("#000000", "#ffffff")).toBe(21);
    expect(ratio("#ffffff", "#ffffff")).toBe(1);
    expect(ratio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
