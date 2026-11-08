/**
 * Turning a recurring amount into its monthly equivalent.
 *
 * An expense is entered once, with the amount actually billed and how often it
 * recurs. The Budget screen needs a monthly figure, and this derives it, so
 * nothing has to be typed twice and the two pages cannot drift apart.
 *
 * The conversion that matters is biweekly. Pay is every two weeks, which is 26
 * times a year, NOT 24 — so a biweekly bill costs `amount * 26 / 12` a month,
 * noticeably more than twice the amount. Treating biweekly as semi-monthly is
 * the classic version of this mistake and it understates the yearly cost by
 * two whole payments.
 *
 * A derived figure can still be overridden. Carol's sheet states the mortgage
 * at $2,509.00 a month where the derivation gives $2,510.89, and her number is
 * the spec (HANDOFF section 1); the override exists so her figure wins without
 * anyone having to re-enter the bill itself.
 */
import { divRoundHalfUp, type Cents } from "./money.js";

/** How often a recurring amount is actually charged. */
export type Cadence =
  /** The same day every month. */
  | "monthly"
  /** Every 14 days: 26 times a year, not 24. */
  | "biweekly"
  /** Once a week. */
  | "weekly"
  /** Twice a month, which is 24 times a year. */
  | "semi_monthly"
  /** Four times a year. */
  | "quarterly"
  /** Once a year. */
  | "yearly";

/**
 * How many times a year each cadence charges.
 *
 * A year is 365.25 days, so 52.18 weeks; weekly and biweekly are therefore
 * stated as exact fractions rather than rounded, and the arithmetic below
 * keeps them exact until the final rounding.
 */
const TIMES_PER_YEAR: Record<Cadence, { numerator: bigint; denominator: bigint }> = {
  monthly: { numerator: 12n, denominator: 1n },
  // 26 fortnights a year.
  biweekly: { numerator: 26n, denominator: 1n },
  // 52 weeks a year.
  weekly: { numerator: 52n, denominator: 1n },
  semi_monthly: { numerator: 24n, denominator: 1n },
  quarterly: { numerator: 4n, denominator: 1n },
  yearly: { numerator: 1n, denominator: 1n },
};

/**
 * The monthly cost of an amount charged at this cadence.
 *
 * Exact: the multiplication happens in `bigint` before the division, and the
 * single rounding is half away from zero, matching the spreadsheet.
 */
export function monthlyEquivalentCents(cents: Cents, cadence: Cadence): Cents {
  const { numerator, denominator } = TIMES_PER_YEAR[cadence];
  // amount * timesPerYear / 12
  return divRoundHalfUp(cents * numerator, denominator * 12n);
}

/** The yearly cost of an amount charged at this cadence. Exact, no rounding. */
export function yearlyEquivalentCents(cents: Cents, cadence: Cadence): Cents {
  const { numerator, denominator } = TIMES_PER_YEAR[cadence];
  return divRoundHalfUp(cents * numerator, denominator);
}

/** How many times a year, as a number, for display ("26 times a year"). */
export function timesPerYear(cadence: Cadence): number {
  const { numerator, denominator } = TIMES_PER_YEAR[cadence];
  return Number(numerator) / Number(denominator);
}

/**
 * The cadence a schedule charges at.
 *
 * Maps the scheduling rules the timeline uses onto the plain question the
 * budget asks: how often does this actually come out?
 */
export function cadenceOfSchedule(
  schedule:
    | { readonly type: "monthly" }
    | { readonly type: "monthly_last" }
    | { readonly type: "relative_to_pay" }
    | { readonly type: "biweekly" }
    | { readonly type: "flexible"; readonly frequency: "monthly" | "per_pay_period" },
): Cadence {
  switch (schedule.type) {
    case "monthly":
    case "monthly_last":
      return "monthly";
    // Follows a biweekly payday, so it recurs with the paydays.
    case "relative_to_pay":
    case "biweekly":
      return "biweekly";
    case "flexible":
      return schedule.frequency === "per_pay_period" ? "biweekly" : "monthly";
    default: {
      const exhaustive: never = schedule;
      throw new Error(`Unknown schedule: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface MonthlyFigure {
  readonly monthlyCents: Cents;
  readonly yearlyCents: Cents;
  /** True when a stated figure was used instead of the derived one. */
  readonly overridden: boolean;
  /** What the derivation gave, even when overridden, so the UI can show both. */
  readonly derivedMonthlyCents: Cents;
}

/**
 * The monthly and yearly cost of a recurring expense, with an optional stated
 * monthly figure taking precedence.
 *
 * When overridden, the yearly figure is twelve times the stated monthly one:
 * if someone has said what the month costs, the year follows from that rather
 * than from the derivation they chose to override.
 */
export function monthlyFigureFor(options: {
  readonly cents: Cents;
  readonly cadence: Cadence;
  readonly monthlyOverrideCents?: Cents | null | undefined;
}): MonthlyFigure {
  const derivedMonthlyCents = monthlyEquivalentCents(options.cents, options.cadence);
  const override = options.monthlyOverrideCents;

  if (override === null || override === undefined) {
    return {
      monthlyCents: derivedMonthlyCents,
      yearlyCents: yearlyEquivalentCents(options.cents, options.cadence),
      overridden: false,
      derivedMonthlyCents,
    };
  }

  return {
    monthlyCents: override,
    yearlyCents: override * 12n,
    overridden: true,
    derivedMonthlyCents,
  };
}
