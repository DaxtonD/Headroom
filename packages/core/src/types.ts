/**
 * The shapes the engine works on.
 *
 * These are deliberately a little different from the database rows: the engine
 * takes exactly the facts it needs to derive a number, and nothing else. That
 * keeps it pure, keeps the golden tests honest, and means the web app can run
 * the identical computation on data it already holds.
 */
import type { Cents } from "./money.js";
import type { PlainDate, WeekendRule } from "./dates.js";

/** What kind of thing an amount is, as the spreadsheet names them. */
export type OccurrenceKind = "paycheque" | "bill" | "deposit" | "transfer";

/**
 * How an item is placed on the timeline (HANDOFF section 6.2).
 *
 * `auto`     - placed by DATE. The bank acts on a known day, so the money has
 *              to be there. Paycheques and automatic deposits are also `auto`:
 *              they are dated, which is what this decides.
 * `flexible` - placed by ANCHOR, with no date. Hangs off a paycheque and can
 *              be moved to an earlier or later one when money is tight.
 */
export type Placement = "auto" | "flexible";

/** An uncleared thing that will move money, ready to be ordered. */
export interface TimelineInput {
  readonly id: string;
  readonly name: string;
  /** Signed: negative leaves the account, positive arrives. */
  readonly cents: Cents;
  readonly kind: OccurrenceKind;
  readonly placement: Placement;
  /** Set when, and only when, `placement` is `auto`. */
  readonly date?: PlainDate | undefined;
  /**
   * For a flexible item: the id of the paycheque it hangs off.
   * `null` or absent means "now", before the first upcoming paycheque.
   */
  readonly anchorId?: string | null | undefined;
  /** The user-set order within one anchor or one day. */
  readonly sortIndex?: number | undefined;
  readonly isOneOff?: boolean | undefined;
  /** False means the amount is still an estimate, not the real bill. */
  readonly verified?: boolean | undefined;
  readonly ownerId?: string | null | undefined;
  /** Which pay schedule produced this cheque, for pay-period projection. */
  readonly payScheduleId?: string | null | undefined;
}

/** One ordered row of the timeline, with the balance after it. */
export interface TimelineRow {
  readonly event: TimelineInput;
  /** The balance once this row has happened. */
  readonly runningCents: Cents;
  /**
   * The date this row sits on. For a flexible item this is its anchor
   * paycheque's date, which is where the bank would see it.
   */
  readonly effectiveDate: PlainDate | null;
  /** True when this is an automatic withdrawal that must be covered. */
  readonly requiresCoverage: boolean;
}

export interface LowestPoint {
  readonly cents: Cents;
  /** The row the balance bottoms out after, or null when that is "now". */
  readonly afterEventId: string | null;
  readonly date: PlainDate | null;
}

export interface Shortfall {
  readonly eventId: string;
  readonly name: string;
  readonly date: PlainDate | null;
  /** How much more is needed to cover it, including the cushion. */
  readonly shortCents: Cents;
  readonly runningCents: Cents;
}

export interface Coverage {
  /** How many automatic withdrawals are in range. */
  readonly autoWithdrawalCount: number;
  readonly allCovered: boolean;
  /** The first one that is not covered, which is the one to warn about. */
  readonly firstShortfall: Shortfall | null;
}

export interface TimelineResult {
  readonly rows: readonly TimelineRow[];
  readonly startBalanceCents: Cents;
  /** The balance at the end of the horizon: "left this cycle". */
  readonly leftThisCycleCents: Cents;
  readonly lowest: LowestPoint;
  /** Lowest point minus the cushion: what is safe to spend right now. */
  readonly safeToSpendNowCents: Cents;
  readonly coverage: Coverage;
  /** Bills whose amount has not been confirmed yet. */
  readonly estimatesCount: number;
}

export interface TimelineOptions {
  readonly events: readonly TimelineInput[];
  /** Effective current balance (latest snapshot plus anything since cleared). */
  readonly startBalanceCents: Cents;
  /** How much must remain for a withdrawal to count as covered. Default 0. */
  readonly cushionCents?: Cents;
}

/* -------------------------------------------------------------------------- */
/* Pay periods                                                               */
/* -------------------------------------------------------------------------- */

export interface PaySchedule {
  readonly id: string;
  readonly ownerId: string;
  /** Any real payday; the rest are every 14 days from here. */
  readonly anchorDate: PlainDate;
  readonly defaultCents: Cents;
}

export interface PayPeriodLowest {
  readonly cents: Cents;
  readonly date: PlainDate | null;
  readonly afterEventId: string | null;
}

export interface PayPeriod {
  readonly label: string;
  readonly start: PlainDate;
  readonly end: PlainDate;
  /** True for the stub period between today and the first upcoming payday. */
  readonly isCurrentPartial: boolean;
  /** Everything arriving: cheques, deposits, one-off income. */
  readonly inCents: Cents;
  /** Automatic withdrawals, as a positive magnitude. */
  readonly autoCents: Cents;
  /** Flexible bills and transfers, as a positive magnitude. */
  readonly flexibleCents: Cents;
  /** `in - auto - flexible`. */
  readonly leftCents: Cents;
  readonly lowest: PayPeriodLowest | null;
  readonly allAutoCovered: boolean;
  /** Cheques counted here that are projected rather than already placed. */
  readonly projectedPaychequeIds: readonly string[];
  /**
   * How much more could be moved into savings during this period without any
   * later automatic withdrawal going short.
   *
   * This is the same question as "safe to spend now", asked at a later point
   * on the timeline: money taken out here lowers every balance after it, so
   * the limit is the lowest point from this period forward, minus the cushion.
   * It looks all the way to the horizon, not just to the end of the period,
   * because a squeeze three weeks out is still caused by saving today.
   *
   * Savings already placed in this period are part of the running balance, so
   * this is room *on top of* what is planned - which is what makes a third
   * paycheque actionable rather than merely absorbed.
   *
   * Negative means this period is already short; the UI shows the shortfall
   * rather than a room of zero.
   */
  readonly roomToSaveCents: Cents;
}

export interface PayPeriodOptions {
  readonly timeline: TimelineResult;
  readonly paySchedules: readonly PaySchedule[];
  readonly today: PlainDate;
  /** How many two-week windows to report. */
  readonly periodCount?: number;
  /**
   * Whose paydays the windows are anchored on. The windows in the spreadsheet
   * run from Dax's paydays (HANDOFF section 5 rule 1).
   */
  readonly anchorScheduleId?: string;
  readonly cushionCents?: Cents;
}

/* -------------------------------------------------------------------------- */
/* Horizon                                                                   */
/* -------------------------------------------------------------------------- */

export interface HorizonOptions {
  readonly today: PlainDate;
  readonly paySchedules: readonly PaySchedule[];
  /**
   * "Through the day before the Nth upcoming paycheque" (section 14 q7).
   * The default of 4 reproduces the spreadsheet's Dec 2 end.
   */
  readonly paychequeCount?: number;
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                    */
/* -------------------------------------------------------------------------- */

export type BudgetSection = "income" | "fixed" | "variable";

export interface BudgetLineInput {
  readonly id?: string;
  readonly name: string;
  readonly section: Exclude<BudgetSection, "income">;
  readonly monthlyCents: Cents;
  /** Set only where the yearly figure is not monthly x 12. */
  readonly yearlyCentsOverride?: Cents | undefined;
}

export interface BudgetIncomeInput {
  readonly netMonthlyCents: Cents;
  /**
   * Carol's stated yearly net, which is not exactly monthly x 12
   * (section 14 q2). Her figure is used as given.
   */
  readonly netYearlyCents: Cents;
}

export interface BudgetLineResult {
  readonly name: string;
  readonly monthlyCents: Cents;
  readonly yearlyCents: Cents;
  /** Share of this line's OWN section, as the sheet's "% of Total" does. */
  readonly sharePct: number;
}

export interface BudgetSectionResult {
  readonly lines: readonly BudgetLineResult[];
  readonly monthlyCents: Cents;
  readonly yearlyCents: Cents;
}

export interface BudgetResult {
  readonly income: BudgetIncomeInput;
  readonly fixed: BudgetSectionResult;
  readonly variable: BudgetSectionResult;
  readonly totalMonthlyCents: Cents;
  readonly totalYearlyCents: Cents;
  /** What is left after everything: the hero number on the Budget screen. */
  readonly balanceMonthlyCents: Cents;
  readonly balanceYearlyCents: Cents;
}

/* -------------------------------------------------------------------------- */
/* Goals, net worth, retirement                                              */
/* -------------------------------------------------------------------------- */

// Goals used to be computed here, by `computeGoal`, which required a target.
// They are earmarks against one real savings account now, and a target is
// optional because a trip has no set cost. One rule, in `savings.ts`: see
// `Earmark`, `EarmarkProgress` and `earmarkProgress`.

export interface AssetInput {
  readonly name: string;
  readonly cents: Cents;
}

export interface NetWorthResult {
  readonly assetsCents: Cents;
  readonly liabilitiesCents: Cents;
  readonly netWorthCents: Cents;
}

export interface RetirementInputs {
  /** Current RRSPs plus the contributions still to come. An input, not derived. */
  readonly rrspCurrentPlusContribCents: Cents;
  /** The mortgage payment, redirected to RRSPs once the mortgage is paid off. */
  readonly mortgageMonthlyCents: Cents;
  readonly redirectYears: number;
  readonly flatGrowthPct: number;
  /** Off by default: the sheet applies the growth once (section 14 q3). */
  readonly compoundYearly?: boolean | undefined;
  readonly drawdownYears: number;
  readonly govPensionAnnualCents: Cents;
  readonly retirementExpensesAnnualCents: Cents;
}

export interface RetirementResult {
  readonly mortgageRedirectCents: Cents;
  readonly baseBeforeGrowthCents: Cents;
  readonly growthCents: Cents;
  readonly rrspAt65Cents: Cents;
  readonly annualDrawCents: Cents;
  readonly extraPerYearCents: Cents;
  readonly extraPerMonthCents: Cents;
  /** Net worth plus the RRSPs at 65. */
  readonly totalForRetirementCents: Cents;
}

export interface HouseholdSettings {
  readonly cushionCents: Cents;
  readonly horizonPaychequeCount: number;
  readonly weekendRule: WeekendRule;
}
