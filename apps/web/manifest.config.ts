/**
 * The web app manifest: what a phone is told when somebody installs this.
 *
 * Its own file rather than a literal inside the Vite config, because it is
 * data and it is worth testing. Every field here fails silently when it is
 * wrong - an icon that 404s or is not the size it claims means Chrome quietly
 * declines to offer the install, and nothing anywhere says why.
 */
import type { ManifestOptions } from "vite-plugin-pwa";

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
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    {
      // Android crops this to whatever shape its launcher uses, so it
      // is drawn smaller and on a solid background. See
      // scripts/make_icons.py.
      src: "icon-maskable-512.png",
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
      icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Update savings",
      short_name: "Savings",
      description: "Type in what the savings account says.",
      url: "/savings?update-savings=1",
      icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Add a one-off",
      short_name: "One-off",
      description: "Something that is not on the list and happens once.",
      url: "/?add-one-off=1",
      icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
    },
  ],
};
