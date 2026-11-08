/**
 * Data for the Manage screen: setting the household up and keeping it current.
 *
 * This is where expenses, paydays, goals, what you own and owe, and the
 * settings that change every calculation are entered and maintained.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cents } from "@headroom/core";
import { api, newIdempotencyKey } from "./api.js";
import { budgetKey, goalsKey, netWorthKey } from "./plannerQueries.js";
import { dashboardKey, payPeriodsKey, timelineKey } from "./queries.js";

const toCents = (value: string): Cents => BigInt(value);

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type ScheduleSpec =
  | { readonly type: "monthly"; readonly day: number }
  | { readonly type: "monthly_last" }
  | { readonly type: "relative_to_pay"; readonly payScheduleId: string; readonly offsetDays: number }
  | { readonly type: "biweekly"; readonly payScheduleId: string }
  | { readonly type: "flexible"; readonly frequency: "monthly" | "per_pay_period" };

export interface Bill {
  readonly id: string;
  readonly name: string;
  readonly kind: "paycheque" | "bill" | "deposit" | "transfer";
  readonly defaultCents: Cents;
  readonly withdrawal: "auto" | "flexible";
  readonly schedule: ScheduleSpec;
  readonly ownerUserId: string | null;
  readonly section: "income" | "fixed" | "variable" | null;
  readonly monthlyBudgetOverrideCents: Cents | null;
  readonly active: boolean;
  readonly version: number;
}

export interface PayScheduleEntry {
  readonly id: string;
  readonly userId: string;
  readonly user: { readonly id: string; readonly name: string; readonly initial: string } | null;
  readonly anchorDate: string;
  readonly defaultCents: Cents;
  readonly version: number;
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly colorFg: string;
  readonly colorBg: string;
}

export interface HouseholdSettings {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly cushionCents: Cents;
  readonly horizonPaychequeCount: number;
  readonly weekendWithdrawalRule: "as_scheduled" | "friday_before" | "next_business_day";
  readonly netMonthlyIncomeCents: Cents;
  readonly netYearlyIncomeCents: Cents;
  readonly version: number;
}

export interface Setup {
  readonly household: HouseholdSettings;
  readonly members: readonly Member[];
  readonly paySchedules: readonly PayScheduleEntry[];
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  /** What still has to be filled in before everything works properly. */
  readonly missing: readonly string[];
}

export const setupKey = ["setup"] as const;
export const billsKey = ["templates"] as const;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function useSetup() {
  return useQuery({
    queryKey: setupKey,
    queryFn: async (): Promise<Setup> => {
      const wire = await api.get<{
        household: Record<string, string | number>;
        members: Member[];
        paySchedules: (Omit<PayScheduleEntry, "defaultCents"> & { defaultCents: string })[];
        accounts: { id: string; name: string }[];
        missing: string[];
      }>("/api/setup");

      return {
        household: {
          id: String(wire.household["id"]),
          name: String(wire.household["name"]),
          timezone: String(wire.household["timezone"]),
          cushionCents: toCents(String(wire.household["cushionCents"])),
          horizonPaychequeCount: Number(wire.household["horizonPaychequeCount"]),
          weekendWithdrawalRule: String(
            wire.household["weekendWithdrawalRule"],
          ) as HouseholdSettings["weekendWithdrawalRule"],
          netMonthlyIncomeCents: toCents(String(wire.household["netMonthlyIncomeCents"])),
          netYearlyIncomeCents: toCents(String(wire.household["netYearlyIncomeCents"])),
          version: Number(wire.household["version"]),
        },
        members: wire.members,
        paySchedules: wire.paySchedules.map((schedule) => ({
          ...schedule,
          defaultCents: toCents(schedule.defaultCents),
        })),
        accounts: wire.accounts,
        missing: wire.missing,
      };
    },
  });
}

export function useBills() {
  return useQuery({
    queryKey: billsKey,
    queryFn: async (): Promise<readonly Bill[]> => {
      const wire = await api.get<{
        templates: (Omit<Bill, "defaultCents" | "monthlyBudgetOverrideCents" | "schedule"> & {
          defaultCents: string;
          monthlyBudgetOverrideCents: string | null;
          schedule: ScheduleSpec;
        })[];
      }>("/api/templates");

      return wire.templates.map((template) => ({
        ...template,
        defaultCents: toCents(template.defaultCents),
        monthlyBudgetOverrideCents:
          template.monthlyBudgetOverrideCents === null
            ? null
            : toCents(template.monthlyBudgetOverrideCents),
      }));
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Setting anything up changes what every screen shows, so all of it is
 * invalidated together rather than trying to be clever about which.
 */
function invalidateEverything(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return Promise.all(
    [setupKey, billsKey, budgetKey, goalsKey, netWorthKey, dashboardKey, timelineKey, payPeriodsKey].map(
      (key) => queryClient.invalidateQueries({ queryKey: key }),
    ),
  ).then(() => undefined);
}

export interface BillInput {
  readonly name: string;
  readonly kind: Bill["kind"];
  /** Integer cents, as a string. */
  readonly defaultCents: string;
  readonly withdrawal: "auto" | "flexible";
  readonly schedule: ScheduleSpec;
  readonly section?: "income" | "fixed" | "variable" | null;
  readonly ownerUserId?: string | null;
  readonly monthlyBudgetOverrideCents?: string | null;
}

export function useCreateBill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: BillInput) =>
      api.post<{ template: Bill }>("/api/templates", input, {
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function usePatchBill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      version: number;
      changes: Partial<Omit<BillInput, "kind" | "withdrawal">> & { active?: boolean };
    }) =>
      api.patch(`/api/templates/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

/**
 * Bring occurrences up to date with the bills.
 *
 * Safe to call as often as you like: it creates only what is missing and never
 * touches an occurrence that already exists, so no edit or verification is
 * undone.
 */
export function useGenerate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ generation: { created: number; existing: number } }>(
        "/api/templates/generate",
        {},
        { idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreatePaySchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { userId: string; anchorDate: string; defaultCents: string }) =>
      api.post("/api/pay-schedules", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function usePatchPaySchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      version: number;
      changes: { anchorDate?: string; defaultCents?: string };
    }) =>
      api.patch(`/api/pay-schedules/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function usePatchHousehold() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      version: number;
      changes: {
        cushionCents?: string;
        horizonPaychequeCount?: number;
        weekendWithdrawalRule?: HouseholdSettings["weekendWithdrawalRule"];
        name?: string;
      };
    }) =>
      api.patch("/api/settings/household", input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useSaveIncome() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      version: number;
      netMonthlyCents: string;
      netYearlyCents: string;
    }) =>
      api.put(
        "/api/settings/income",
        { netMonthlyCents: input.netMonthlyCents, netYearlyCents: input.netYearlyCents },
        { baseVersion: input.version, idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreateCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; section: "fixed" | "variable"; monthlyCents: string }) =>
      api.post("/api/budget-lines", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number }) =>
      api.delete(`/api/budget-lines/${input.id}`, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; targetCents: string; savedCents: string }) =>
      api.post("/api/goals", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function usePatchGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      version: number;
      changes: { name?: string; targetCents?: string; savedCents?: string };
    }) =>
      api.patch(`/api/goals/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreateAsset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      kind: "asset" | "liability";
      name: string;
      cents: string;
      note?: string;
    }) => api.post("/api/assets", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function usePatchAsset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number; changes: { name?: string; cents?: string } }) =>
      api.patch(`/api/assets/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string }) =>
      api.post("/api/accounts", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateEverything(queryClient),
  });
}
