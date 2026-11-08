/**
 * Staying fresh (HANDOFF section 16.2).
 *
 * Three things keep the numbers current, and all three matter:
 *
 *  1. Server-Sent Events: the other phone's change arrives as a ping and the
 *     affected queries refetch. No polling.
 *  2. Coming back to the app: `visibilitychange`, focus and `online` all
 *     trigger a refetch, because a phone that was asleep heard nothing.
 *  3. Offline: editing is disabled and the cached figures are labelled with
 *     when they were last true. Writes are online-only (rule 2), so there is
 *     no queue to drain and nothing stale is ever replayed.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { billsKey, categoriesKey, setupKey } from "./manageQueries.js";
import { budgetKey, goalsKey, netWorthKey, yearKey } from "./plannerQueries.js";
import { dashboardKey, payPeriodsKey } from "./queries.js";
import { savingsKey } from "./savingsQueries.js";

/**
 * The money screens, which a ping almost always concerns.
 */
const MONEY_KEYS = [dashboardKey, payPeriodsKey] as const;

/**
 * Everything else a change could have touched.
 *
 * The ping carries only an entity name, never an amount, so the client has to
 * refetch through the authenticated API anyway. It used to act on three entity
 * names and ignore every other one, which meant an earmark, a bill, a budget
 * line or a mortgage edited on one phone did not appear on the other until a
 * reload - silently, because nothing was broken, just stale.
 *
 * Refetching the lot is cheaper than that bug and needs no table of entity
 * names to keep in step: TanStack only refetches queries that are actually
 * mounted, so on Home this costs three requests and on Savings it costs one.
 */
const ALL_KEYS = [
  ...MONEY_KEYS,
  setupKey,
  billsKey,
  categoriesKey,
  budgetKey,
  goalsKey,
  netWorthKey,
  savingsKey,
  yearKey,
] as const;

export interface LiveStatus {
  /** The browser believes it has a connection. */
  readonly online: boolean;
  /** The event stream is connected, so another device's change arrives at once. */
  readonly streaming: boolean;
  /** When the figures on screen were last confirmed by the server. */
  readonly lastSyncedAt: Date | null;
}

/**
 * Subscribe to the server's change stream and keep the cache honest.
 *
 * `enabled` is false until someone is signed in: there is nothing to listen
 * to, and an unauthenticated EventSource would reconnect forever.
 */
export function useLiveUpdates(enabled: boolean): LiveStatus {
  const queryClient = useQueryClient();

  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [streaming, setStreaming] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  // ---- Connection state ---------------------------------------------------
  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => {
      setOnline(false);
      // The stream is certainly gone; say so before the browser tells us.
      setStreaming(false);
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // ---- Refetch when the app comes back into view --------------------------
  useEffect(() => {
    if (!enabled) return;

    const refresh = (): void => {
      if (document.visibilityState !== "visible") return;
      // Coming back after the phone was asleep: anything could have changed.
      for (const key of ALL_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    };

    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [enabled, queryClient]);

  // ---- The event stream ---------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    // EventSource reconnects on its own with its own backoff, so there is no
    // retry loop to write here.
    const source = new EventSource("/api/events", { withCredentials: true });

    const onReady = (): void => {
      setStreaming(true);
      setLastSyncedAt(new Date());
    };

    // The payload is deliberately not read: it carries only an entity name and
    // a version, never an amount, so there is nothing in it worth acting on
    // that a refetch does not settle more reliably.
    const onChanged = (): void => {
      setLastSyncedAt(new Date());
      for (const key of ALL_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    };

    const onError = (): void => {
      // EventSource will retry; this only drives the "updating…" label.
      setStreaming(false);
    };

    source.addEventListener("ready", onReady);
    source.addEventListener("changed", onChanged);
    source.addEventListener("error", onError);

    return () => {
      source.removeEventListener("ready", onReady);
      source.removeEventListener("changed", onChanged);
      source.removeEventListener("error", onError);
      source.close();
      setStreaming(false);
    };
  }, [enabled, queryClient]);

  return { online, streaming, lastSyncedAt };
}
