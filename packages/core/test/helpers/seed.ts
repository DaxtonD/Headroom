/**
 * Loads a seed file and converts it into engine inputs.
 *
 * Two seed files have the same shape:
 *
 *  - `packages/core/test/fixtures/household-synthetic.json` is committed. Its
 *    amounts are invented, and its expected values were recomputed from those
 *    amounts, so CI can prove the engine without ever seeing real finances.
 *  - `seed/household-nov-2026.json` holds the household's real November
 *    figures. It is git-ignored and only exists on a local machine; when it is
 *    there, the golden tests run against it as well.
 *
 * No amount is hard-coded in this file or in the golden tests. Every expected
 * value is read from whichever seed is being checked, which is what lets the
 * same tests verify both.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPaydayOn, type PlainDate } from "../../src/dates.js";
import type { Cents } from "../../src/money.js";
import type {
  AssetInput,
  BudgetIncomeInput,
  BudgetLineInput,
  PaySchedule,
  RetirementInputs,
  TimelineInput,
} from "../../src/types.js";

/* -------------------------------------------------------------------------- */
/* The seed file's shape                                                      */
/* -------------------------------------------------------------------------- */

export interface SeedEvent {
  readonly id: string;
  readonly name: string;
  readonly type: "paycheque" | "auto" | "auto_deposit" | "flexible" | "one_off";
  readonly date?: PlainDate;
  readonly anchor?: string;
  readonly cents: number;
}

export interface SeedPayPeriodExpectation {
  readonly label: string;
  readonly start: PlainDate;
  readonly end: PlainDate;
  readonly inCents: number;
  readonly autoCents: number;
  readonly flexibleCents: number;
  readonly leftCents: number;
  readonly lowest?: { readonly cents: number; readonly date: PlainDate };
}

export interface Seed {
  readonly household: { readonly cushionCents: number; readonly timezone: string };
  readonly paySchedules: readonly {
    readonly user: string;
    readonly anchorDate: PlainDate;
    readonly defaultCents: number;
  }[];
  readonly fixture: {
    readonly today: PlainDate;
    readonly startBalanceCents: number;
    readonly horizonEnd: PlainDate;
    readonly events: readonly SeedEvent[];
    readonly sheetOrder: readonly string[];
    readonly expected: {
      readonly runningCents: readonly number[];
      readonly leftThisCycleCents: number;
      readonly lowestCents: number;
      readonly lowestAfter: string;
      readonly safeToSpendNowCents: number;
      readonly autoWithdrawalCount: number;
      readonly allAutoCovered: boolean;
      readonly sheetOrderEndCents: number;
      readonly payPeriods: readonly SeedPayPeriodExpectation[];
      readonly shortfallCase: {
        readonly edit: { readonly id: string; readonly cents: number };
        readonly firstShortfall: {
          readonly id: string;
          readonly date: PlainDate;
          readonly shortCents: number;
        };
      };
      readonly movedFlexibleCase: {
        readonly move: { readonly id: string; readonly toAnchor: string };
        readonly leftThisCycleCents: number;
        readonly lowestCents: number;
      };
    };
  };
  readonly monthlyBudget: {
    readonly income: {
      readonly netMonthlyCents: number;
      readonly netYearlyCents: number;
    };
    readonly fixed: readonly { readonly name: string; readonly monthlyCents: number }[];
    readonly variable: readonly { readonly name: string; readonly monthlyCents: number }[];
    readonly expected: {
      readonly fixedMonthlyCents: number;
      readonly fixedYearlyCents: number;
      readonly variableMonthlyCents: number;
      readonly variableYearlyCents: number;
      readonly totalMonthlyCents: number;
      readonly totalYearlyCents: number;
      readonly balanceMonthlyCents: number;
      readonly balanceYearlyCents: number;
      readonly fixedSharePct: Readonly<Record<string, number>>;
      readonly variableSharePct: Readonly<Record<string, number>>;
    };
  };
  readonly goals: readonly {
    readonly name: string;
    readonly targetCents: number;
    readonly savedCents: number;
    readonly expected: { readonly remainingCents: number; readonly pct: number };
  }[];
  readonly netWorth: {
    readonly assets: readonly { readonly name: string; readonly cents: number }[];
    readonly liabilities: readonly { readonly name: string; readonly cents: number }[];
    readonly expected: { readonly assetsCents: number; readonly netWorthCents: number };
  };
  readonly retirement: {
    readonly inputs: {
      readonly rrspCurrentPlusFourYearsCents: number;
      readonly mortgageMonthlyCents: number;
      readonly redirectYears: number;
      readonly flatGrowthPct: number;
      readonly drawdownYears: number;
      readonly governmentPensionAnnualCents: number;
      readonly retirementExpensesAnnualCents: number;
    };
    readonly expected: {
      readonly mortgageRedirectCents: number;
      readonly growthCents: number;
      readonly rrspAt65Cents: number;
      readonly annualDrawCents: number;
      readonly extraPerYearCents: number;
      readonly extraPerMonthCents: number;
      readonly totalForRetirementCents: number;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

const CORE_DIR = resolve(import.meta.dirname, "../..");
const REPO_ROOT = resolve(CORE_DIR, "../..");

export const SYNTHETIC_SEED_PATH = resolve(CORE_DIR, "test/fixtures/household-synthetic.json");
export const REAL_SEED_PATH = resolve(REPO_ROOT, "seed/household-nov-2026.json");

export function loadSeed(path: string): Seed {
  return JSON.parse(readFileSync(path, "utf8")) as Seed;
}

export interface NamedSeed {
  readonly label: string;
  readonly path: string;
  readonly seed: Seed;
}

/**
 * Every seed available to check: always the synthetic fixture, plus the real
 * one when this machine has it.
 */
export function availableSeeds(): NamedSeed[] {
  const seeds: NamedSeed[] = [];

  if (existsSync(SYNTHETIC_SEED_PATH)) {
    seeds.push({
      label: "synthetic fixture",
      path: SYNTHETIC_SEED_PATH,
      seed: loadSeed(SYNTHETIC_SEED_PATH),
    });
  }

  if (existsSync(REAL_SEED_PATH)) {
    seeds.push({
      label: "real November seed (local only)",
      path: REAL_SEED_PATH,
      seed: loadSeed(REAL_SEED_PATH),
    });
  }

  return seeds;
}

/* -------------------------------------------------------------------------- */
/* Conversion to engine inputs                                                */
/* -------------------------------------------------------------------------- */

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Seed amount ${String(value)} is not a whole number of cents.`);
  }
  return BigInt(value);
}

export function paySchedules(seed: Seed): PaySchedule[] {
  return seed.paySchedules.map((schedule) => ({
    id: schedule.user,
    ownerId: schedule.user,
    anchorDate: schedule.anchorDate,
    defaultCents: cents(schedule.defaultCents),
  }));
}

/**
 * Which pay schedule a dated cheque belongs to.
 *
 * Matched by date: a cheque on a day that is a payday for exactly one schedule
 * belongs to that schedule. Where two people are paid on the same day this is
 * ambiguous, so it is left unset and the engine falls back to counting placed
 * cheques by date.
 */
function payScheduleIdFor(date: PlainDate, schedules: readonly PaySchedule[]): string | undefined {
  const matches = schedules.filter((schedule) => isPaydayOn(schedule.anchorDate, date));
  return matches.length === 1 ? matches[0]?.id : undefined;
}

/**
 * The seed's event types, translated into the engine's two questions: what
 * kind of thing is it, and is it placed by date or by anchor?
 */
export function timelineEvents(seed: Seed): TimelineInput[] {
  const schedules = paySchedules(seed);

  return seed.fixture.events.map((event, index) => {
    const base = {
      id: event.id,
      name: event.name,
      cents: cents(event.cents),
      sortIndex: index,
      // The sheet marks the bills Dax has typed an "X" against; the fixture
      // does not record verification, so every bill reads as an estimate.
      verified: false,
    };

    switch (event.type) {
      case "paycheque": {
        const date = requireDate(event);
        const payScheduleId = payScheduleIdFor(date, schedules);
        return {
          ...base,
          kind: "paycheque" as const,
          placement: "auto" as const,
          date,
          ...(payScheduleId ? { payScheduleId } : {}),
        };
      }
      case "auto":
        return { ...base, kind: "bill" as const, placement: "auto" as const, date: requireDate(event) };
      case "auto_deposit":
        return { ...base, kind: "deposit" as const, placement: "auto" as const, date: requireDate(event) };
      case "flexible":
        return {
          ...base,
          // A transfer to savings is not a bill, and the UI words it
          // differently, but it leaves the account just the same.
          kind: event.id.includes("savings") ? ("transfer" as const) : ("bill" as const),
          placement: "flexible" as const,
          anchorId: anchorOf(event),
        };
      case "one_off":
        return event.date === undefined
          ? {
              ...base,
              kind: "deposit" as const,
              placement: "flexible" as const,
              anchorId: anchorOf(event),
              isOneOff: true,
            }
          : {
              ...base,
              kind: "deposit" as const,
              placement: "auto" as const,
              date: event.date,
              isOneOff: true,
            };
      default: {
        const exhaustive: never = event.type;
        throw new Error(`Unknown seed event type: ${String(exhaustive)}`);
      }
    }
  });
}

function requireDate(event: SeedEvent): PlainDate {
  if (event.date === undefined) {
    throw new Error(`Seed event "${event.id}" is dated but has no date.`);
  }
  return event.date;
}

/** `"now"` in the seed means the same as a null anchor in the engine. */
function anchorOf(event: SeedEvent): string | null {
  if (event.anchor === undefined) {
    throw new Error(`Seed event "${event.id}" is flexible but has no anchor.`);
  }
  return event.anchor === "now" ? null : event.anchor;
}

export function budgetLines(seed: Seed): BudgetLineInput[] {
  return [
    ...seed.monthlyBudget.fixed.map((line) => ({
      name: line.name,
      section: "fixed" as const,
      monthlyCents: cents(line.monthlyCents),
    })),
    ...seed.monthlyBudget.variable.map((line) => ({
      name: line.name,
      section: "variable" as const,
      monthlyCents: cents(line.monthlyCents),
    })),
  ];
}

export function budgetIncome(seed: Seed): BudgetIncomeInput {
  return {
    netMonthlyCents: cents(seed.monthlyBudget.income.netMonthlyCents),
    netYearlyCents: cents(seed.monthlyBudget.income.netYearlyCents),
  };
}

export function assets(seed: Seed): AssetInput[] {
  return seed.netWorth.assets.map((asset) => ({ name: asset.name, cents: cents(asset.cents) }));
}

export function liabilities(seed: Seed): AssetInput[] {
  return seed.netWorth.liabilities.map((item) => ({ name: item.name, cents: cents(item.cents) }));
}

export function retirementInputs(seed: Seed): RetirementInputs {
  const inputs = seed.retirement.inputs;
  return {
    rrspCurrentPlusContribCents: cents(inputs.rrspCurrentPlusFourYearsCents),
    mortgageMonthlyCents: cents(inputs.mortgageMonthlyCents),
    redirectYears: inputs.redirectYears,
    flatGrowthPct: inputs.flatGrowthPct,
    compoundYearly: false,
    drawdownYears: inputs.drawdownYears,
    govPensionAnnualCents: cents(inputs.governmentPensionAnnualCents),
    retirementExpensesAnnualCents: cents(inputs.retirementExpensesAnnualCents),
  };
}
