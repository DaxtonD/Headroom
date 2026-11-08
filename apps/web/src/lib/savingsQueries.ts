/**
 * Data for the Savings screen.
 *
 * One read builds the whole screen - the account balances, the earmarks against
 * them, and the mortgage panel - because every part of it is derived from the
 * same facts and showing one half refreshed against the other would be worse
 * than showing neither.
 *
 * Amounts arrive as integer-cents strings and become `bigint` here, at the
 * edge, so no component ever handles money as a `number`.
 *
 * A note on what is nullable and why, since almost everything here is:
 *
 *  - `account.cents` is null when nobody has entered a balance yet. That is
 *    different from zero, which is a claim someone made.
 *  - `targetCents` is null for a pot with no figure attached, which is the
 *    normal case for a trip.
 *  - `plan` is null only if stored terms cannot be run forward at all, and then
 *    `error` says why. The terms are validated on the way in, so this is the
 *    "data from before that check" case rather than something a user can do.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cents } from "@headroom/core";
import { api, newIdempotencyKey } from "./api.js";
import { goalsKey, netWorthKey, yearKey } from "./plannerQueries.js";

const toCents = (value: string): Cents => BigInt(value);
const toCentsOrNull = (value: string | null): Cents | null =>
  value === null ? null : BigInt(value);

export type EarmarkPurpose = "general" | "mortgage_lump_sum";
export type RateCompounding = "simple_division" | "semi_annual";

export interface SavingsAccount {
  readonly id: string;
  readonly name: string;
  /** Null until someone has entered a balance. Not the same as zero. */
  readonly cents: Cents | null;
  readonly asOf: string | null;
  readonly enteredBy: { readonly id: string; readonly name: string; readonly initial: string } | null;
  readonly version: number;
}

export interface Earmark {
  readonly id: string;
  readonly name: string;
  readonly setAsideCents: Cents;
  readonly targetCents: Cents | null;
  readonly purpose: EarmarkPurpose;
  readonly remainingCents: Cents | null;
  readonly pct: number | null;
  readonly isMet: boolean;
  readonly version: number;
}

export interface MortgageProjection {
  readonly payoffDate: string;
  readonly totalInterestCents: Cents;
  readonly paymentCount: number;
  readonly remainingPaymentCount: number;
  readonly nextPaymentDate: string | null;
  /** Derived from the schedule, never the stored figure, which goes stale. */
  readonly balanceTodayCents: Cents;
}

export interface LumpSum {
  readonly id: string;
  readonly paidOn: string;
  readonly cents: Cents;
  readonly note: string | null;
  /** False for one that is intended but has not been paid. */
  readonly paid: boolean;
  readonly version: number;
}

export interface PrepaymentRoom {
  readonly capCents: Cents;
  readonly usedCents: Cents;
  readonly roomCents: Cents;
  /** On record for this window but not paid yet. */
  readonly plannedCents: Cents;
  readonly isUsedUp: boolean;
  /** False when no allowance has been entered, so there is nothing to report. */
  readonly isTracked: boolean;
  readonly resetsOn: string;
}

/** What a lump sum moves, against the plan already on record. */
export interface PayoffMove {
  readonly daysEarlier: number;
  readonly interestSavedCents: Cents;
  readonly paymentsSaved: number;
  readonly lumpSumCents: Cents;
}

export interface MortgagePanel {
  readonly id: string;
  readonly balanceCents: Cents;
  readonly asOf: string;
  readonly rateBasisPoints: number;
  readonly paymentCents: Cents;
  /**
   * How the fortnightly dates are decided: one of these two is set.
   *
   * `anchorDate` is a payment date of its own, which is what a lender states.
   * `payScheduleId` + `offsetDays` is a payment that chases a payday.
   */
  readonly anchorDate: string | null;
  readonly payScheduleId: string | null;
  readonly offsetDays: number;
  readonly compounding: RateCompounding;
  readonly prepaymentCapCents: Cents;
  readonly version: number;
  /** Whose payday the payment follows, or null when it keeps its own dates. */
  readonly follows: string | null;
  readonly prepayments: readonly LumpSum[];
  readonly room: PrepaymentRoom;
  /** Every lump sum on record applied, including ones only intended. */
  readonly plan: MortgageProjection | null;
  /** Only the ones actually paid: the "if we stop here" line. */
  readonly withoutFurther: MortgageProjection | null;
  readonly plannedBuys: PayoffMove | null;
  readonly whatIf: (PayoffMove & {
    readonly appliedOn: string;
    readonly payoffDate: string;
    readonly source: "earmark" | "query";
  }) | null;
  readonly error: string | null;
}

export interface Savings {
  readonly today: string;
  readonly accounts: readonly SavingsAccount[];
  readonly hasSavingsAccount: boolean;
  readonly balanceCents: Cents;
  readonly earmarkedCents: Cents;
  /** Balance less earmarks. Negative means more promised than exists. */
  readonly unallocatedCents: Cents;
  readonly isOverAllocated: boolean;
  readonly earmarks: readonly Earmark[];
  readonly mortgage: MortgagePanel | null;
}

export const savingsKey = ["savings"] as const;

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

interface ProjectionWire {
  payoffDate: string;
  totalInterestCents: string;
  paymentCount: number;
  remainingPaymentCount: number;
  nextPaymentDate: string | null;
  balanceTodayCents: string;
}

interface MoveWire {
  daysEarlier: number;
  interestSavedCents: string;
  paymentsSaved: number;
  lumpSumCents: string;
}

interface SavingsWire {
  today: string;
  accounts: (Omit<SavingsAccount, "cents"> & { cents: string | null })[];
  hasSavingsAccount: boolean;
  balanceCents: string;
  earmarkedCents: string;
  unallocatedCents: string;
  isOverAllocated: boolean;
  earmarks: (Omit<Earmark, "setAsideCents" | "targetCents" | "remainingCents"> & {
    setAsideCents: string;
    targetCents: string | null;
    remainingCents: string | null;
  })[];
  mortgage: (Omit<
    MortgagePanel,
    | "balanceCents"
    | "paymentCents"
    | "prepaymentCapCents"
    | "prepayments"
    | "room"
    | "plan"
    | "withoutFurther"
    | "plannedBuys"
    | "whatIf"
  > & {
    balanceCents: string;
    paymentCents: string;
    prepaymentCapCents: string;
    prepayments: (Omit<LumpSum, "cents"> & { cents: string })[];
    room: Record<keyof PrepaymentRoom, string | boolean>;
    plan: ProjectionWire | null;
    withoutFurther: ProjectionWire | null;
    plannedBuys: MoveWire | null;
    whatIf:
      | (MoveWire & { appliedOn: string; payoffDate: string; source: "earmark" | "query" })
      | null;
  }) | null;
}

const parseProjection = (wire: ProjectionWire): MortgageProjection => ({
  payoffDate: wire.payoffDate,
  totalInterestCents: toCents(wire.totalInterestCents),
  paymentCount: wire.paymentCount,
  remainingPaymentCount: wire.remainingPaymentCount,
  nextPaymentDate: wire.nextPaymentDate,
  balanceTodayCents: toCents(wire.balanceTodayCents),
});

const parseMove = (wire: MoveWire): PayoffMove => ({
  daysEarlier: wire.daysEarlier,
  interestSavedCents: toCents(wire.interestSavedCents),
  paymentsSaved: wire.paymentsSaved,
  lumpSumCents: toCents(wire.lumpSumCents),
});

/**
 * The Savings screen.
 *
 * `lumpSumCents` asks the server a what-if: what paying that much today would
 * do to the payoff date. Without it the server answers for whatever is
 * earmarked for the mortgage, which is the question the household usually has.
 */
export function useSavings(lumpSumCents?: Cents) {
  const query = lumpSumCents === undefined ? null : lumpSumCents.toString();

  return useQuery({
    queryKey: [...savingsKey, query],
    queryFn: async (): Promise<Savings> => {
      const wire = await api.get<SavingsWire>(
        query === null ? "/api/savings" : `/api/savings?lumpSumCents=${query}`,
      );

      return {
        today: wire.today,
        hasSavingsAccount: wire.hasSavingsAccount,
        accounts: wire.accounts.map((account) => ({
          ...account,
          cents: toCentsOrNull(account.cents),
        })),
        balanceCents: toCents(wire.balanceCents),
        earmarkedCents: toCents(wire.earmarkedCents),
        unallocatedCents: toCents(wire.unallocatedCents),
        isOverAllocated: wire.isOverAllocated,
        earmarks: wire.earmarks.map((earmark) => ({
          ...earmark,
          setAsideCents: toCents(earmark.setAsideCents),
          targetCents: toCentsOrNull(earmark.targetCents),
          remainingCents: toCentsOrNull(earmark.remainingCents),
        })),
        mortgage:
          wire.mortgage === null
            ? null
            : {
                ...wire.mortgage,
                balanceCents: toCents(wire.mortgage.balanceCents),
                paymentCents: toCents(wire.mortgage.paymentCents),
                prepaymentCapCents: toCents(wire.mortgage.prepaymentCapCents),
                prepayments: wire.mortgage.prepayments.map((lump) => ({
                  ...lump,
                  cents: toCents(lump.cents),
                })),
                room: {
                  capCents: toCents(String(wire.mortgage.room.capCents)),
                  usedCents: toCents(String(wire.mortgage.room.usedCents)),
                  roomCents: toCents(String(wire.mortgage.room.roomCents)),
                  plannedCents: toCents(String(wire.mortgage.room.plannedCents)),
                  isUsedUp: wire.mortgage.room.isUsedUp === true,
                  isTracked: wire.mortgage.room.isTracked === true,
                  resetsOn: String(wire.mortgage.room.resetsOn),
                },
                plan: wire.mortgage.plan === null ? null : parseProjection(wire.mortgage.plan),
                withoutFurther:
                  wire.mortgage.withoutFurther === null
                    ? null
                    : parseProjection(wire.mortgage.withoutFurther),
                plannedBuys:
                  wire.mortgage.plannedBuys === null
                    ? null
                    : parseMove(wire.mortgage.plannedBuys),
                whatIf:
                  wire.mortgage.whatIf === null
                    ? null
                    : {
                        ...parseMove(wire.mortgage.whatIf),
                        appliedOn: wire.mortgage.whatIf.appliedOn,
                        payoffDate: wire.mortgage.whatIf.payoffDate,
                        source: wire.mortgage.whatIf.source,
                      },
              },
      };
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Anything that changes the mortgage changes the Year screen too, because the
 * third-payment months come from the same schedule.
 */
function invalidateSavings(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return Promise.all(
    [savingsKey, yearKey, goalsKey, netWorthKey].map((key) =>
      queryClient.invalidateQueries({ queryKey: key }),
    ),
  ).then(() => undefined);
}

export interface MortgageInput {
  /** Integer cents, as a string. */
  readonly balanceCents: string;
  /** The date of the payment that produced that balance. */
  readonly asOf: string;
  /** Whole basis points: 3.99% is 399. */
  readonly rateBasisPoints: number;
  readonly paymentCents: string;
  /**
   * One of these two, never both: a payment date of its own, or the payday it
   * follows. Sending one clears the other.
   */
  readonly anchorDate?: string;
  readonly payScheduleId?: string;
  readonly offsetDays?: number;
  readonly compounding?: RateCompounding;
  readonly prepaymentCapCents?: string;
}

export function useCreateMortgage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: MortgageInput) =>
      api.post("/api/mortgage", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}

export function usePatchMortgage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      version: number;
      changes: Partial<MortgageInput>;
    }) =>
      api.patch(`/api/mortgage/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}

export function useDeleteMortgage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number }) =>
      api.delete(`/api/mortgage/${input.id}`, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}

export interface LumpSumInput {
  readonly paidOn: string;
  readonly cents: string;
  readonly note?: string;
  /** False records an intention rather than a payment. */
  readonly paid: boolean;
}

export function useCreatePrepayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: LumpSumInput & { mortgageId: string }) => {
      const { mortgageId, ...body } = input;
      return api.post(`/api/mortgage/${mortgageId}/prepayments`, body, {
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: () => invalidateSavings(queryClient),
  });
}

export function usePatchPrepayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number; changes: Partial<LumpSumInput> }) =>
      api.patch(`/api/prepayments/${input.id}`, input.changes, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}

export function useDeletePrepayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number }) =>
      api.delete(`/api/prepayments/${input.id}`, {
        baseVersion: input.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}

/**
 * Record a savings balance read off the bank.
 *
 * The same endpoint the chequing balance uses, with the account named. A
 * snapshot is append-only, so this never needs an If-Match: a correction is a
 * new snapshot and the latest one wins.
 */
export function useSaveSavingsBalance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { accountId: string; cents: string; note?: string }) =>
      api.post("/api/balance", input, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => invalidateSavings(queryClient),
  });
}
