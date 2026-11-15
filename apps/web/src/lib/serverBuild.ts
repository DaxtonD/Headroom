/**
 * What build the server is serving, and how to get onto it.
 *
 * This is the escape hatch for a service worker that will not update. The
 * update bar the app already has depends on the service worker lifecycle
 * noticing a new worker and telling React about it; when that chain does not
 * fire, the app sits on an old bundle indefinitely and says nothing. It
 * happened, on a deployed install, and from the inside it was invisible.
 *
 * So this asks a question that does not go through the service worker at all:
 * what build does the server say it is? `/api/health` is unauthenticated and
 * is explicitly excluded from the service worker's navigation fallback, so
 * the answer comes from the network or not at all.
 */
import { useEffect, useState } from "react";
import { BUILD_ID, isStaleBuild } from "./buildId.js";

/** Cache-busted, because the whole point is to not be told what we had. */
async function fetchServerBuild(): Promise<string | null> {
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { buildId?: unknown };
    return typeof body.buildId === "string" ? body.buildId : null;
  } catch {
    // Offline, or the server is down. Neither says anything about staleness.
    return null;
  }
}

export interface ServerBuild {
  /** What the server reports, once known. */
  readonly serverBuild: string | null;
  /** The app is definitely running a build the server is no longer serving. */
  readonly stale: boolean;
  /** Ask again now. */
  readonly recheck: () => void;
}

export function useServerBuild(): ServerBuild {
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const ask = (): void => {
      void fetchServerBuild().then((value) => {
        if (!cancelled && value !== null) setServerBuild(value);
      });
    };

    ask();

    // Reopening the app is the moment worth checking, and for this household
    // that is several times a day.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") ask();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [asked]);

  return {
    serverBuild,
    stale: serverBuild !== null && isStaleBuild(BUILD_ID, serverBuild),
    recheck: () => setAsked((count) => count + 1),
  };
}

/**
 * Get onto the build the server is serving, whatever the worker is doing.
 *
 * Tries the polite route first: a waiting worker is told to take over, which
 * is the same thing the update bar does. If there is no waiting worker then
 * the lifecycle is not cooperating, and the registration is removed outright
 * so the next load has to come from the network. The precache is rebuilt
 * immediately afterwards, so the cost is one online load.
 *
 * Always ends in a reload, including when none of it worked, because a reload
 * is what the person asked for.
 */
export async function loadServerBuild(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();

      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await registration.update();
          } catch {
            // An update check that fails is exactly the case this is for.
          }
        }),
      );

      const waiting = registrations.find((registration) => registration.waiting)?.waiting;
      if (waiting) {
        waiting.postMessage({ type: "SKIP_WAITING" });
      } else {
        await Promise.all(
          registrations.map(async (registration) => {
            try {
              await registration.unregister();
            } catch {
              // Then the reload below is the only move left.
            }
          }),
        );
      }
    }
  } finally {
    window.location.reload();
  }
}
