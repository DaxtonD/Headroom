import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The PWA plugin arrives in M5, together with the icons, the manifest and the
 * offline read-only cache. Writes are online-only and there is deliberately no
 * Background Sync (HANDOFF section 16.2 rule 2).
 */
export default defineConfig({
  plugins: [react()],
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
