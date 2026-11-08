/**
 * Net worth and the retirement outlook (HANDOFF section 4.5 and 6.6).
 *
 * The retirement formula is reproduced **exactly as the spreadsheet does it**,
 * including the parts an adviser might do differently:
 *
 *  - the growth rate is applied once to the total, not compounded yearly;
 *  - the mortgage payment is redirected to RRSPs for a fixed number of years
 *    after the mortgage is paid off, with no growth of its own;
 *  - the drawdown is a flat division by the number of years.
 *
 * Carol is the financial expert in the house and her sheet is the spec
 * (section 1). Every input is an editable setting, and `compoundYearly` is
 * offered as an alternative that is off by default (section 14 q3).
 */
import { compoundByPercent, divRoundHalfUp, growByPercent, sumCents, type Cents } from "./money.js";
import type { AssetInput, NetWorthResult, RetirementInputs, RetirementResult } from "./types.js";

/**
 * Own minus owe.
 *
 * Both lists hold positive magnitudes: a liability of $1,234.56 is stored as
 * `123456n`, not as a negative. That matches how the sheet lists them and how
 * the UI shows "own" and "owe" side by side.
 */
export function computeNetWorth(options: {
  readonly assets: readonly AssetInput[];
  readonly liabilities: readonly AssetInput[];
}): NetWorthResult {
  const assetsCents = sumCents(options.assets.map((asset) => asset.cents));
  const liabilitiesCents = sumCents(options.liabilities.map((liability) => liability.cents));

  return {
    assetsCents,
    liabilitiesCents,
    netWorthCents: assetsCents - liabilitiesCents,
  };
}

export function computeRetirement(options: {
  readonly inputs: RetirementInputs;
  readonly netWorthCents: Cents;
}): RetirementResult {
  const { inputs, netWorthCents } = options;

  if (!Number.isInteger(inputs.redirectYears) || inputs.redirectYears < 0) {
    throw new RangeError(`redirectYears must be a whole number of years; received ${String(inputs.redirectYears)}.`);
  }
  if (!Number.isInteger(inputs.drawdownYears) || inputs.drawdownYears < 1) {
    throw new RangeError(
      `drawdownYears must be at least 1; received ${String(inputs.drawdownYears)}. Dividing the pot by zero years has no meaning.`,
    );
  }

  // The mortgage payment, once the mortgage is gone, going into RRSPs instead.
  const mortgageRedirectCents =
    inputs.mortgageMonthlyCents * 12n * BigInt(inputs.redirectYears);

  const baseBeforeGrowthCents = inputs.rrspCurrentPlusContribCents + mortgageRedirectCents;

  const growthPct = BigInt(inputs.flatGrowthPct);
  const rrspAt65Cents = inputs.compoundYearly
    ? compoundByPercent(baseBeforeGrowthCents, growthPct, inputs.redirectYears)
    : growByPercent(baseBeforeGrowthCents, growthPct);

  const growthCents = rrspAt65Cents - baseBeforeGrowthCents;

  // A flat division of the pot across the years in retirement.
  const annualDrawCents = divRoundHalfUp(rrspAt65Cents, BigInt(inputs.drawdownYears));

  const extraPerYearCents =
    annualDrawCents + inputs.govPensionAnnualCents - inputs.retirementExpensesAnnualCents;

  return {
    mortgageRedirectCents,
    baseBeforeGrowthCents,
    growthCents,
    rrspAt65Cents,
    annualDrawCents,
    extraPerYearCents,
    extraPerMonthCents: divRoundHalfUp(extraPerYearCents, 12n),
    totalForRetirementCents: netWorthCents + rrspAt65Cents,
  };
}
