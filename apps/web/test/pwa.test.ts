/**
 * The manifest describes icons that actually exist, at the sizes it claims.
 *
 * This is the kind of thing nobody finds by looking at the app. Chrome checks
 * the manifest before it offers to install, and when something does not add
 * up it declines - no error on screen, no console warning anybody is reading,
 * just an install button that never appears and a household still using a
 * browser tab.
 *
 * The icons are authored artwork, delivered as a set and committed as they
 * were drawn (`assets/headroom-icon.svg` is the master). They were generated
 * from a single PNG by a script until 2026-11-17; what this file guards
 * against is unchanged either way, since the failure is a manifest naming a
 * file that is absent or is not the size it claims.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_FILES, ICON_STAMP, iconUrl, manifest } from "../manifest.config.js";

const WEB = resolve(import.meta.dirname, "..");
const PUBLIC = resolve(WEB, "public");
const html = readFileSync(resolve(WEB, "index.html"), "utf8");

/** The `LaunchAction` union, which every shortcut's parameter has to be in. */
const launchActions = readFileSync(resolve(WEB, "src", "lib", "launchAction.ts"), "utf8");

/** Every source file, for checking that a screen actually reads each action. */
const sourceFiles = readdirSync(resolve(WEB, "src"), { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
  .map((entry) => readFileSync(resolve(WEB, "src", entry), "utf8"));

/** A PNG's real size, read out of the IHDR chunk that opens every PNG. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const icons = manifest.icons ?? [];

/**
 * The artwork behind a manifest entry.
 *
 * The manifest names a stamped URL and the build writes the copy there; the
 * drawing itself lives unstamped in `public/`, so the basename is the file.
 */
const artworkFor = (src: string): string => resolve(PUBLIC, src.split("/").at(-1) as string);

describe("the manifest", () => {
  it("says enough for a phone to install it", () => {
    expect(manifest.name).toBe("Headroom");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(icons.length).toBeGreaterThan(0);
  });

  it("agrees with the page about the colour of the status bar", () => {
    // Two places say this, and a phone sees both: the meta while the app is
    // a tab, the manifest once it is installed. Different values mean the
    // top of the screen changes colour when it is installed.
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];
    expect(meta?.toLowerCase()).toBe(manifest.theme_color);
  });

  it.each(icons.map((icon) => [icon.src, icon] as const))("ships %s", (_src, icon) => {
    const file = artworkFor(icon.src);
    expect(existsSync(file), `${icon.src} is in the manifest but not in public/`).toBe(true);

    const [declared] = icon.sizes.split(" ");
    const [width, height] = (declared as string).split("x").map(Number);
    expect(pngSize(file)).toEqual({ width, height });
  });

  describe("the icon stamp", () => {
    /*
     * Why the URL carries a hash at all: the icons keep stable names, so for
     * the app's whole life new artwork arrived at a URL caches already had an
     * answer for. A retired mark sat on a home screen for a day because
     * Cloudflare was serving its own four-hour copy, and that hostname's
     * cache settings are not ours to change. A derived stamp means new
     * artwork lands at a path nothing has ever cached.
     */
    it("is in the URL of every icon the manifest names", () => {
      for (const icon of icons) {
        expect(icon.src, `${icon.src} is not stamped`).toContain(`icons/${ICON_STAMP}/`);
      }
      // Short enough to read in a URL, long enough not to collide.
      expect(ICON_STAMP).toMatch(/^[0-9a-f]{8}$/);
    });

    it("covers every icon, so changing any one of them changes the URL", () => {
      /*
       * The property that makes this work without anyone remembering to do
       * anything. If an icon were left out of the hash, replacing just that
       * one would reuse a URL and the stale copy would win again.
       */
      const names = icons.map((icon) => icon.src.split("/").at(-1));
      for (const file of ICON_FILES) {
        expect(names, `${file} is hashed but not in the manifest`).toContain(file);
      }
      for (const name of names) {
        expect(ICON_FILES, `${name} is in the manifest but not hashed`).toContain(name);
      }
    });

    it("is on the shortcut icons too, which were missed the first time", () => {
      /*
       * The long-press shortcuts carry their own icon, and stamping only the
       * manifest's top-level `icons` left these three pointing at the bare
       * `icon-192.png` - which was, at that moment, the URL an edge cache was
       * answering with the retired logo. Every icon URL the manifest emits
       * has to be stamped, not just the obvious list.
       */
      for (const shortcut of manifest.shortcuts ?? []) {
        for (const icon of shortcut.icons ?? []) {
          expect(icon.src, `${shortcut.name}'s icon is not stamped`).toContain(
            `icons/${ICON_STAMP}/`,
          );
        }
      }
    });

    it("is built from the bytes, not from a number somebody maintains", () => {
      // Recomputing it the same way must give the same answer, and the helper
      // and the manifest must agree.
      expect(iconUrl("icon-512.png")).toBe(`icons/${ICON_STAMP}/icon-512.png`);
      const stamped = icons.filter((icon) => icon.src.startsWith(`icons/${ICON_STAMP}/`));
      expect(stamped).toHaveLength(icons.length);
    });
  });

  it("includes one Android can crop to its own shape", () => {
    // Without a maskable icon Android puts ours on a white tile of its own,
    // which on a dark launcher is a bright square with a small logo in it.
    const maskable = icons.filter((icon) => icon.purpose?.includes("maskable"));
    expect(maskable.length).toBeGreaterThan(0);

    /*
     * The *largest* has to survive the crop, not every one of them.
     *
     * This read "every maskable is at least 512" until a second, smaller one
     * was added for launchers that want it - which is ordinary practice and
     * was not a defect, but failed a test asserting more than it meant. What
     * matters is that there is one big enough that cropping to the middle
     * 80% still leaves detail; the small ones exist so a launcher does not
     * have to downscale that one.
     */
    const widest = Math.max(...maskable.map((icon) => pngSize(artworkFor(icon.src)).width));
    expect(widest).toBeGreaterThanOrEqual(512);
  });

  it("offers the jobs done by hand, in place of the widget it cannot have", () => {
    // Standing in for the home-screen widget, which a PWA on Android cannot
    // have (HANDOFF section 3).
    const shortcuts = manifest.shortcuts ?? [];
    expect(shortcuts.length).toBeGreaterThan(0);
    // Android shows four at most; more than that is work nobody will see.
    expect(shortcuts.length).toBeLessThanOrEqual(4);

    for (const shortcut of shortcuts) {
      expect(shortcut.name.length).toBeGreaterThan(0);
      // The launcher shows the short name under a small icon.
      expect((shortcut.short_name ?? shortcut.name).length).toBeLessThanOrEqual(12);
      expect(shortcut.url.startsWith("/"), `${shortcut.url} must stay in scope`).toBe(true);
    }
  });

  it.each((manifest.shortcuts ?? []).map((shortcut) => [shortcut.name, shortcut.url] as const))(
    "%s does something when it is opened",
    (_name, url) => {
      /*
       * A shortcut whose parameter nothing reads is the worst kind of dead
       * feature: it opens the right screen, so it looks like it worked, and
       * the job it promised to start simply has not started.
       */
      const action = [...new URL(url, "https://example.test").searchParams.keys()][0];
      expect(action, `${url} carries no action`).toBeDefined();

      // Declared where the actions are declared...
      expect(launchActions, `"${action}" is not a LaunchAction`).toContain(`"${action}"`);
      // ...and actually read by a screen.
      expect(
        sourceFiles.some((file) => file.includes(`useLaunchedBy("${action}")`)),
        `nothing calls useLaunchedBy("${action}")`,
      ).toBe(true);
    },
  );
});

describe("the page", () => {
  it("points at the icons a manifest cannot carry", () => {
    // iOS reads none of the manifest's icons, and a browser tab reads none
    // of them either.
    for (const file of ["apple-touch-icon.png", "favicon.ico"]) {
      expect(existsSync(resolve(PUBLIC, file)), `public/${file} is missing`).toBe(true);
      expect(html, `index.html does not link ${file}`).toContain(file);
    }
  });
});
