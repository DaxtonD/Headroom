/**
 * Money in Headroom is ALWAYS integer cents held in a `bigint`.
 *
 * There are no floats anywhere in this module, and no `number` ever holds an
 * amount of money. `number` appears only for counts, percentages-as-integers
 * and array indexes. Formatting builds the decimal string by integer division
 * rather than dividing by 100, so a value can never lose precision on its way
 * to the screen.
 *
 * Display locale is `en-CA`, currency CAD, and a negative amount is written
 * with U+2212 MINUS SIGN (not the ASCII hyphen-minus), per the design tokens.
 */

/** An amount of money, in integer cents. Negative means money leaving the account. */
export type Cents = bigint;

/** U+2212 MINUS SIGN. The only minus that reaches the screen. */
export const MINUS_SIGN = "−";

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build cents from a whole number of cents.
 * Throws on a non-integer, so a float can never slip in as money.
 */
export function cents(value: number | bigint): Cents {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `Money must be a whole number of cents; received ${String(value)}. Floats are never money.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Cents value ${String(value)} is outside the safe integer range.`);
  }
  return BigInt(value);
}

/**
 * Parse user input ("1234.56", "$1,234.56", "−12.00", "(12.00)") into cents.
 *
 * Deliberately strict: at most two decimal places, no exponent notation, no
 * silent truncation. Accepts the ASCII hyphen, U+2212 and accounting
 * parentheses as negatives. Never goes through `parseFloat`.
 */
export function parseCents(input: string): Cents {
  const trimmed = input.trim();
  if (trimmed === "") throw new SyntaxError("Enter an amount.");

  let body = trimmed;
  let negative = false;

  // Accounting style: (12.34) means negative.
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1).trim();
  }

  // Leading or trailing sign, ASCII hyphen or U+2212.
  const signMatch = /^([-−+])?(.*?)([-−+])?$/u.exec(body);
  if (signMatch) {
    const lead = signMatch[1];
    const tail = signMatch[3];
    if (lead && tail) throw new SyntaxError(`Amount "${input}" has two signs.`);
    const sign = lead ?? tail;
    if (sign === "-" || sign === "−") negative = !negative;
    body = (signMatch[2] ?? "").trim();
  }

  // Strip currency symbol, thousands separators and any whitespace (incl. NBSP).
  body = body.replace(/^\$/u, "").replace(/[,\s\u00A0\u202F]/gu, "");

  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/u.test(body)) {
    throw new SyntaxError(
      `"${input}" is not an amount. Use digits with at most two decimal places, for example 1234.56.`,
    );
  }

  const [wholePart = "0", fractionPart = ""] = body.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  const fraction = fractionPart.padEnd(2, "0");

  const magnitude = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -magnitude : magnitude;
}

/* -------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* -------------------------------------------------------------------------- */

/** Sum any sequence of cents. Returns 0n for an empty sequence. */
export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Absolute value of an amount. */
export function absCents(value: Cents): Cents {
  return value < 0n ? -value : value;
}

/** The smaller of two amounts. */
export function minCents(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}

/** The larger of two amounts. */
export function maxCents(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}

/**
 * Exact integer division rounding halves away from zero.
 *
 * This matches Python's `decimal.ROUND_HALF_UP`, which is what produced the
 * expected values in the seed file, and what the spreadsheet does.
 * `divRoundHalfUp(-5n, 10n)` is `-1n`, not `0n`.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero.");

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  // floor((2|n| + |d|) / (2|d|)) rounds the magnitude half-up exactly.
  const magnitude = (2n * absNumerator + absDenominator) / (2n * absDenominator);
  return negative ? -magnitude : magnitude;
}

/**
 * `value * numerator / denominator`, rounded half away from zero, with no
 * intermediate loss: the multiplication happens in bigint before dividing.
 */
export function mulDivRoundHalfUp(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return divRoundHalfUp(value * numerator, denominator);
}

/**
 * Apply a whole-number percentage: `applyPercent(1000n, 10n)` is `100n`.
 * Used for the retirement growth rate, which Carol applies as a flat percent.
 */
export function applyPercent(value: Cents, percent: bigint): Cents {
  return mulDivRoundHalfUp(value, percent, 100n);
}

/**
 * Grow an amount by a whole-number percentage, applied once and not compounded:
 * `growByPercent(1000n, 10n)` is `1100n`. This reproduces the retirement
 * formula in the spreadsheet, where the rate is applied once to the total.
 */
export function growByPercent(value: Cents, percent: bigint): Cents {
  return mulDivRoundHalfUp(value, 100n + percent, 100n);
}

/**
 * Compound an amount at a whole-number percentage for a number of whole years.
 * Offered as an editable alternative to {@link growByPercent} (HANDOFF
 * section 14 question 3, default off), rounding once per year.
 */
export function compoundByPercent(value: Cents, percent: bigint, years: number): Cents {
  if (!Number.isInteger(years) || years < 0) {
    throw new RangeError(`years must be a non-negative whole number; received ${String(years)}.`);
  }
  let result = value;
  for (let year = 0; year < years; year += 1) {
    result = growByPercent(result, percent);
  }
  return result;
}

/**
 * Each value's share of the total, as a whole percent rounded half up.
 * "% of Total" in the sheet is a share of its own section, so the caller
 * passes that section's total. Returns 0 for every entry when the total is 0.
 */
export function percentShare(value: Cents, total: Cents): number {
  if (total === 0n) return 0;
  return Number(divRoundHalfUp(value * 100n, total));
}

/**
 * Share of a total to one decimal place, as a number like `83.3`.
 * Used for goal progress, which the seed states to one decimal.
 */
export function percentShareOneDecimal(value: Cents, total: Cents): number {
  if (total === 0n) return 0;
  return Number(divRoundHalfUp(value * 1000n, total)) / 10;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export interface FormatCentsOptions {
  /** Include the `$` symbol. Default true. */
  readonly currencySymbol?: boolean;
  /** Group thousands with commas. Default true. */
  readonly grouping?: boolean;
  /** Always show a sign, so positives read `+$12.00`. Default false. */
  readonly alwaysSign?: boolean;
}

/**
 * Format cents as `en-CA` CAD, for example `$1,234.56` or `−$45.00`.
 *
 * Built by integer division, so no float is involved and the output is exact
 * for any magnitude a `bigint` can hold. Negatives use U+2212.
 */
export function formatCents(value: Cents, options: FormatCentsOptions = {}): string {
  const { currencySymbol = true, grouping = true, alwaysSign = false } = options;

  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;

  const wholeDigits = whole.toString();
  const grouped = grouping ? wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",") : wholeDigits;
  const fractionDigits = fraction.toString().padStart(2, "0");

  const sign = negative ? MINUS_SIGN : alwaysSign ? "+" : "";
  const symbol = currencySymbol ? "$" : "";

  return `${sign}${symbol}${grouped}.${fractionDigits}`;
}

/**
 * Format for a screen reader or a plain-text export, where U+2212 and `$`
 * can read poorly: `-1234.56`.
 */
export function formatCentsPlain(value: Cents): string {
  return formatCents(value, { currencySymbol: false, grouping: false }).replace(MINUS_SIGN, "-");
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cents as a JSON-safe string. `bigint` cannot be serialised by `JSON.stringify`,
 * and a `number` would risk precision, so cents cross the wire as strings.
 */
export function centsToJson(value: Cents): string {
  return value.toString();
}

/** Read cents back from the wire. Rejects anything that is not a whole number. */
export function centsFromJson(value: string | number | bigint): Cents {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return cents(value);
  if (!/^[-+]?\d+$/u.test(value.trim())) {
    throw new SyntaxError(`"${value}" is not an integer-cents string.`);
  }
  return BigInt(value.trim());
}
