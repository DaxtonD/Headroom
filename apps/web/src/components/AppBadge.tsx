/**
 * Keeps the number on the app icon in step with the ledger.
 *
 * A component rather than a hook called from `App`, for one practical
 * reason: it has to be inside the signed-in branch. Reading the dashboard
 * above that would fire a request on the sign-in screen and get a 401 for
 * its trouble, and hooks cannot be called after an early return.
 *
 * It renders nothing. Subscribing to the dashboard query from here costs no
 * extra request - it is the same query the ledger uses, and TanStack Query
 * serves both from one fetch - but it does mean the badge stays current
 * while somebody is on Budget or Savings, which is the point of a badge.
 */
import { useEffect } from "react";
import { setAppBadge } from "../lib/appBadge.js";
import { useDashboard } from "../lib/queries.js";

export function AppBadge(): null {
  const dashboard = useDashboard();
  const estimates = dashboard.data?.estimatesCount;

  useEffect(() => {
    // Undefined means "not loaded yet", which is not the same as zero.
    // Clearing the badge on every cold start would make it flicker off and
    // back on, and offline it would simply be wrong.
    if (estimates === undefined) return;
    void setAppBadge(estimates);
  }, [estimates]);

  return null;
}
