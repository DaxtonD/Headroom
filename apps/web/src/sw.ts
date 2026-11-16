/// <reference lib="WebWorker" />
/**
 * The service worker.
 *
 * Written out by hand rather than generated, because a generated one cannot
 * receive a push. Everything above the push handler is a faithful
 * reproduction of what `generateSW` was producing from `vite.config.ts` -
 * same precache, same navigation fallback, same font caching, same refusal
 * to activate itself - and the comments explaining each choice have moved
 * here with the code.
 *
 * ## It still does not take over on its own
 *
 * `skipWaiting()` is called only when the page asks, and `clients.claim()` is
 * never called. A new build must not swap itself in under somebody halfway
 * through typing a balance. That has been the rule since M5 and a push
 * handler is no reason to change it.
 *
 * ## Why it had to stop being generated
 *
 * Workbox's `generateSW` writes the whole file, so there is nowhere to add a
 * `push` listener. `injectManifest` hands this file the list of precached
 * assets and otherwise leaves it alone. The cost is that the four behaviours
 * below are now ours to keep working, which is what `apps/web/test/sw.test.ts`
 * is for.
 */
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import type { PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & {
  /** Injected at build time by `injectManifest`. */
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

/* -------------------------------------------------------------------------- */
/* Updating: only when asked                                                  */
/* -------------------------------------------------------------------------- */

/*
 * A new worker waits until the page tells it to take over. Everything else in
 * this app follows the rule that nothing about the household's money happens
 * without them saying so, and a page that reloads itself mid-edit breaks it.
 */
/** Stamped in at build time, the same value the page and the API carry. */
const BUILD_ID: string = String(import.meta.env.VITE_BUILD_ID ?? "dev") || "dev";

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: unknown } | null;
  if (!data) return;

  if (data.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }

  /*
   * "Which worker is actually running, and can it receive a push?"
   *
   * A push subscription belongs to the service worker *registration*, but a
   * push is delivered to whichever worker is **active**. A browser still
   * running a worker from before this file existed accepts the subscription
   * quite happily and then has no `push` listener to receive anything - the
   * server sends, the push service accepts, and nothing appears. There is
   * no way to tell that apart from a dozen other causes by looking.
   *
   * So the worker answers for itself. A reply means a worker new enough to
   * have this handler, which is the same generation that has the push one.
   * Silence means an older worker is still in charge, and the cure is the
   * ordinary one: get fully onto the new build.
   */
  if (data.type === "WHICH_BUILD") {
    const port = event.ports[0];
    if (port) port.postMessage({ type: "BUILD", buildId: BUILD_ID, canPush: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The shell, cached                                                          */
/* -------------------------------------------------------------------------- */

precacheAndRoute(self.__WB_MANIFEST);

// A worker left behind by an older build must not keep serving it.
cleanupOutdatedCaches();

/*
 * Every route is the same HTML document, so a cold start on /manage has to be
 * served it. `/api` is excluded: a request for data must reach the server or
 * fail honestly, never be answered with a page. That exclusion is also what
 * lets the app ask `/api/health` which build the server is running when the
 * worker itself is the thing that has gone wrong.
 */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//],
  }),
);

// The webfont stylesheet changes rarely and blocks first paint.
registerRoute(
  /^https:\/\/fonts\.googleapis\.com\//,
  new StaleWhileRevalidate({ cacheName: "google-fonts-stylesheets" }),
);

// The font files themselves never change under a given URL.
registerRoute(
  /^https:\/\/fonts\.gstatic\.com\//,
  new CacheFirst({
    cacheName: "google-fonts-files",
    plugins: [
      new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

interface Note {
  /** The sentence. Never an amount - see `packages/core/src/activity.ts`. */
  readonly body: string;
  /** Where tapping it should land. */
  readonly url: string;
  /** Collapses older notifications about the same thing. */
  readonly tag?: string;
}

/**
 * What to show when the payload cannot be read.
 *
 * A push that arrives and shows nothing is worse than useless on Android:
 * the browser shows its own "This site has been updated in the background"
 * instead, which is both alarming and uninformative. So there is always
 * something to show, even if all we know is that something happened.
 */
const FALLBACK: Note = { body: "Something changed in Headroom.", url: "/" };

function readNote(event: PushEvent): Note {
  try {
    const raw = event.data?.json() as Partial<Note> | null;
    if (raw && typeof raw.body === "string" && raw.body !== "") {
      return {
        body: raw.body,
        url: typeof raw.url === "string" && raw.url.startsWith("/") ? raw.url : "/",
        ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
      };
    }
  } catch {
    // Not JSON, or no payload at all. Both end up at the fallback.
  }
  return FALLBACK;
}

self.addEventListener("push", (event: PushEvent) => {
  const note = readNote(event);

  event.waitUntil(
    self.registration.showNotification("Headroom", {
      body: note.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Same tag replaces rather than stacks: three balance corrections in a
      // row are one piece of news, not three.
      ...(note.tag === undefined ? {} : { tag: note.tag }),
      data: { url: note.url },
      /*
       * No sound or vibration asked for beyond the system default, and not
       * `requireInteraction`: a notification that will not go away until it
       * is dealt with is the wrong tone for "the balance was updated".
       */
    }),
  );
});

/**
 * Tapping it opens the app where the thing happened.
 *
 * An already-open window is focused and navigated rather than a second one
 * being opened, which on Android is the difference between going back to the
 * app and ending up with two of it.
 */
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const data = event.notification.data as { url?: unknown } | null;
  const path = data && typeof data.url === "string" ? data.url : "/";
  const target = new URL(path, self.location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      for (const client of windows) {
        if (new URL(client.url).origin !== target.origin) continue;
        await client.focus();
        // `navigate` is not available on every client; focusing is the part
        // that matters, and landing on the right screen is a bonus.
        if ("navigate" in client) await client.navigate(target.href).catch(() => undefined);
        return;
      }

      await self.clients.openWindow(target.href);
    })(),
  );
});
