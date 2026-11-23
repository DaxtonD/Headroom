/**
 * Data for the planning screens: Budget, Net worth & retirement, and the work
 * expenses and banked hours that sit at the foot of Savings.
 *
 * Kept apart from `queries.ts`, which is the day-to-day money timeline. These
 * change rarely and are read as whole screens; those change constantly and are
 * invalidated by the live-update stream.
 *
 * Amounts arrive as integer-cents strings and become `bigint` here, at the
 * edge, so no component handles money as a `number`.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  /** The picture beside the name, or null for none. */
  readonly imageId: string | null;
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

/**
 * The Budget screen's read, as options rather than only as a hook.
 *
 * Split out so it can be prefetched. `warmTabs.ts` asks for the four tab
 * screens while the app is idle, which is what stops the first visit to each
 * one in a session being a blank screen with a spinner - reported as "when I
 * click on a tab the UI gets stuck... like it's waiting for the data to load
 * before it's displayed", which is exactly what it was doing.
 */
export function budgetOptions() {
  return queryOptions({
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

export function useBudget() {
  return useQuery(budgetOptions());
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
  /**
   * What the household means to put in each payday, or null for a pot with
   * no plan.
   *
   * Null is not zero, on the same reasoning as `targetCents`: a goal with no
   * plan is never allocated to automatically, which is what keeps the
   * ledger's "not earmarked" figure from quietly becoming nothing.
   */
  readonly perPaydayIntentCents: Cents | null;
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

export interface BankedHoursEntry {
  readonly id: string;
  readonly userId: string;
  /** Hours as a decimal string, negative when hours were taken back out. */
  readonly hours: string;
  readonly note: string | null;
  /** The day it was entered, in the household's timezone. */
  readonly createdOn: string;
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
    /** Everything still owed. Never capped - this is the part with work to do. */
    readonly outstanding: readonly Reimbursement[];
    /** Paid back, newest first, capped by the server. */
    readonly paid: readonly Reimbursement[];
    /** How many paid-back ones exist in total, which may exceed `paid.length`. */
    readonly paidCount: number;
    readonly awaitingSubmissionCents: Cents;
    readonly submittedCents: Cents;
    readonly paidCents: Cents;
    readonly outstandingCents: Cents;
    readonly totalCents: Cents;
  };
  readonly bankedHours: {
    readonly entries: readonly BankedHoursEntry[];
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
        goals: (Omit<
          GoalProgress,
          "targetCents" | "savedCents" | "remainingCents" | "perPaydayIntentCents"
        > & {
          targetCents: string | null;
          savedCents: string;
          remainingCents: string | null;
          // Optional: this bundle has to survive an older API than itself.
          perPaydayIntentCents?: string | null;
        })[];
        reimbursements: {
          /*
           * All three are optional so that this bundle also survives talking
           * to an older API than itself - a rolled-back image, say. The split
           * lists are preferred; `items` is the fallback they were derived
           * from. Reading a field that is not there is what took this screen
           * down in the first place, in the other direction.
           */
          outstanding?: (Omit<Reimbursement, "cents"> & { cents: string })[];
          paid?: (Omit<Reimbursement, "cents"> & { cents: string })[];
          paidCount?: number;
          items?: (Omit<Reimbursement, "cents"> & { cents: string })[];
          awaitingSubmissionCents: string;
          submittedCents: string;
          paidCents: string;
          outstandingCents: string;
          totalCents: string;
        };
        bankedHours: {
          entries?: BankedHoursEntry[];
          perPerson: BankedHoursPerson[];
          total: string;
        };
      }>("/api/goals-overview");

      /*
       * Either shape: the split lists when the server sends them, otherwise
       * derived from the single list older servers send.
       */
      const allWire = wire.reimbursements.items ?? [];
      const outstandingWire =
        wire.reimbursements.outstanding ?? allWire.filter((item) => item.status !== "paid");
      const paidWire = wire.reimbursements.paid ?? allWire.filter((item) => item.status === "paid");

      return {
        goals: wire.goals.map((goal) => ({
          ...goal,
          targetCents: goal.targetCents === null ? null : toCents(goal.targetCents),
          savedCents: toCents(goal.savedCents),
          perPaydayIntentCents:
            goal.perPaydayIntentCents === null || goal.perPaydayIntentCents === undefined
              ? null
              : toCents(goal.perPaydayIntentCents),
          remainingCents: goal.remainingCents === null ? null : toCents(goal.remainingCents),
        })),
        reimbursements: {
          outstanding: outstandingWire.map((item) => ({ ...item, cents: toCents(item.cents) })),
          paid: paidWire.map((item) => ({ ...item, cents: toCents(item.cents) })),
          paidCount: wire.reimbursements.paidCount ?? paidWire.length,
          awaitingSubmissionCents: toCents(wire.reimbursements.awaitingSubmissionCents),
          submittedCents: toCents(wire.reimbursements.submittedCents),
          paidCents: toCents(wire.reimbursements.paidCents),
          outstandingCents: toCents(wire.reimbursements.outstandingCents),
          totalCents: toCents(wire.reimbursements.totalCents),
        },
        bankedHours: { ...wire.bankedHours, entries: wire.bankedHours.entries ?? [] },
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

/**
 * One bill that does not come every month, landing on a date.
 *
 * The ones nobody remembers until they arrive: annual insurance, the yearly
 * subscriptions, a quarterly utility. Invisible on a ledger whose horizon is
 * a fortnight, which is why they live on this screen.
 */
export interface YearLump {
  readonly name: string;
  readonly date: string;
  /** A positive magnitude: what it costs. */
  readonly cents: Cents;
  /** `yearly` or `quarterly`. */
  readonly cadence: string;
}

export interface YearMonth {
  readonly year: number;
  readonly month: number;
  /** `Apr 2027`. */
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly isUnusual: boolean;
  /** Everything arriving in this month, as a positive magnitude. */
  readonly inCents: Cents | null;
  /** Everything leaving, as a positive magnitude. */
  readonly outCents: Cents | null;
  /** Where chequing lands on the last day of the month. */
  readonly endBalanceCents: Cents | null;
  readonly lumps: readonly YearLump[];
  readonly lumpTotalCents: Cents;
  /**
   * What this month is worth against a normal one. Positive is a windfall,
   * negative is a squeeze - and the two can sit side by side, because the
   * mortgage comes out the day after a payday and that one-day offset lets a
   * third payment slip over a month boundary.
   */
  readonly netExtraCents: Cents;
  readonly entries: readonly YearEntry[];
}

/**
 * What to put aside each month so the irregular bills are already paid for.
 *
 * Two figures, and the gap between them is the point. `evenCents` is the
 * total divided by the months, which is what anybody would work out and is
 * right only if the bills happen to be evenly spread. `levelCents` is the
 * smallest amount that is never short on any date a bill actually falls -
 * if the insurance lands in March, a twelfth of the year's total will not be
 * there in time however correct the division was.
 */
export interface YearSetAside {
  readonly monthCount: number;
  readonly totalCents: Cents;
  readonly billCount: number;
  readonly evenCents: Cents;
  readonly levelCents: Cents;
  /** The month that forces the level figure up, or null when the two agree. */
  readonly bindingStart: string | null;
  readonly bindingLabel: string | null;
}

/** One extra paycheque, matched to the extra payment it pays for. */
export interface YearPairing {
  readonly windfallStart: string;
  readonly windfallLabel: string;
  readonly squeezeStart: string;
  readonly squeezeLabel: string;
  readonly coveredCents: Cents;
  /** The squeeze lands before the money meant to cover it: the one that hurts. */
  readonly squeezeFirst: boolean;
}

export interface YearOverview {
  readonly today: string;
  readonly monthCount: number;
  readonly hasMortgage: boolean;
  readonly months: readonly YearMonth[];
  /** False when there is no chequing account, so there is nothing to project. */
  readonly hasBalance: boolean;
  readonly startBalanceCents: Cents;
  /**
   * The last date the ledger's own rows cover. Up to here the monthly figures
   * are the ledger's; past it they are worked out from the schedules and
   * assume every bill costs what it costs today.
   */
  readonly ledgerThrough: string;
  readonly lowestStart: string | null;
  readonly setAside: YearSetAside;
  readonly pairs: readonly YearPairing[];
  /** Squeeze with no extra cheque anywhere in the window to answer it. */
  readonly uncoveredCents: Cents;
  /** Extra cheque left once every squeeze is paid for. */
  readonly spareCents: Cents;
}

export const yearKey = ["year"] as const;

/**
 * The year ahead.
 *
 * Needs no amounts entered and no bills verified, only the pay schedules, so
 * it stays accurate much further out than the timeline does. That is why it is
 * its own screen rather than a longer ledger.
 */
/** The year ahead, as options, so it can be warmed. See `budgetOptions`. */
export function yearOptions(months?: number) {
  return queryOptions({
    queryKey: [...yearKey, months ?? null],
    // Same reasoning as `savingsOptions`: the key carries how many months
    // were asked for, and only the default is worth keeping for the session.
    gcTime: months === undefined ? Infinity : 5 * 60_000,
    queryFn: async (): Promise<YearOverview> => {
      /*
       * Every amount crosses the wire as a decimal string, because JSON has
       * no integer big enough to be trusted with money. `toCents` is the one
       * place that turns one back into a bigint; a `Number` anywhere on this
       * path would be a silent rounding of somebody's balance.
       */
      const wire = await api.get<{
        today: string;
        monthCount: number;
        hasMortgage: boolean;
        months: (Omit<
          YearMonth,
          | "netExtraCents"
          | "entries"
          | "inCents"
          | "outCents"
          | "endBalanceCents"
          | "lumps"
          | "lumpTotalCents"
        > & {
          netExtraCents: string;
          inCents: string | null;
          outCents: string | null;
          endBalanceCents: string | null;
          lumpTotalCents: string;
          lumps: (Omit<YearLump, "cents"> & { cents: string })[];
          entries: (Omit<YearEntry, "cents" | "extraCents"> & {
            cents: string;
            extraCents: string;
          })[];
        })[];
        hasBalance: boolean;
        startBalanceCents: string;
        ledgerThrough: string;
        lowestStart: string | null;
        setAside: Omit<YearSetAside, "totalCents" | "evenCents" | "levelCents"> & {
          totalCents: string;
          evenCents: string;
          levelCents: string;
        };
        pairs: (Omit<YearPairing, "coveredCents"> & { coveredCents: string })[];
        uncoveredCents: string;
        spareCents: string;
      }>(months === undefined ? "/api/year" : `/api/year?months=${String(months)}`);

      return {
        today: wire.today,
        monthCount: wire.monthCount,
        hasMortgage: wire.hasMortgage,
        months: wire.months.map((month) => ({
          ...month,
          netExtraCents: toCents(month.netExtraCents),
          // Null means the projection did not cover this month, which cannot
          // happen today. Kept as null rather than folded to zero, because a
          // zero would be read as "nothing happens here".
          inCents: month.inCents === null ? null : toCents(month.inCents),
          outCents: month.outCents === null ? null : toCents(month.outCents),
          endBalanceCents:
            month.endBalanceCents === null ? null : toCents(month.endBalanceCents),
          lumpTotalCents: toCents(month.lumpTotalCents),
          lumps: month.lumps.map((lump) => ({ ...lump, cents: toCents(lump.cents) })),
          entries: month.entries.map((entry) => ({
            ...entry,
            cents: toCents(entry.cents),
            extraCents: toCents(entry.extraCents),
          })),
        })),
        hasBalance: wire.hasBalance,
        startBalanceCents: toCents(wire.startBalanceCents),
        ledgerThrough: wire.ledgerThrough,
        lowestStart: wire.lowestStart,
        setAside: {
          ...wire.setAside,
          totalCents: toCents(wire.setAside.totalCents),
          evenCents: toCents(wire.setAside.evenCents),
          levelCents: toCents(wire.setAside.levelCents),
        },
        pairs: wire.pairs.map((pair) => ({
          ...pair,
          coveredCents: toCents(pair.coveredCents),
        })),
        uncoveredCents: toCents(wire.uncoveredCents),
        spareCents: toCents(wire.spareCents),
      };
    },
  });
}

export function useYear(months?: number) {
  return useQuery(yearOptions(months));
}
