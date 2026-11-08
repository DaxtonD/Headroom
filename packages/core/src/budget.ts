/**
 * The monthly and yearly budget (HANDOFF section 4.3 and 6.6).
 *
 * Two details from the spreadsheet that are easy to get wrong:
 *
 *  1. "% of Total" is each line's share of **its own section** (fixed or
 *     variable), not of income. A line that is 38% of fixed expenses is not
 *     38% of what the household earns.
 *  2. The yearly income figure is Carol's stated number, which is not exactly
 *     the monthly figure times twelve (section 14 q2). Her number is used as
 *     given; line items are the ones multiplied by twelve.
 */
import { percentShare, sumCents, type Cents } from "./money.js";
import type {
  BudgetIncomeInput,
  BudgetLineInput,
  BudgetLineResult,
  BudgetResult,
  BudgetSectionResult,
  GoalInput,
  GoalResult,
} from "./types.js";
import { percentShareOneDecimal } from "./money.js";

function yearlyFor(line: BudgetLineInput): Cents {
  // An override exists for the rare line whose yearly cost is not just twelve
  // times its monthly cost.
  return line.yearlyCentsOverride ?? line.monthlyCents * 12n;
}

function summariseSection(lines: readonly BudgetLineInput[]): BudgetSectionResult {
  const monthlyCents = sumCents(lines.map((line) => line.monthlyCents));
  const yearlyCents = sumCents(lines.map(yearlyFor));

  const results: BudgetLineResult[] = lines.map((line) => ({
    name: line.name,
    monthlyCents: line.monthlyCents,
    yearlyCents: yearlyFor(line),
    // Share of this section, which is what the sheet's pie charts show.
    sharePct: percentShare(line.monthlyCents, monthlyCents),
  }));

  return { lines: results, monthlyCents, yearlyCents };
}

export function computeBudget(options: {
  readonly income: BudgetIncomeInput;
  readonly lines: readonly BudgetLineInput[];
}): BudgetResult {
  const fixedLines = options.lines.filter((line) => line.section === "fixed");
  const variableLines = options.lines.filter((line) => line.section === "variable");

  const fixed = summariseSection(fixedLines);
  const variable = summariseSection(variableLines);

  const totalMonthlyCents = fixed.monthlyCents + variable.monthlyCents;
  const totalYearlyCents = fixed.yearlyCents + variable.yearlyCents;

  return {
    income: options.income,
    fixed,
    variable,
    totalMonthlyCents,
    totalYearlyCents,
    balanceMonthlyCents: options.income.netMonthlyCents - totalMonthlyCents,
    balanceYearlyCents: options.income.netYearlyCents - totalYearlyCents,
  };
}

/** Trip fund and anything like it: progress to one decimal place. */
export function computeGoal(goal: GoalInput): GoalResult {
  return {
    name: goal.name,
    targetCents: goal.targetCents,
    savedCents: goal.savedCents,
    remainingCents: goal.targetCents - goal.savedCents,
    pct: percentShareOneDecimal(goal.savedCents, goal.targetCents),
  };
}

export function computeGoals(goals: readonly GoalInput[]): GoalResult[] {
  return goals.map(computeGoal);
}

/* -------------------------------------------------------------------------- */
/* Reimbursements                                                            */
/* -------------------------------------------------------------------------- */

export interface ReimbursementInput {
  readonly purchase: string;
  readonly cents: Cents;
  readonly submittedAt?: string | null | undefined;
  readonly paidAt?: string | null | undefined;
}

export type ReimbursementStatus = "bought" | "submitted" | "paid";

export interface ReimbursementResult {
  readonly purchase: string;
  readonly cents: Cents;
  readonly status: ReimbursementStatus;
}

export interface ReimbursementsSummary {
  readonly items: readonly ReimbursementResult[];
  /** Everything not yet paid back: the money still owed to the household. */
  readonly outstandingCents: Cents;
  readonly boughtCents: Cents;
  readonly submittedCents: Cents;
  readonly paidCents: Cents;
  readonly totalCents: Cents;
}

/** Work purchases on the Visa, tracked Bought -> Submitted -> Paid back. */
export function computeReimbursements(
  items: readonly ReimbursementInput[],
): ReimbursementsSummary {
  const results: ReimbursementResult[] = items.map((item) => ({
    purchase: item.purchase,
    cents: item.cents,
    status: item.paidAt ? "paid" : item.submittedAt ? "submitted" : "bought",
  }));

  const totalFor = (status: ReimbursementStatus): Cents =>
    sumCents(results.filter((item) => item.status === status).map((item) => item.cents));

  const boughtCents = totalFor("bought");
  const submittedCents = totalFor("submitted");
  const paidCents = totalFor("paid");

  return {
    items: results,
    boughtCents,
    submittedCents,
    paidCents,
    outstandingCents: boughtCents + submittedCents,
    totalCents: boughtCents + submittedCents + paidCents,
  };
}

/* -------------------------------------------------------------------------- */
/* Banked hours                                                              */
/* -------------------------------------------------------------------------- */

export interface BankedHoursEntryInput {
  readonly userId: string;
  /** Hours as a decimal string, e.g. "7.50". Never money, never a float. */
  readonly hours: string;
}

/**
 * Hours only, with no dollar conversion (section 14 q11).
 *
 * Summed as hundredths in `bigint` so a run of .25s and .75s cannot drift the
 * way repeated float addition would.
 */
export function sumBankedHours(entries: readonly BankedHoursEntryInput[]): string {
  let hundredths = 0n;

  for (const entry of entries) {
    const text = entry.hours.trim();
    const match = /^([-+]?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) {
      throw new SyntaxError(`"${entry.hours}" is not an hours value (use up to two decimals).`);
    }
    const sign = match[1] === "-" ? -1n : 1n;
    const whole = BigInt(match[2] ?? "0");
    const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
    hundredths += sign * (whole * 100n + fraction);
  }

  const negative = hundredths < 0n;
  const magnitude = negative ? -hundredths : hundredths;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, "0");

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
