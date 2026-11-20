/**
 * The four things the Year screen can say that nothing else can.
 *
 * `chequeCalendar.ts` answers one question - which months hold a third
 * paycheque or a third mortgage payment - and answers it from the pay
 * schedules alone, which is what makes it honest fourteen months out. This
 * module adds four more, asked for on 2026-11-20 after the household had been
 * using that screen for a while.
 *
 *  1. **The bills that do not come every month.** Yearly insurance, a
 *     quarterly utility, the annual subscriptions. These are exactly the ones
 *     nobody remembers until they land, and they are invisible on a ledger
 *     whose horizon is a fortnight.
 *  2. **What to set aside each month so they are already paid for.** Two
 *     figures: the obvious one, and the one that actually works. See
 *     {@link setAsideFor}, where the difference between them is the point.
 *  3. **Which windfall pays for which squeeze.** The cheque calendar lists
 *     good months and bad months separately; this says which good month is
 *     the one covering which bad one, and - the part worth knowing - when the
 *     bad one arrives first.
 *  4. **Where the balance ends each month.** The ledger's running balance,
 *     coarsened to one figure a month and carried out to the end of the year.
 *
 * ## What is a projection and what is not
 *
 * Numbers 1 to 3 need no amount to be verified and no bill to be entered
 * twice; they are read straight off the schedules and the stated amounts, so
 * they are as true in fourteen months as they are tomorrow.
 *
 * Number 4 is not like that, and the screen says so in as many words. A
 * balance fourteen months out assumes every bill costs what it costs today
 * and that nothing is bought in between, which is false the moment anybody
 * buys groceries. It earns its place anyway, because the SHAPE is right even
 * when the level is not: the month that dips lowest is still the month that
 * dips lowest.
 *
 * ## Everything here is pure
 *
 * No dates are read from a clock and no amount is derived from anything but
 * its inputs, which is what lets the tests pin a date and get an answer that
 * does not change with the calendar.
 */
import { daysInMonth, formatMonthAndYear, nextMonth, parseDate } from "./dates.js";
import type { PlainDate } from "./dates.js";
import type { Cents } from "./money.js";
import type { Cadence } from "./monthlyEquivalent.js";

/* -------------------------------------------------------------------------- */
/* What counts as irregular                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cadence that does not land in every month.
 *
 * Monthly, semi-monthly, weekly and biweekly all turn up every month, so
 * they are already in the household's ordinary rhythm and there is nothing to
 * warn about. Quarterly and yearly are the two that skip months, and skipping
 * a month is the whole reason a bill gets forgotten.
 *
 * Biweekly is deliberately not in here even though it lands three times in
 * some months - that is the cheque calendar's job, and it is a different
 * question.
 */
export function isIrregular(cadence: Cadence): boolean {
  return cadence === "yearly" || cadence === "quarterly";
}

/* -------------------------------------------------------------------------- */
/* The inputs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One movement of money, already resolved against the account being
 * projected.
 *
 * `deltaCents` is a delta and not an amount: it is what this move does to
 * THIS account, which is a question only `accountDelta` in `timeline.ts` is
 * allowed to answer. Passing a delta in rather than an amount plus two
 * account ids is what keeps that rule true - there is nothing in this file
 * that could decide a sign, because there is no sign left to decide.
 */
export interface ProjectedMove {
  readonly date: PlainDate;
  readonly name: string;
  /** Negative leaves the account, positive arrives in it. */
  readonly deltaCents: Cents;
}

/**
 * One irregular bill, landing on a date.
 *
 * Passed in beside the moves rather than picked out of them, because the two
 * come from different places and have to. The balance is projected from the
 * LEDGER's own rows for as far as the ledger reaches - which is what keeps
 * this month's figure equal to the one on the ledger screen - and a ledger row
 * knows its amount and its date but not what cadence produced it. The bills
 * that skip months are read straight off the templates instead, over the whole
 * window.
 *
 * They are deliberately not added into the balance: `moves` already contains
 * every one of these, once, from whichever of the two sources covers its date.
 * A lump is a label on money that is already accounted for.
 */
export interface Lump {
  readonly name: string;
  readonly date: PlainDate;
  /** A positive magnitude: what it costs. */
  readonly cents: Cents;
  readonly cadence: Cadence;
}

export interface YearAheadMonth {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** `Apr 2027`. */
  readonly label: string;
  /** The first of the month, which is also this month's key. */
  readonly start: PlainDate;
  readonly end: PlainDate;
  /** Everything arriving, as a positive magnitude. */
  readonly inCents: Cents;
  /** Everything leaving, as a positive magnitude. */
  readonly outCents: Cents;
  /** Where the account lands on the last day of this month. */
  readonly endBalanceCents: Cents;
  /** The irregular bills in this month, in date order. */
  readonly lumps: readonly Lump[];
  /** Those bills added up, as a positive magnitude. */
  readonly lumpTotalCents: Cents;
}

/* -------------------------------------------------------------------------- */
/* Month by month                                                             */
/* -------------------------------------------------------------------------- */

/** `2027-04-01` for April 2027: the first of the month, and its key. */
function firstOf(year: number, month: number): PlainDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function lastOf(year: number, month: number): PlainDate {
  const day = daysInMonth(year, month);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Every month in the window, with what moves through it and where it ends.
 *
 * The first month is the one containing `from`, and it is a PARTIAL month:
 * only the moves from `from` onwards are in it, because the part of this
 * month that has already happened is in the balance the projection starts
 * from. Every month after it is whole.
 *
 * That differs on purpose from `computeChequeCalendar`, which counts whole
 * months including the days before `from` - "does April hold three mortgage
 * payments" is a question about April, while "where does the balance end this
 * month" is a question about what is left of it. The two produce the same
 * list of months in the same order, so a caller can zip them by index.
 */
export function computeYearAhead(options: {
  readonly from: PlainDate;
  readonly monthCount: number;
  readonly startBalanceCents: Cents;
  /** Everything that moves the account, from the ledger and beyond it. */
  readonly moves: readonly ProjectedMove[];
  /** The bills that skip months, read off the templates. */
  readonly lumps?: readonly Lump[] | undefined;
}): YearAheadMonth[] {
  const { monthCount } = options;

  if (!Number.isInteger(monthCount) || monthCount < 1) {
    throw new RangeError(
      `monthCount must be a positive whole number; received ${String(monthCount)}.`,
    );
  }

  const first = parseDate(options.from);

  /* Bucketed by the first of their month, which is how the months are keyed. */
  const byMonth = new Map<string, ProjectedMove[]>();
  for (const move of options.moves) {
    const at = parseDate(move.date);
    const key = firstOf(at.year, at.month);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(move);
    else byMonth.set(key, [move]);
  }

  const lumpsByMonth = new Map<string, Lump[]>();
  for (const lump of options.lumps ?? []) {
    const at = parseDate(lump.date);
    const key = firstOf(at.year, at.month);
    const bucket = lumpsByMonth.get(key);
    if (bucket) bucket.push(lump);
    else lumpsByMonth.set(key, [lump]);
  }

  const months: YearAheadMonth[] = [];
  let cursor = { year: first.year, month: first.month };
  let running = options.startBalanceCents;

  for (let index = 0; index < monthCount; index += 1) {
    const { year, month } = cursor;
    const start = firstOf(year, month);
    const here = byMonth.get(start) ?? [];

    let arriving = 0n;
    let leaving = 0n;

    for (const move of here) {
      if (move.deltaCents > 0n) arriving += move.deltaCents;
      else leaving -= move.deltaCents;
    }

    const lumps = [...(lumpsByMonth.get(start) ?? [])];

    lumps.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

    let lumpTotal = 0n;
    for (const lump of lumps) lumpTotal += lump.cents;

    running += arriving - leaving;

    months.push({
      year,
      month,
      label: formatMonthAndYear(year, month),
      start,
      end: lastOf(year, month),
      inCents: arriving,
      outCents: leaving,
      endBalanceCents: running,
      lumps,
      lumpTotalCents: lumpTotal,
    });

    cursor = nextMonth(year, month);
  }

  return months;
}

/** The month the balance is lowest at the end of, or null for no months. */
export function lowestMonth(months: readonly YearAheadMonth[]): YearAheadMonth | null {
  let lowest: YearAheadMonth | null = null;
  for (const month of months) {
    if (lowest === null || month.endBalanceCents < lowest.endBalanceCents) lowest = month;
  }
  return lowest;
}

/* -------------------------------------------------------------------------- */
/* What to set aside                                                          */
/* -------------------------------------------------------------------------- */

export interface SetAside {
  /** How many months the figures are worked out over. */
  readonly monthCount: number;
  /** Every irregular bill in the window, added up. */
  readonly totalCents: Cents;
  /** How many of them there are. */
  readonly billCount: number;
  /** The obvious answer: the total spread evenly over the window. */
  readonly evenCents: Cents;
  /** The answer that actually works; see below. */
  readonly levelCents: Cents;
  /** The month that forces `levelCents` up, or null when the two agree. */
  readonly bindingStart: PlainDate | null;
  readonly bindingLabel: string | null;
}

/** Ceiling division for two positive magnitudes. */
function divideUp(amount: Cents, by: bigint): Cents {
  if (by <= 0n) throw new RangeError("Divide by a positive number of months.");
  if (amount <= 0n) return 0n;
  return (amount + by - 1n) / by;
}

/**
 * What to put aside each month so the irregular bills are already paid for.
 *
 * Two figures, and the gap between them is the whole reason this is worth
 * computing rather than dividing in your head:
 *
 *  - **`evenCents`** is the total divided by the number of months. It is what
 *    anybody would work out, and it is right only if the bills happen to be
 *    spread evenly through the year.
 *  - **`levelCents`** is the smallest amount that is never short. If the
 *    house insurance lands in month two, a twelfth of the year's total will
 *    not be there in time however correct the arithmetic is. This is the
 *    smallest monthly amount for which the pot is big enough on every date a
 *    bill actually falls: `max` over each month of what has come due by then
 *    divided by the months saved so far.
 *
 * `bindingStart` is the month that forces that maximum - the one to blame -
 * and is null when the bills are spread evenly enough that the two figures
 * agree.
 *
 * The first month counts as one month of saving, which assumes a deposit is
 * made now rather than at the end of it. The alternative - counting it as
 * zero - makes the figure infinite whenever a bill falls in the next three
 * weeks, which is a true statement and a useless one.
 */
export function setAsideFor(months: readonly YearAheadMonth[]): SetAside {
  let total = 0n;
  let billCount = 0;
  for (const month of months) {
    total += month.lumpTotalCents;
    billCount += month.lumps.length;
  }

  const monthCount = months.length;
  if (monthCount === 0 || total === 0n) {
    return {
      monthCount,
      totalCents: 0n,
      billCount: 0,
      evenCents: 0n,
      levelCents: 0n,
      bindingStart: null,
      bindingLabel: null,
    };
  }

  const even = divideUp(total, BigInt(monthCount));

  let dueSoFar = 0n;
  let level = 0n;
  let binding: YearAheadMonth | null = null;

  for (const [index, month] of months.entries()) {
    dueSoFar += month.lumpTotalCents;
    if (dueSoFar === 0n) continue;

    const needed = divideUp(dueSoFar, BigInt(index + 1));
    if (needed > level) {
      level = needed;
      binding = month;
    }
  }

  return {
    monthCount,
    totalCents: total,
    billCount,
    evenCents: even,
    levelCents: level,
    // Only worth naming when it is telling the household something the even
    // figure does not already say.
    bindingStart: level > even && binding ? binding.start : null,
    bindingLabel: level > even && binding ? binding.label : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Which windfall pays for which squeeze                                      */
/* -------------------------------------------------------------------------- */

/** A month from the cheque calendar, reduced to what pairing needs. */
export interface UnusualMonth {
  /** The first of the month; the same key `computeYearAhead` uses. */
  readonly start: PlainDate;
  readonly label: string;
  /** Positive is a third paycheque, negative is a third payment going out. */
  readonly netExtraCents: Cents;
}

export interface Pairing {
  readonly windfallStart: PlainDate;
  readonly windfallLabel: string;
  readonly squeezeStart: PlainDate;
  readonly squeezeLabel: string;
  /** How much of the squeeze this windfall pays for. Positive. */
  readonly coveredCents: Cents;
  /**
   * The squeeze lands before the money meant to cover it.
   *
   * The one that actually hurts, and the one a list of good months and bad
   * months side by side will never show you: the arithmetic over the year
   * works out, and you are still short in March.
   */
  readonly squeezeFirst: boolean;
}

export interface UnusualPairs {
  readonly pairs: readonly Pairing[];
  /** Squeeze with no windfall anywhere in the window to answer it. */
  readonly uncoveredCents: Cents;
  /** Windfall left once every squeeze is paid for: what can go to savings. */
  readonly spareCents: Cents;
}

/**
 * Match each extra payment to the extra cheque that pays for it.
 *
 * Earliest windfall first, which is both the obvious reading and the useful
 * one: money already in the account is what covers the next bill. A single
 * windfall can be split across several squeezes and a single squeeze can draw
 * on several windfalls, so this emits one pairing per draw rather than one
 * per month.
 *
 * Months that are unusual but net to nothing - an extra cheque and an extra
 * payment of the same size - are neither, and are left out: there is nothing
 * to pair and the cheque calendar already shows them.
 */
export function pairUnusualMonths(months: readonly UnusualMonth[]): UnusualPairs {
  const ordered = [...months].sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );

  const windfalls = ordered
    .filter((month) => month.netExtraCents > 0n)
    .map((month) => ({ month, left: month.netExtraCents }));
  const squeezes = ordered
    .filter((month) => month.netExtraCents < 0n)
    .map((month) => ({ month, left: -month.netExtraCents }));

  const pairs: Pairing[] = [];
  let next = 0;

  for (const squeeze of squeezes) {
    while (squeeze.left > 0n && next < windfalls.length) {
      const windfall = windfalls[next];
      if (windfall === undefined) break;
      if (windfall.left === 0n) {
        next += 1;
        continue;
      }

      const used = windfall.left < squeeze.left ? windfall.left : squeeze.left;
      pairs.push({
        windfallStart: windfall.month.start,
        windfallLabel: windfall.month.label,
        squeezeStart: squeeze.month.start,
        squeezeLabel: squeeze.month.label,
        coveredCents: used,
        squeezeFirst: squeeze.month.start < windfall.month.start,
      });

      windfall.left -= used;
      squeeze.left -= used;
      if (windfall.left === 0n) next += 1;
    }
  }

  let uncovered = 0n;
  for (const squeeze of squeezes) uncovered += squeeze.left;

  let spare = 0n;
  for (const windfall of windfalls) spare += windfall.left;

  return { pairs, uncoveredCents: uncovered, spareCents: spare };
}
