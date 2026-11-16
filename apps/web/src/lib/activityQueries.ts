/**
 * The activity log.
 *
 * The server sends rows, not sentences. `@headroom/core` turns one into the
 * other, and the same function words the push notification on the server, so
 * the line in the log and the line on the lock screen cannot drift apart.
 *
 * Paged by the timestamp of the oldest row held rather than by an offset:
 * with two people editing at once, new activity arrives at the top between
 * one page and the next, and an offset would quietly skip rows.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ActivityAction, ActivityEvent } from "@headroom/core";
import { api } from "./api.js";

export const activityKey = ["activity"] as const;

export interface ActivityPerson {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly colorFg: string;
  readonly colorBg: string;
}

/** One line of the log. Satisfies `ActivityEvent`, so core can word it. */
export interface ActivityEntry extends ActivityEvent {
  readonly id: string;
  /** ISO instant. The server clock is authoritative. */
  readonly at: string;
  readonly entityId: string;
  readonly by: ActivityPerson;
}

interface WireEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly label: string | null;
  readonly labelKind: string | null;
  readonly fields: readonly string[];
  readonly after: Record<string, unknown> | null;
  readonly by: ActivityPerson;
}

interface WirePage {
  readonly entries: readonly WireEntry[];
  /** Null when this is the last page. */
  readonly nextBefore?: string | null;
}

export interface ActivityPage {
  readonly entries: readonly ActivityEntry[];
  readonly nextBefore: string | null;
}

/**
 * Actions this build knows how to word.
 *
 * An unknown one is not a crash: the server may be a build ahead, which this
 * app has now been more than once. It falls through to "updated", which is
 * true of everything here.
 */
const KNOWN: ReadonlySet<string> = new Set([
  "create", "update", "verify", "unverify", "clear",
  "unclear", "move", "soft_delete", "restore", "snapshot",
]);

function toEntry(wire: WireEntry): ActivityEntry {
  return {
    id: wire.id,
    at: wire.at,
    action: (KNOWN.has(wire.action) ? wire.action : "update") as ActivityAction,
    entity: wire.entity,
    entityId: wire.entityId,
    label: wire.label,
    labelKind: wire.labelKind,
    fields: wire.fields ?? [],
    after: wire.after,
    by: wire.by,
  };
}

const PAGE = 40;

export function useActivity(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: activityKey,
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ActivityPage> => {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam !== null) query.set("before", pageParam);
      const wire = await api.get<WirePage>(`/api/activity?${query.toString()}`);
      return {
        entries: (wire.entries ?? []).map(toEntry),
        nextBefore: wire.nextBefore ?? null,
      };
    },
    getNextPageParam: (last) => last.nextBefore,
    // The log is history: it does not go stale the way a balance does, and
    // the live-update ping invalidates it when something actually happens.
    staleTime: 60_000,
  });
}
