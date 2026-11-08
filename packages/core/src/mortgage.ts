/**
 * Mortgage amortization and the effect of lump-sum prepayments.
 *
 * This exists because the point of Headroom is not budgeting. The household
 * saves hard so it can throw a lump sum at the mortgage once a year, and the
 * number that makes that feel worth doing is the payoff date. Without it, a
 * third paycheque is "more money somewhere in the running balance"; with it,
 * the same cheque is "three weeks earlier".
 *
 * No real figures appear in this file. The household's terms live in the
 * git-ignored seed, and the committed tests use the synthetic fixture.
 *
 * ## No floats, including here
 *
 * Interest is the one place money genuinely wants a fraction, so it is the
 * place a float would normally sneak in. It does not. Interest for a period is
 *
 *     balance x rateBasisPoints / (10_000 x periodsPerYear)
 *
 * evaluated with `mulDivRoundHalfUp`, which multiplies in `bigint` before
 * dividing and rounds halves away from zero. The rate is an integer number of
 * basis points, never a decimal.
 *
 * ## Why the rate is simply divided by the number of payments
 *
 * The household's own spreadsheet divides the annual rate by the number of
 * payments a year. Real Canadian mortgages quote a rate compounded
 * semi-annually, which gives a periodic rate a little under one percent lower.
 * Across a remaining term of a few years that is worth a couple of hundred
 * dollars of interest and does not move the payoff date by even one payment,
 * so the default here reproduces the spreadsheet rather than silently
 * disagreeing with the document the household actually reads. The lender's
 * convention is available through `compounding` as a household setting.
 *
 * The integer-cent arithmetic below was checked against the household's
 * mortgage workbook: after a dozen payments the two agree to within one cent,
 * the difference being that the workbook carries floats and this carries exact
 * cents. The workbook also ends its term with a small balance still owing
 * rather than reaching zero, because one of its prepayment rows is labelled
 * with a larger amount than its payment column actually adds. That is a
 * discrepancy inside the workbook, not a disagreement with this function, and
 * it is exactly the failure mode that storing a number in two places invites.
 */
import { addDays, compareDates, daysBetween, isPaydayOn, parseDate } from "./dates.js";
import type { PlainDate } from "./dates.js";
import { mulDivRoundHalfUp, sumCents } from "./money.js";
import type { Cents } from "./money.js";

/** Payments a year for a biweekly mortgage: every fourteen days, so 26. */
export const BIWEEKLY_PERIODS_PER_YEAR = 26;

/** Days between payments on a biweekly mortgage. */
export const BIWEEKLY_CADENCE_DAYS = 14;

/**
 * How the quoted annual rate becomes a per-period rate.
 *
 * - `simple_division` divides by the number of payments a year. This is what
 *   the spreadsheet does, and the default, so the two agree.
 * - `semi_annual` uses the Canadian convention, where the quoted rate is
 *   compounded semi-annually. More correct against a real lender, and
 *   available as a household setting.
 */
export type RateCompounding = "simple_division" | "semi_annual";

export interface MortgageTerms {
  /** Balance owing immediately after the payment on {@link MortgageTerms.asOf}. */
  readonly balanceCents: Cents;
  /** The date of the payment that produced the balance. */
  readonly asOf: PlainDate;
  /** The annual rate in whole basis points: 525 is 5.25%. */
  readonly rateBasisPoints: number;
  /** The regular payment, as a positive magnitude. */
  readonly paymentCents: Cents;
  /** Any real payment date; the rest fall every `cadenceDays` from it. */
  readonly paymentAnchorDate: PlainDate;
  /** Payments a year, used only as the rate divisor. Default 26. */
  readonly periodsPerYear?: number;
  /** Days between payments. Default 14. */
  readonly cadenceDays?: number;
  readonly compounding?: RateCompounding;
}

/**
 * A lump sum actually paid, or planned. Append-only in the database: a
 * prepayment that happened is a fact, and the year's total is derived from
 * these rather than stored.
 */
export interface Prepayment {
  readonly id?: string;
  readonly date: PlainDate;
  /** Positive magnitude. */
  readonly cents: Cents;
  readonly note?: string;
}

export interface AmortizationRow {
  readonly date: PlainDate;
  /** What leaves the account: the regular payment, or less on the last one. */
  readonly paymentCents: Cents;
  readonly interestCents: Cents;
  readonly principalCents: Cents;
  /** Lump sums applied with this payment. */
  readonly prepaymentCents: Cents;
  /** Owing once this row has happened. */
  readonly balanceCents: Cents;
}

export interface AmortizationResult {
  readonly rows: readonly AmortizationRow[];
  /** The date of the payment that clears the balance. */
  readonly payoffDate: PlainDate;
  readonly totalInterestCents: Cents;
  readonly totalPrepaidCents: Cents;
  readonly paymentCount: number;
}

/** Guard against a payment too small to ever clear the balance. */
const MAX_PERIODS = 2600; // a hundred years of biweekly payments

/**
 * Interest for one period on the given balance.
 *
 * `semi_annual` turns the quoted rate into a per-period rate by taking the
 * `2 / periodsPerYear` power of the half-yearly factor. There is no integer
 * identity for that root, so it is computed once on the rate itself - never on
 * an amount of money - and scaled to a billionth before being applied through
 * integer arithmetic. Money stays exact either way.
 */
export function periodInterestCents(
  balanceCents: Cents,
  rateBasisPoints: number,
  periodsPerYear: number = BIWEEKLY_PERIODS_PER_YEAR,
  compounding: RateCompounding = "simple_division",
): Cents {
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new RangeError(
      `The rate must be a whole number of basis points; received ${String(rateBasisPoints)}.`,
    );
  }
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1) {
    throw new RangeError(
      `periodsPerYear must be a positive whole number; received ${String(periodsPerYear)}.`,
    );
  }
  if (balanceCents <= 0n) return 0n;

  if (compounding === "simple_division") {
    // balance x bp / (10_000 x periodsPerYear), exact in bigint.
    return mulDivRoundHalfUp(balanceCents, BigInt(rateBasisPoints), 10_000n * BigInt(periodsPerYear));
  }

  // The semi-annual convention needs a 13th root, which has no exact integer
  // form, so this one rate is computed as a float and immediately pinned to an
  // integer number of billionths. The float touches the RATE only: it never
  // holds an amount of money, and the interest itself is still computed by
  // integer multiply-then-divide below. Rounding a rate to nine places is
  // worth a fraction of a cent on any balance this household will ever carry.
  const perPeriod = (1 + rateBasisPoints / 20_000) ** (2 / periodsPerYear) - 1;
  // eslint-disable-next-line no-restricted-properties -- rounds a rate, not money; see above
  const scaled = BigInt(Math.round(perPeriod * 1e9));
  return mulDivRoundHalfUp(balanceCents, scaled, 1_000_000_000n);
}

/**
 * Run the mortgage forward to zero.
 *
 * Payments fall every `cadenceDays` from the anchor. A lump sum is applied
 * with the first payment on or after its date, which is how the spreadsheet
 * records them. The final payment is whatever clears the balance, so it is
 * usually smaller than the regular one.
 */
export function amortize(
  terms: MortgageTerms,
  prepayments: readonly Prepayment[] = [],
): AmortizationResult {
  const periodsPerYear = terms.periodsPerYear ?? BIWEEKLY_PERIODS_PER_YEAR;
  const cadenceDays = terms.cadenceDays ?? BIWEEKLY_CADENCE_DAYS;
  const compounding = terms.compounding ?? "simple_division";

  if (terms.paymentCents <= 0n) {
    throw new RangeError("The mortgage payment must be a positive amount.");
  }
  if (!Number.isInteger(cadenceDays) || cadenceDays < 1) {
    throw new RangeError(
      `cadenceDays must be a positive whole number; received ${String(cadenceDays)}.`,
    );
  }
  // A rate divisor that disagrees with the cadence would quietly misprice every
  // period, so the two have to describe the same schedule.
  if (Math.abs(cadenceDays * periodsPerYear - 365) > 31) {
    throw new RangeError(
      `cadenceDays ${String(cadenceDays)} and periodsPerYear ${String(periodsPerYear)} ` +
        `do not describe the same schedule.`,
    );
  }
  if (cadenceDays === BIWEEKLY_CADENCE_DAYS && !isPaydayOn(terms.paymentAnchorDate, terms.asOf)) {
    throw new Error(
      `asOf ${terms.asOf} is not a payment date for the schedule anchored on ${terms.paymentAnchorDate}.`,
    );
  }

  const pending = [...prepayments].sort(
    (a, b) => compareDates(a.date, b.date) || (a.id ?? "").localeCompare(b.id ?? ""),
  );
  let nextPrepayment = 0;

  // Prepayments dated on or before asOf are already inside the opening balance.
  while (
    nextPrepayment < pending.length &&
    compareDates(pending[nextPrepayment]!.date, terms.asOf) <= 0
  ) {
    nextPrepayment += 1;
  }

  const rows: AmortizationRow[] = [];
  let balance = terms.balanceCents;
  let date = terms.asOf;
  let totalInterest = 0n;
  let totalPrepaid = 0n;

  while (balance > 0n) {
    if (rows.length >= MAX_PERIODS) {
      throw new Error(
        `The mortgage does not pay off within ${String(MAX_PERIODS)} payments. ` +
          `A payment of ${terms.paymentCents.toString()} cents may not cover the interest.`,
      );
    }

    date = addDays(date, cadenceDays);
    const interest = periodInterestCents(
      balance,
      terms.rateBasisPoints,
      periodsPerYear,
      compounding,
    );

    if (interest >= terms.paymentCents && balance + interest > terms.paymentCents) {
      throw new Error(
        `A payment of ${terms.paymentCents.toString()} cents does not cover ` +
          `${interest.toString()} cents of interest, so the balance would never fall.`,
      );
    }

    // The last payment is only as large as it needs to be.
    const payment =
      balance + interest < terms.paymentCents ? balance + interest : terms.paymentCents;
    const principal = payment - interest;
    balance -= principal;
    totalInterest += interest;

    // Lump sums land with the first payment on or after their date. The test
    // is against this payment's date, not the next one's: comparing forward to
    // the end of the period credits the money with the payment *before* the
    // date it was made, which pays off the mortgage a fortnight early on paper.
    let prepaid = 0n;
    while (
      nextPrepayment < pending.length &&
      compareDates(pending[nextPrepayment]!.date, date) <= 0 &&
      balance > 0n
    ) {
      const lump = pending[nextPrepayment]!.cents;
      const applied = lump > balance ? balance : lump;
      balance -= applied;
      prepaid += applied;
      totalPrepaid += applied;
      nextPrepayment += 1;
    }

    rows.push({
      date,
      paymentCents: payment,
      interestCents: interest,
      principalCents: principal,
      prepaymentCents: prepaid,
      balanceCents: balance,
    });
  }

  const last = rows[rows.length - 1];
  if (!last) {
    // Nothing owing to begin with.
    return {
      rows: [],
      payoffDate: terms.asOf,
      totalInterestCents: 0n,
      totalPrepaidCents: 0n,
      paymentCount: 0,
    };
  }

  return {
    rows,
    payoffDate: last.date,
    totalInterestCents: totalInterest,
    totalPrepaidCents: totalPrepaid,
    paymentCount: rows.length,
  };
}

export interface PayoffDelta {
  readonly payoffDate: PlainDate;
  readonly withoutPayoffDate: PlainDate;
  /** Days the payoff moves earlier. Positive means sooner. */
  readonly daysEarlier: number;
  /** Interest saved. Positive means less interest paid. */
  readonly interestSavedCents: Cents;
  readonly paymentsSaved: number;
}

/**
 * What one more lump sum would buy, against a baseline plan.
 *
 * This is the sentence the savings screen exists to say: not "you have saved
 * this much" but "this much moves the payoff date to here". It is also how the
 * cost of skipping a year becomes visible, which is otherwise invisible until
 * the year is gone.
 */
export function payoffDelta(
  terms: MortgageTerms,
  baseline: readonly Prepayment[],
  extra: Prepayment,
): PayoffDelta {
  const without = amortize(terms, baseline);
  const withExtra = amortize(terms, [...baseline, extra]);

  return {
    payoffDate: withExtra.payoffDate,
    withoutPayoffDate: without.payoffDate,
    daysEarlier: daysBetween(withExtra.payoffDate, without.payoffDate),
    interestSavedCents: without.totalInterestCents - withExtra.totalInterestCents,
    paymentsSaved: without.paymentCount - withExtra.paymentCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Prepayment privilege                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The window a prepayment allowance resets on. Dax confirmed the household's
 * runs on the calendar year, which is why a lump sum can legitimately land in
 * late December, just before the reset.
 */
export type PrivilegePeriod = "calendar_year";

export interface LumpSumRoom {
  /** The allowance for the current window. */
  readonly capCents: Cents;
  /** Already prepaid inside the current window. */
  readonly usedCents: Cents;
  /** What is left. Never negative. */
  readonly roomCents: Cents;
  /** True when the allowance is already spent. */
  readonly isUsedUp: boolean;
  /** The first day of the next window. */
  readonly resetsOn: PlainDate;
  readonly period: PrivilegePeriod;
}

/**
 * How much more can be prepaid in the current allowance window.
 *
 * The household's cap sits far above what they plan to prepay, so this is not
 * expected to bind. It is here so a screen can state the ceiling rather than
 * leave it to be remembered, not to nag.
 */
export function lumpSumRoom(options: {
  readonly today: PlainDate;
  readonly capCents: Cents;
  readonly prepayments: readonly Prepayment[];
  readonly period?: PrivilegePeriod;
}): LumpSumRoom {
  const period = options.period ?? "calendar_year";
  const { year } = parseDate(options.today);

  const used = sumCents(
    options.prepayments
      .filter((prepayment) => parseDate(prepayment.date).year === year)
      .map((prepayment) => prepayment.cents),
  );

  const room = options.capCents - used;

  return {
    capCents: options.capCents,
    usedCents: used,
    roomCents: room > 0n ? room : 0n,
    isUsedUp: room <= 0n,
    resetsOn: `${String(year + 1).padStart(4, "0")}-01-01`,
    period,
  };
}
