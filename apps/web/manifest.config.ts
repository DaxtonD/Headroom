/**
 * The web app manifest: what a phone is told when somebody installs this.
 *
 * Its own file rather than a literal inside the Vite config, because it is
 * data and it is worth testing. Every field here fails silently when it is
 * wrong - an icon that 404s or is not the size it claims means Chrome quietly
 * declines to offer the install, and nothing anywhere says why.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ManifestOptions } from "vite-plugin-pwa";

const PUBLIC_DIR = resolve(import.meta.dirname, "public");

/** The icons the manifest names, in the order it names them. */
export const ICON_FILES = [
  "icon-192.png",
  "icon-384.png",
  "icon-512.png",
  "icon-maskable-192.png",
  "icon-maskable-512.png",
] as const;

/**
 * A short hash of the icons' own bytes, which goes in their URL.
 *
 * The icons keep stable names, so for their whole life a new logo arrived at
 * a URL that caches already had an answer for. On 2026-11-18 a retired mark
 * was still on a home screen the day after it was replaced: the container was
 * serving the right bytes and Cloudflare's edge was serving the old ones,
 * because it caches by file extension and applies its own four-hour TTL
 * whatever `cache-control` the app sends. That hostname is a CNAME and its
 * cache settings are not ours to change.
 *
 * So the URL changes instead. New artwork hashes differently, lands at a path
 * nothing has ever cached, and no intermediary anywhere can serve the old one
 * - because nothing asks for it again. The stamp is derived rather than typed,
 * so changing the logo cannot leave it stale: there is no step to forget.
 *
 * The manifest itself is served `no-cache` and `.webmanifest` is not an
 * extension Cloudflare caches, so a phone reads the new URLs promptly.
 */
export const ICON_STAMP = createHash("sha256")
  .update(Buffer.concat(ICON_FILES.map((file) => readFileSync(resolve(PUBLIC_DIR, file)))))
  .digest("hex")
  .slice(0, 8);

/** Where a stamped icon is served from. `vite.config.ts` writes them there. */
export function iconUrl(file: string): string {
  return `icons/${ICON_STAMP}/${file}`;
}

export const manifest: Partial<ManifestOptions> = {
  id: "/",
  name: "Headroom",
  short_name: "Headroom",
  description: "The household budget, with the adding up already done.",
  lang: "en-CA",
  dir: "ltr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  // The hero, so the phone's status bar blends into the balance.
  theme_color: "#123b33",
  // `--hr-ground`, so the splash screen is the colour of the app.
  background_color: "#f5f4ef",
  categories: ["finance", "productivity"],
  /*
   * Drawn, not generated. Every file here is authored artwork from the icon
   * package in `assets/`, which is why `any` and `maskable` are separate
   * entries rather than one `"any maskable"`: the maskable ones carry the
   * padding Android's crop needs, and a browser asked to use them where a
   * plain icon is expected draws something noticeably small.
   */
  icons: [
    { src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
    { src: iconUrl("icon-384.png"), sizes: "384x384", type: "image/png", purpose: "any" },
    { src: iconUrl("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
    /*
     * Android crops these to whatever shape its launcher uses, so the mark
     * sits inside the safe zone on a solid background - a maskable icon with
     * transparent corners gets them filled with something that is not our
     * choosing. Two sizes so a launcher can take the one that suits its
     * density instead of downscaling the big one.
     */
    {
      src: iconUrl("icon-maskable-192.png"),
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: iconUrl("icon-maskable-512.png"),
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
  /*
   * The brief asks for a home-screen widget, which a PWA on Android cannot
   * have (HANDOFF section 3). Long-press shortcuts are the nearest thing
   * that actually exists, and of everything in the install they are what
   * landed best, so there are three: the two balances that get typed in by
   * hand, and the one thing that gets added in a hurry.
   *
   * Android shows at most four and iOS shows none. The order here is the
   * order they appear in, most used first.
   *
   * Each `url` carries a parameter that `lib/launchAction.ts` reads once and
   * then removes. Adding one here without handling it there opens the right
   * screen and does nothing else, which is why the test checks both ends.
   */
  shortcuts: [
    {
      name: "Update balance",
      short_name: "Balance",
      description: "Type in what the bank says and tick off what has cleared.",
      url: "/?update-balance=1",
      icons: [{ src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Update savings",
      short_name: "Savings",
      description: "Type in what the savings account says.",
      url: "/savings?update-savings=1",
      icons: [{ src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Add a one-off",
      short_name: "One-off",
      description: "Something that is not on the list and happens once.",
      url: "/?add-one-off=1",
      icons: [{ src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png" }],
    },
  ],
};
