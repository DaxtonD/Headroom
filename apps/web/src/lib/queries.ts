/**
 * The data layer for the ledger: the balance, every event with its running
 * balance, and the two-week windows they fall into.
 *
 * Amounts arrive as decimal strings and are turned into `bigint` cents here,
 * at the edge, so no component ever handles money as a `number`.
 *
 * Writes are online-only and never retried (HANDOFF section 16.2 rule 2):
 * replaying a stale edit to money later is the exact failure this design
 * exists to prevent, so there is no write queue and no Background Sync.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cents } from "@headroom/core";
import { ApiError, api, newIdempotencyKey } from "./api.js";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

interface PersonWire {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
}

interface LowestWire {
  readonly cents: string;
  readonly afterEventId: string | null;
  readonly date: string | null;
}

interface ShortfallWire {
  readonly eventId: string;
  readonly name: string;
  readonly date: string | null;
  readonly shortCents: string;
  readonly runningCents: string;
}

interface DashboardWire {
  readonly today: string;
  readonly horizonEnd: string;
  readonly cushionCents: string;
  readonly balance: {
    readonly cents: string;
    readonly snapshotCents: string;
    readonly asOf: string | null;
    readonly enteredBy: PersonWire | null;
  };
  readonly safeToSpendNowCents: string;
  readonly leftThisCycleCents: string;
  readonly lowest: LowestWire;
  readonly coverage: {
    readonly autoWithdrawalCount: number;
    readonly allCovered: boolean;
    readonly firstShortfall: ShortfallWire | null;
  };
  readonly estimatesCount: number;
  readonly nextAutoWithdrawals: readonly {
    readonly id: string;
    readonly name: string;
    readonly cents: string;
    readonly date: string | null;
    readonly balanceAfterCents: string;
    readonly verified: boolean;
    readonly verifiedBy: PersonWire | null;
    readonly paid: boolean;
    readonly owner: PersonWire | null;
    readonly version: number;
  }[];
}

interface TimelineRowWire {
  readonly id: string;
  readonly name: string;
  readonly cents: string;
  readonly kind: "paycheque" | "bill" | "deposit" | "transfer";
  readonly placement: "auto" | "flexible";
  readonly date: string | null;
  readonly isDated: boolean;
  readonly anchorOccurrenceId: string | null;
  readonly isOneOff: boolean;
  readonly verified: boolean;
  readonly verifiedBy: PersonWire | null;
  readonly verifiedAt: string | null;
  readonly paid: boolean;
  readonly paidBy: PersonWire | null;
  readonly owner: PersonWire | null;
  readonly requiresCoverage: boolean;
  readonly runningCents: string;
  readonly version: number;
  readonly fromTemplate: boolean;
}

/* -------------------------------------------------------------------------- */
/* Parsed shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface Lowest {
  readonly cents: Cents;
  readonly afterEventId: string | null;
  readonly date: string | null;
}

export interface Shortfall {
  readonly eventId: string;
  readonly name: string;
  readonly date: string | null;
  readonly shortCents: Cents;
  readonly runningCents: Cents;
}

export interface Coverage {
  readonly autoWithdrawalCount: number;
  readonly allCovered: boolean;
  readonly firstShortfall: Shortfall | null;
}

export interface Dashboard {
  readonly today: string;
  readonly horizonEnd: string;
  readonly cushionCents: Cents;
  readonly balance: {
    readonly cents: Cents;
    readonly snapshotCents: Cents;
    readonly asOf: Date | null;
    readonly enteredBy: PersonWire | null;
  };
  readonly safeToSpendNowCents: Cents;
  readonly leftThisCycleCents: Cents;
  readonly lowest: Lowest;
  readonly coverage: Coverage;
  readonly estimatesCount: number;
  readonly nextAutoWithdrawals: readonly {
    readonly id: string;
    readonly name: string;
    readonly cents: Cents;
    readonly date: string | null;
    readonly balanceAfterCents: Cents;
    readonly verified: boolean;
    readonly verifiedBy: PersonWire | null;
    readonly paid: boolean;
    readonly owner: PersonWire | null;
    readonly version: number;
  }[];
}

export interface TimelineRow {
  readonly id: string;
  readonly name: string;
  readonly cents: Cents;
  readonly kind: TimelineRowWire["kind"];
  readonly placement: "auto" | "flexible";
  readonly date: string | null;
  readonly isDated: boolean;
  readonly anchorOccurrenceId: string | null;
  readonly isOneOff: boolean;
  readonly verified: boolean;
  readonly verifiedBy: PersonWire | null;
  /** Ticked as dealt with. A marker only: it moves no figure. */
  readonly paid: boolean;
  readonly paidBy: PersonWire | null;
  readonly owner: PersonWire | null;
  readonly requiresCoverage: boolean;
  readonly runningCents: Cents;
  readonly version: number;
}

/** A cheque a window counts but which is not on the timeline yet. */
export interface ProjectedPaycheque {
  readonly scheduleId: string;
  readonly date: string;
  readonly cents: Cents;
  readonly owner: PersonWire | null;
}

export interface PayPeriod {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly isCurrentPartial: boolean;
  readonly inCents: Cents;
  readonly autoCents: Cents;
  readonly flexibleCents: Cents;
  readonly leftCents: Cents;
  /**
   * What could go into savings out of this window.
   *
   * The same computation as "safe to spend now", asked at a later point on the
   * timeline, so it already accounts for everything that comes out after it.
   */
  readonly roomToSaveCents: Cents;
  readonly lowest: { readonly cents: Cents; readonly date: string | null } | null;
  readonly allAutoCovered: boolean;
  /** Grouped by the server, so the engine stays the authority on membership. */
  readonly rows: readonly TimelineRow[];
  readonly projectedPaycheques: readonly ProjectedPaycheque[];
}

/** Cents cross the wire as a decimal string, because JSON has no bigint. */
function toCents(value: string): Cents {
  return BigInt(value);
}

function parseLowest(wire: LowestWire): Lowest {
  return { cents: toCents(wire.cents), afterEventId: wire.afterEventId, date: wire.date };
}

function parseCoverage(wire: DashboardWire["coverage"]): Coverage {
  return {
    autoWithdrawalCount: wire.autoWithdrawalCount,
    allCovered: wire.allCovered,
    firstShortfall: wire.firstShortfall
      ? {
          ...wire.firstShortfall,
          shortCents: toCents(wire.firstShortfall.shortCents),
          runningCents: toCents(wire.firstShortfall.runningCents),
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function parseTimelineRow(row: TimelineRowWire): TimelineRow {
  return {
    ...row,
    cents: toCents(row.cents),
    runningCents: toCents(row.runningCents),
  };
}

export const dashboardKey = ["dashboard"] as const;
export const payPeriodsKey = ["pay-periods"] as const;

export function useDashboard() {
  return useQuery({
    queryKey: dashboardKey,
    queryFn: async (): Promise<Dashboard> => {
      const wire = await api.get<DashboardWire>("/api/dashboard");
      return {
        ...wire,
        cushionCents: toCents(wire.cushionCents),
        balance: {
          cents: toCents(wire.balance.cents),
          snapshotCents: toCents(wire.balance.snapshotCents),
          asOf: wire.balance.asOf ? new Date(wire.balance.asOf) : null,
          enteredBy: wire.balance.enteredBy,
        },
        safeToSpendNowCents: toCents(wire.safeToSpendNowCents),
        leftThisCycleCents: toCents(wire.leftThisCycleCents),
        lowest: parseLowest(wire.lowest),
        coverage: parseCoverage(wire.coverage),
        nextAutoWithdrawals: wire.nextAutoWithdrawals.map((row) => ({
          ...row,
          cents: toCents(row.cents),
          balanceAfterCents: toCents(row.balanceAfterCents),
        })),
      };
    },
  });
}

/*
 * There is deliberately no `useTimeline` any more.
 *
 * The ledger reads `/api/pay-periods`, which now carries every timeline row
 * grouped into the window that pays for it - the engine publishes the
 * membership, so nothing is lost between the two. A second hook fetching the
 * same rows ungrouped would be a second copy of the screen's data with its own
 * staleness.
 *
 * `/api/timeline` itself is still served: the API tests use it as the engine's
 * HTTP contract, and it is the obvious endpoint for a flat export later.
 */

interface PayPeriodWire {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly isCurrentPartial: boolean;
  readonly inCents: string;
  readonly autoCents: string;
  readonly flexibleCents: string;
  readonly leftCents: string;
  readonly roomToSaveCents: string;
  readonly lowest: { readonly cents: string; readonly date: string | null } | null;
  readonly allAutoCovered: boolean;
  readonly rows: readonly TimelineRowWire[];
  readonly projectedPaycheques: readonly {
    readonly scheduleId: string;
    readonly date: string;
    readonly cents: string;
    readonly owner: PersonWire | null;
  }[];
}

export function usePayPeriods() {
  return useQuery({
    queryKey: payPeriodsKey,
    queryFn: async (): Promise<{
      today: string;
      horizonEnd: string;
      periods: readonly PayPeriod[];
    }> => {
      const wire = await api.get<{
        today: string;
        horizonEnd: string;
        periods: readonly PayPeriodWire[];
      }>("/api/pay-periods");

      return {
        today: wire.today,
        horizonEnd: wire.horizonEnd,
        periods: wire.periods.map((period) => ({
          label: period.label,
          start: period.start,
          end: period.end,
          isCurrentPartial: period.isCurrentPartial,
          inCents: toCents(period.inCents),
          autoCents: toCents(period.autoCents),
          flexibleCents: toCents(period.flexibleCents),
          leftCents: toCents(period.leftCents),
          roomToSaveCents: toCents(period.roomToSaveCents),
          lowest: period.lowest
            ? { cents: toCents(period.lowest.cents), date: period.lowest.date }
            : null,
          allAutoCovered: period.allAutoCovered,
          rows: period.rows.map(parseTimelineRow),
          projectedPaycheques: period.projectedPaycheques.map((cheque) => ({
            ...cheque,
            cents: toCents(cheque.cents),
          })),
        })),
      };
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything a figure could have changed, so one call refreshes the lot. */
function invalidateMoney(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: dashboardKey }),
    queryClient.invalidateQueries({ queryKey: payPeriodsKey }),
  ]).then(() => undefined);
}

/** The fields a user can change on a row. Only what they touched is sent. */
export interface OccurrenceChange {
  readonly cents?: string;
  readonly name?: string;
  readonly verified?: boolean;
  /**
   * "We have dealt with this." A tick: the row stays on the ledger and goes on
   * being counted, and no figure moves. Whether the money has left is answered
   * by the balance typed in off the bank.
   */
  readonly paid?: boolean;
  /**
   * "This is already inside the balance that was typed in."
   *
   * Sent only by the balance-update sheet. It used to be reachable from a row
   * on the ledger, which is how a bill could be subtracted twice: once inside
   * the figure read off the bank and once again by marking it paid.
   */
  readonly cleared?: boolean;
  readonly anchorOccurrenceId?: string | null;
  readonly sortIndex?: number;
  readonly ownerUserId?: string | null;
  /**
   * When a flexible item is planned for. Null takes the plan away and hangs it
   * back on a payday instead.
   */
  readonly date?: string | null;
}

export interface ConflictInfo {
  readonly changedFields: readonly string[];
  readonly changedBy: PersonWire;
  readonly changedAt: string;
  readonly current: Record<string, unknown> & { version: number };
  readonly message: string;
}

/** A 409 carries everything the UI needs to offer a choice. */
export function conflictFrom(error: unknown): ConflictInfo | null {
  if (!(error instanceof ApiError) || !error.isConflict) return null;
  const body = error.body as Partial<ConflictInfo> | undefined;
  if (!body?.current || !body.changedBy) return null;

  return {
    changedFields: body.changedFields ?? [],
    changedBy: body.changedBy,
    changedAt: body.changedAt ?? new Date().toISOString(),
    current: body.current as ConflictInfo["current"],
    message: error.message,
  };
}

export function usePatchOccurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      baseVersion: number;
      changes: OccurrenceChange;
      /**
       * Reused across retries of ONE user action. Generated when Save is
       * tapped, so a double tap cannot apply the change twice.
       */
      idempotencyKey?: string;
    }) =>
      api.patch<{ occurrence: { version: number }; merged: boolean; noop: boolean }>(
        `/api/occurrences/${input.id}`,
        input.changes,
        {
          baseVersion: input.baseVersion,
          idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(),
        },
      ),
    onSuccess: () => invalidateMoney(queryClient),
  });
}

export function useCreateOneOff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      cents: string;
      kind?: "bill" | "deposit" | "transfer";
      date?: string;
      anchorOccurrenceId?: string | null;
      idempotencyKey?: string;
    }) => {
      const { idempotencyKey, ...body } = input;
      return api.post<{ occurrence: { id: string } }>("/api/occurrences", body, {
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      });
    },
    onSuccess: () => invalidateMoney(queryClient),
  });
}

/**
 * Remove a one-off.
 *
 * Only a one-off can go: a generated row belongs to its bill. Marking a row
 * cleared is a different statement - that it happened - so a mistyped row
 * needs this.
 */
export function useRemoveOneOff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number; idempotencyKey?: string }) =>
      api.delete(`/api/occurrences/${input.id}`, {
        baseVersion: input.version,
        idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(),
      }),
    onSuccess: () => invalidateMoney(queryClient),
  });
}

export function useUpdateBalance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      cents: string;
      clearedOccurrenceIds?: readonly string[];
      idempotencyKey?: string;
    }) => {
      const { idempotencyKey, ...body } = input;
      return api.post<{ snapshot: { id: string }; clearedCount: number }>("/api/balance", body, {
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      });
    },
    onSuccess: () => invalidateMoney(queryClient),
  });
}

export interface ClearableCandidate {
  readonly id: string;
  readonly name: string;
  readonly cents: Cents;
  readonly date: string | null;
  /** Already ticked as dealt with, so the sheet can tick it for them. */
  readonly paid: boolean;
}

/** "Did any of these clear since the last update?" (HANDOFF section 6.1) */
export function useClearableCandidates(enabled: boolean) {
  return useQuery({
    queryKey: ["balance", "clearable"],
    enabled,
    queryFn: async (): Promise<{ currentCents: Cents; candidates: readonly ClearableCandidate[] }> => {
      const wire = await api.get<{
        currentCents: string;
        candidates: readonly {
          id: string;
          name: string;
          cents: string;
          date: string | null;
          paid: boolean;
        }[];
      }>("/api/balance/clearable");

      return {
        currentCents: toCents(wire.currentCents),
        candidates: wire.candidates.map((candidate) => ({
          ...candidate,
          cents: toCents(candidate.cents),
        })),
      };
    },
  });
}
