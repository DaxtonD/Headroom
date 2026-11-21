/**
 * Fetching the other tabs before they are opened.
 *
 * Reported from use on 2026-11-21: "often, when I click on a tab the UI gets
 * stuck... like it's waiting for the data to load before it's displayed."
 * That is precisely what it was doing. Every screen in this app gates its
 * first render on `isPending`, which is correct - a budget page drawn before
 * the budget has arrived would be a page of zeroes, and a page of zeroes about
 * money is worse than a page that is honestly not ready yet.
 *
 * Two things were making that wait happen far more often than it had to.
 *
 * The first was the cache being emptied five minutes after a screen was left,
 * which is TanStack's default and is dealt with in `main.tsx`. The second is
 * this one: the FIRST visit to each tab in a session has nothing to show
 * whatever the cache keeps, because nothing has ever asked. So the four tab
 * screens are fetched once, quietly, while the app is doing nothing - and by
 * the time a tab is pressed the answer is usually already in hand.
 *
 * ## Why it is safe to do this unasked
 *
 * These are four GETs the app would make anyway, against a server on the same
 * network as the phone, and they are all reads of the household's own data by
 * somebody already signed in. Nothing is written and nothing is sent.
 *
 * ## Why it waits
 *
 * `requestIdleCallback` after the ledger's own two reads, because the one
 * thing this must never do is make the screen somebody IS looking at slower.
 * The ledger is what opens several times a day and what the brief asks to be
 * instant; four speculative requests ahead of it would be exactly the wrong
 * trade. Where there is no `requestIdleCallback` - Safari was late to it - a
 * timeout does the same job a little less precisely.
 *
 * `prefetchQuery` and not `fetchQuery`: it leaves an already-fresh entry
 * alone and it never throws, so a tab that happens to be offline or fails
 * costs nothing and says nothing. The screen itself will report its own
 * failure if it is ever opened on one.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { billsOptions, setupOptions } from "./manageQueries.js";
import { budgetOptions, yearOptions } from "./plannerQueries.js";
import { savingsOptions } from "./savingsQueries.js";

/** Milliseconds to wait where the browser cannot say when it is idle. */
const FALLBACK_DELAY_MS = 1_500;

/** How long to let the browser hold off before insisting. */
const IDLE_TIMEOUT_MS = 4_000;

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Run something once the browser is not busy.
 *
 * Returns the way to cancel it, so a sign-out or a reload part-way through
 * does not leave a callback holding a dead query client.
 */
function whenIdle(task: () => void): () => void {
  const idle = window as unknown as IdleWindow;

  if (typeof idle.requestIdleCallback === "function") {
    const handle = idle.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
    return () => idle.cancelIdleCallback?.(handle);
  }

  const timer = window.setTimeout(task, FALLBACK_DELAY_MS);
  return () => {
    window.clearTimeout(timer);
  };
}

/**
 * Warm the four tab screens once per sign-in. Mounted once, in `App`.
 *
 * `enabled` is false until somebody is signed in, because every one of these
 * would come back 401 and the retry rule would correctly not try again.
 */
export function useWarmTabs(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    // A phone with no connection has nothing to warm, and the reads would
    // only fail. Coming back online refetches what is mounted anyway, and
    // the next sign-in or reload warms the rest.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    return whenIdle(() => {
      /*
       * One call each rather than a loop over an array of them: each of these
       * options objects has its own key and its own result type, and putting
       * five of them in one array collapses both into a union that
       * `prefetchQuery` will not take.
       */
      void queryClient.prefetchQuery(budgetOptions());
      void queryClient.prefetchQuery(yearOptions());
      void queryClient.prefetchQuery(savingsOptions());
      void queryClient.prefetchQuery(setupOptions());
      void queryClient.prefetchQuery(billsOptions());
    });
  }, [enabled, queryClient]);
}
