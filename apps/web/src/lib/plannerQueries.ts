/**
 * Data for the planning screens: Budget, Goals, and Net worth & retirement.
 *
 * Kept apart from `queries.ts`, which is the day-to-day money timeline. These
 * change rarely and are read as whole screens; those change constantly and are
 * invalidated by the live-update stream.
 *
 * Amounts arrive as integer-cents strings and become `bigint` here, at the
 * edge, so no component handles money as a `number`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cents } from "@headroom/core";
import { api, newIdempotencyKey } from "./api.js";

const toCents = (value: string): Cents => BigInt(value);

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

export interface BudgetLine {
  readonly id: string | null;
  readonly name: string;
  readonly monthlyCents: Cents;
  readonly yearlyCents: Cents;
  /** Share of this line's own section, never of income. */
  readonly sharePct: number;
  readonly version: number;
  /**
   * Where the line came from. A `bill` is a recurring expense whose monthly
   * cost was worked out from its cadence; a `category` is budget-only spending
   * with no due date. They are edited in different places, so the UI needs to
   * tell them apart.
   */
  readonly source: "bill" | "category";
  /** What the derivation gave, when a stated figure was used instead. */
  readonly derivedMonthlyCents: Cents | null;
  readonly overridden: boolean;
}

export interface BudgetSection {
  readonly lines: readonly BudgetLine[];
  readonly monthlyCents: Cents;
  readonly yearlyCents: Cents;
}

export interface Budget {
  readonly income: {
    readonly netMonthlyCents: Cents;
    readonly netYearlyCents: Cents;
    readonly householdVersion: number;
  };
  readonly fixed: BudgetSection;
  readonly variable: BudgetSection;
  readonly totalMonthlyCents: Cents;
  readonly totalYearlyCents: Cents;
  readonly balanceMonthlyCents: Cents;
  readonly balanceYearlyCents: Cents;
}

interface BudgetLineWire
  extends Omit<BudgetLine, "monthlyCents" | "yearlyCents" | "derivedMonthlyCents"> {
  readonly monthlyCents: string;
  readonly yearlyCents: string;
  readonly derivedMonthlyCents: string | null;
}

interface BudgetWire {
  readonly income: { netMonthlyCents: string; netYearlyCents: string; householdVersion: number };
  readonly fixed: { lines: BudgetLineWire[]; monthlyCents: string; yearlyCents: string };
  readonly variable: { lines: BudgetLineWire[]; monthlyCents: string; yearlyCents: string };
  readonly totalMonthlyCents: string;
  readonly totalYearlyCents: string;
  readonly balanceMonthlyCents: string;
  readonly balanceYearlyCents: string;
}

export const budgetKey = ["budget"] as const;

function parseSection(wire: BudgetWire["fixed"]): BudgetSection {
  return {
    lines: wire.lines.map((line) => ({
      ...line,
      monthlyCents: toCents(line.monthlyCents),
      yearlyCents: toCents(line.yearlyCents),
      derivedMonthlyCents:
        line.derivedMonthlyCents === null ? null : toCents(line.derivedMonthlyCents),
    })),
    monthlyCents: toCents(wire.monthlyCents),
    yearlyCents: toCents(wire.yearlyCents),
  };
}

export function useBudget() {
  return useQuery({
    queryKey: budgetKey,
    queryFn: async (): Promise<Budget> => {
      const wire = await api.get<BudgetWire>("/api/budget");
      return {
        income: {
          netMonthlyCents: toCents(wire.income.netMonthlyCents),
          netYearlyCents: toCents(wire.income.netYearlyCents),
          householdVersion: wire.income.householdVersion,
        },
        fixed: parseSection(wire.fixed),
        variable: parseSection(wire.variable),
        totalMonthlyCents: toCents(wire.totalMonthlyCents),
        totalYearlyCents: toCents(wire.totalYearlyCents),
        balanceMonthlyCents: toCents(wire.balanceMonthlyCents),
        balanceYearlyCents: toCents(wire.balanceYearlyCents),
      };
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Goals                                                                      */
/* -------------------------------------------------------------------------- */

export type EarmarkPurpose = "general" | "mortgage_lump_sum";

export interface GoalProgress {
  readonly id: string;
  readonly name: string;
  /**
   * Null when nothing is being saved towards in particular.
   *
   * A trip has no set cost, so a target is optional, and null is not the same
   * as zero: with no target there is no progress to show and no bar to draw.
   * `remainingCents` and `pct` are null in exactly the same cases.
   */
  readonly targetCents: Cents | null;
  readonly savedCents: Cents;
  readonly remainingCents: Cents | null;
  readonly pct: number | null;
  readonly isMet: boolean;
  readonly purpose: EarmarkPurpose;
  readonly sortIndex: number;
  readonly version: number;
}

export type ReimbursementStatus = "bought" | "submitted" | "paid";

export interface Reimbursement {
  readonly id: string;
  readonly purchase: string;
  readonly cents: Cents;
  readonly boughtOn: string;
  readonly status: ReimbursementStatus;
  readonly version: number;
}

export interface BankedHoursPerson {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  /** Hours as a decimal string. Never money. */
  readonly hours: string;
}

export interface GoalsOverview {
  readonly goals: readonly GoalProgress[];
  readonly reimbursements: {
    readonly items: readonly Reimbursement[];
    readonly boughtCents: Cents;
    readonly submittedCents: Cents;
    readonly paidCents: Cents;
    readonly outstandingCents: Cents;
    readonly totalCents: Cents;
  };
  readonly bankedHours: {
    readonly perPerson: readonly BankedHoursPerson[];
    readonly total: string;
  };
}

export const goalsKey = ["goals-overview"] as const;

export function useGoalsOverview() {
  return useQuery({
    queryKey: goalsKey,
    queryFn: async (): Promise<GoalsOverview> => {
      const wire = await api.get<{
        goals: (Omit<GoalProgress, "targetCents" | "savedCents" | "remainingCents"> & {
          targetCents: string | null;
          savedCents: string;
          remainingCents: string | null;
        })[];
        reimbursements: {
          items: (Omit<Reimbursement, "cents"> & { cents: string })[];
          boughtCents: string;
          submittedCents: string;
          paidCents: string;
          outstandingCents: string;
          totalCents: string;
        };
        bankedHours: { perPerson: BankedHoursPerson[]; total: string };
      }>("/api/goals-overview");

      return {
        goals: wire.goals.map((goal) => ({
          ...goal,
          targetCents: goal.targetCents === null ? null : toCents(goal.targetCents),
          savedCents: toCents(goal.savedCents),
          remainingCents: goal.remainingCents === null ? null : toCents(goal.remainingCents),
        })),
        reimbursements: {
          items: wire.reimbursements.items.map((item) => ({ ...item, cents: toCents(item.cents) })),
          boughtCents: toCents(wire.reimbursements.boughtCents),
          submittedCents: toCents(wire.reimbursements.submittedCents),
          paidCents: toCents(wire.reimbursements.paidCents),
          outstandingCents: toCents(wire.reimbursements.outstandingCents),
          totalCents: toCents(wire.reimbursements.totalCents),
        },
        bankedHours: wire.bankedHours,
      };
    },
  });
}

/** Advance a work expense: bought -> submitted -> paid back. */
export function useAdvanceReimbursement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; version: number; to: "submitted" | "paid" }) =>
      api.patch(
        `/api/reimbursements/${input.id}`,
        input.to === "submitted" ? { submitted: true } : { paid: true },
        { baseVersion: input.version, idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: goalsKey }),
  });
}

/* -------------------------------------------------------------------------- */
/* Net worth and retirement                                                   */
/* -------------------------------------------------------------------------- */

export interface AssetEntry {
  readonly id: string;
  readonly kind: "asset" | "liability";
  readonly name: string;
  readonly cents: Cents;
  readonly asOf: string | null;
  readonly note: string | null;
  readonly version: number;
}

/** Every one of these is an editable setting, never a constant. */
export interface RetirementInputs {
  readonly rrspCurrentPlusContribCents: Cents;
  readonly mortgageMonthlyCents: Cents;
  readonly redirectYears: number;
  readonly flatGrowthPct: number;
  readonly compoundYearly: boolean;
  readonly drawdownYears: number;
  readonly govPensionAnnualCents: Cents;
  readonly retirementExpensesAnnualCents: Cents;
  readonly version: number;
}

export interface Retirement {
  readonly inputs: RetirementInputs;
  readonly mortgageRedirectCents: Cents;
  readonly baseBeforeGrowthCents: Cents;
  readonly growthCents: Cents;
  readonly rrspAt65Cents: Cents;
  readonly annualDrawCents: Cents;
  readonly extraPerYearCents: Cents;
  readonly extraPerMonthCents: Cents;
  readonly totalForRetirementCents: Cents;
}

export interface NetWorth {
  readonly assets: readonly AssetEntry[];
  readonly liabilities: readonly AssetEntry[];
  readonly assetsCents: Cents;
  readonly liabilitiesCents: Cents;
  readonly netWorthCents: Cents;
  readonly retirement: Retirement | null;
}

export const netWorthKey = ["net-worth"] as const;

type AssetWire = Omit<AssetEntry, "cents"> & { cents: string };

export function useNetWorth() {
  return useQuery({
    queryKey: netWorthKey,
    queryFn: async (): Promise<NetWorth> => {
      const wire = await api.get<{
        assets: AssetWire[];
        liabilities: AssetWire[];
        assetsCents: string;
        liabilitiesCents: string;
        netWorthCents: string;
        retirement: {
          inputs: Record<string, string | number | boolean>;
          mortgageRedirectCents: string;
          baseBeforeGrowthCents: string;
          growthCents: string;
          rrspAt65Cents: string;
          annualDrawCents: string;
          extraPerYearCents: string;
          extraPerMonthCents: string;
          totalForRetirementCents: string;
        } | null;
      }>("/api/net-worth");

      const parseAsset = (asset: AssetWire): AssetEntry => ({
        ...asset,
        cents: toCents(asset.cents),
      });

      return {
        assets: wire.assets.map(parseAsset),
        liabilities: wire.liabilities.map(parseAsset),
        assetsCents: toCents(wire.assetsCents),
        liabilitiesCents: toCents(wire.liabilitiesCents),
        netWorthCents: toCents(wire.netWorthCents),
        retirement: wire.retirement
          ? {
              inputs: {
                rrspCurrentPlusContribCents: toCents(
                  String(wire.retirement.inputs["rrspCurrentPlusContribCents"]),
                ),
                mortgageMonthlyCents: toCents(String(wire.retirement.inputs["mortgageMonthlyCents"])),
                redirectYears: Number(wire.retirement.inputs["redirectYears"]),
                flatGrowthPct: Number(wire.retirement.inputs["flatGrowthPct"]),
                compoundYearly: Boolean(wire.retirement.inputs["compoundYearly"]),
                drawdownYears: Number(wire.retirement.inputs["drawdownYears"]),
                govPensionAnnualCents: toCents(String(wire.retirement.inputs["govPensionAnnualCents"])),
                retirementExpensesAnnualCents: toCents(
                  String(wire.retirement.inputs["retirementExpensesAnnualCents"]),
                ),
                version: Number(wire.retirement.inputs["version"]),
              },
              mortgageRedirectCents: toCents(wire.retirement.mortgageRedirectCents),
              baseBeforeGrowthCents: toCents(wire.retirement.baseBeforeGrowthCents),
              growthCents: toCents(wire.retirement.growthCents),
              rrspAt65Cents: toCents(wire.retirement.rrspAt65Cents),
              annualDrawCents: toCents(wire.retirement.annualDrawCents),
              extraPerYearCents: toCents(wire.retirement.extraPerYearCents),
              extraPerMonthCents: toCents(wire.retirement.extraPerMonthCents),
              totalForRetirementCents: toCents(wire.retirement.totalForRetirementCents),
            }
          : null,
      };
    },
  });
}

/** Saved as one set: half-applied assumptions would produce a meaningless figure. */
export function useSaveRetirement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      /** Integer-cents strings and whole numbers, as the API expects. */
      readonly values: Record<string, string | number | boolean>;
      readonly version: number | null;
    }) =>
      api.put("/api/settings/retirement", input.values, {
        // The very first save has nothing to conflict with.
        ...(input.version === null ? {} : { baseVersion: input.version }),
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: netWorthKey }),
  });
}

/* -------------------------------------------------------------------------- */
/* The year                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One biweekly thing, counted inside one month.
 *
 * `extraCount` is how many MORE than the usual two, so zero is a normal month
 * and the screen only has to look at the non-zero ones.
 */
export interface YearEntry {
  readonly id: string;
  readonly name: string;
  /** Signed: positive arrives, negative leaves. */
  readonly cents: Cents;
  readonly count: number;
  readonly extraCount: number;
  /** `extraCount x cents`. What the oddity is worth, signed. */
  readonly extraCents: Cents;
  readonly dates: readonly string[];
}

export interface YearMonth {
  readonly year: number;
  readonly month: number;
  /** `Apr 2027`. */
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly isUnusual: boolean;
  /**
   * What this month is worth against a normal one. Positive is a windfall,
   * negative is a squeeze - and the two can sit side by side, because the
   * mortgage comes out the day after a payday and that one-day offset lets a
   * third payment slip over a month boundary.
   */
  readonly netExtraCents: Cents;
  readonly entries: readonly YearEntry[];
}

export interface YearOverview {
  readonly today: string;
  readonly monthCount: number;
  readonly hasMortgage: boolean;
  readonly months: readonly YearMonth[];
}

export const yearKey = ["year"] as const;

/**
 * The year ahead.
 *
 * Needs no amounts entered and no bills verified, only the pay schedules, so
 * it stays accurate much further out than the timeline does. That is why it is
 * its own screen rather than a longer ledger.
 */
export function useYear(months?: number) {
  return useQuery({
    queryKey: [...yearKey, months ?? null],
    queryFn: async (): Promise<YearOverview> => {
      const wire = await api.get<{
        today: string;
        monthCount: number;
        hasMortgage: boolean;
        months: (Omit<YearMonth, "netExtraCents" | "entries"> & {
          netExtraCents: string;
          entries: (Omit<YearEntry, "cents" | "extraCents"> & {
            cents: string;
            extraCents: string;
          })[];
        })[];
      }>(months === undefined ? "/api/year" : `/api/year?months=${String(months)}`);

      return {
        today: wire.today,
        monthCount: wire.monthCount,
        hasMortgage: wire.hasMortgage,
        months: wire.months.map((month) => ({
          ...month,
          netExtraCents: toCents(month.netExtraCents),
          entries: month.entries.map((entry) => ({
            ...entry,
            cents: toCents(entry.cents),
            extraCents: toCents(entry.extraCents),
          })),
        })),
      };
    },
  });
}
