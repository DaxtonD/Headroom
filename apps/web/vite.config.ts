import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { manifest } from "./manifest.config.js";

/**
 * The app is installable, and offline it is a read-only cache.
 *
 * Writes are online-only and there is deliberately no Background Sync
 * (HANDOFF section 16.2 rule 2): replaying an edit to money against a figure
 * that has since changed is the failure this whole design exists to prevent.
 * So the service worker caches the shell and nothing else. Every `/api`
 * request goes to the network or fails, which is what makes the offline
 * banner honest - the app says the numbers are the last it had, and it is
 * not quietly serving a cached answer behind that.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      /*
       * `prompt`, not `autoUpdate`.
       *
       * `autoUpdate` activates a new worker the moment it downloads, which
       * can swap the code under a form somebody is halfway through typing
       * into. For a household that opens this several times a day to type a
       * balance in, a small "there is a new version" bar they tap when they
       * are ready is the right trade - the same principle as everything else
       * here, that nothing about their money happens without them saying so.
       */
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],

      /*
       * Our own service worker, not a generated one.
       *
       * `generateSW` writes the whole file, so there is nowhere to put a
       * `push` listener - and notifications were the one thing the household
       * asked for that cannot be done from the page. `injectManifest` hands
       * `src/sw.ts` the precache list and otherwise leaves it alone.
       *
       * Everything the generated worker did, that file now does explicitly:
       * the navigation fallback with `/api` excluded, the font caching, the
       * outdated-cache cleanup, and the refusal to activate itself without
       * being asked. `test/sw.test.ts` is what keeps that true.
       */
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",

      manifest,

      injectManifest: {
        /*
         * A classic worker, not a module one.
         *
         * `injectManifest` defaults to building an ES module, which then has
         * to be registered with `{ type: "module" }`. Chrome has supported
         * that since 2021 and Android is the target here - but a module
         * worker that a browser will not register fails by the whole app
         * silently having no service worker at all: no offline shell, no
         * update bar, no notifications, and nothing on screen to say so.
         * The generated worker was classic, this one stays classic, and
         * nothing is given up for it.
         */
        rollupFormat: "iife",
        // The built shell. Fonts are not here: they come from Google, and
        // `src/sw.ts` caches them at runtime instead.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        /*
         * The big icons are read once by the launcher when the app is
         * installed, which only happens online, and never by the page. They
         * are 185 kB of the precache if left in - a quarter of everything a
         * phone downloads before the app will open offline, for two files it
         * will not ask for.
         */
        globIgnores: ["**/icon-512.png", "**/icon-maskable-512.png"],
        // 3 MB: the bundle is ~450 kB and the icons are most of the rest.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },

      devOptions: {
        // Off in development: a service worker caching a dev server is a
        // morning spent wondering why an edit did nothing.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    // The API runs separately in development; proxying keeps the app on one
    // origin so cookies behave exactly as they do in production.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Phone first: fail the build if a chunk grows big enough to hurt the
    // instant-load requirement for Home.
    chunkSizeWarningLimit: 500,
  },
});
