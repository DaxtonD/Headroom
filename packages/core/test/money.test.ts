/**
 * Unit tests for the money primitives.
 *
 * Every value here is invented. Real household amounts never appear in
 * committed source; the golden tests assert against figures loaded from a
 * fixture file at run time instead.
 */
import { describe, expect, it } from "vitest";
import {
  MINUS_SIGN,
  absCents,
  applyPercent,
  cents,
  centsFromJson,
  centsToJson,
  compoundByPercent,
  divRoundHalfUp,
  formatCents,
  formatCentsPlain,
  growByPercent,
  maxCents,
  minCents,
  mulDivRoundHalfUp,
  parseCents,
  percentShare,
  percentShareOneDecimal,
  sumCents,
} from "../src/money.js";

describe("cents()", () => {
  it("accepts whole numbers and bigints", () => {
    expect(cents(0)).toBe(0n);
    expect(cents(123456)).toBe(123456n);
    expect(cents(-4500)).toBe(-4500n);
    expect(cents(123456n)).toBe(123456n);
  });

  it("refuses a float, so money can never be fractional", () => {
    expect(() => cents(1.5)).toThrow(RangeError);
    expect(() => cents(0.1 + 0.2)).toThrow(RangeError);
  });

  it("refuses values beyond the safe integer range", () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe("parseCents()", () => {
  it("reads plain and decorated input", () => {
    expect(parseCents("1234.56")).toBe(123456n);
    expect(parseCents("$1,234.56")).toBe(123456n);
    expect(parseCents("0")).toBe(0n);
    expect(parseCents("12")).toBe(1200n);
    expect(parseCents("12.3")).toBe(1230n);
    expect(parseCents(".75")).toBe(75n);
  });

  it("ignores the spaces a phone keyboard adds", () => {
    expect(parseCents(" 1 234.56 ")).toBe(123456n);
    expect(parseCents("1 234.56")).toBe(123456n);
  });

  it("reads every negative form the UI can produce", () => {
    expect(parseCents("-12.00")).toBe(-1200n);
    expect(parseCents(`${MINUS_SIGN}12.00`)).toBe(-1200n);
    expect(parseCents("(12.00)")).toBe(-1200n);
    expect(parseCents("-$12.00")).toBe(-1200n);
    expect(parseCents("12.00-")).toBe(-1200n);
  });

  it("rejects anything that is not an exact amount", () => {
    expect(() => parseCents("")).toThrow();
    expect(() => parseCents("   ")).toThrow();
    expect(() => parseCents("abc")).toThrow();
    expect(() => parseCents("1.234")).toThrow();
    expect(() => parseCents("1e3")).toThrow();
    expect(() => parseCents("--1")).toThrow();
    expect(() => parseCents("1.2.3")).toThrow();
  });

  it("round-trips through formatting", () => {
    for (const value of [0n, 1n, 99n, 100n, 123456n, -4500n, -100000n]) {
      expect(parseCents(formatCents(value))).toBe(value);
    }
  });
});

describe("arithmetic", () => {
  it("sums, with zero for nothing", () => {
    expect(sumCents([])).toBe(0n);
    expect(sumCents([100000n, -25000n, -1500n])).toBe(73500n);
  });

  it("gives absolute value, min and max", () => {
    expect(absCents(-4500n)).toBe(4500n);
    expect(absCents(4500n)).toBe(4500n);
    expect(minCents(1000n, 250000n)).toBe(1000n);
    expect(maxCents(1000n, 250000n)).toBe(250000n);
  });
});

describe("divRoundHalfUp()", () => {
  it("rounds halves away from zero, matching Python's ROUND_HALF_UP", () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(6n, 10n)).toBe(1n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
    expect(divRoundHalfUp(25n, 10n)).toBe(3n);
  });

  it("rounds negative halves away from zero too", () => {
    expect(divRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divRoundHalfUp(-4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(-15n, 10n)).toBe(-2n);
    expect(divRoundHalfUp(5n, -10n)).toBe(-1n);
  });

  it("divides exactly when it can", () => {
    expect(divRoundHalfUp(100n, 4n)).toBe(25n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
  });

  it("refuses division by zero", () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });

  it("stays exact far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 9007199254740993n * 1000n;
    expect(divRoundHalfUp(huge * 3n, 3n)).toBe(huge);
  });
});

describe("percentages", () => {
  it("multiplies before dividing, so nothing is lost on the way", () => {
    expect(mulDivRoundHalfUp(100n, 1n, 3n)).toBe(33n);
    expect(mulDivRoundHalfUp(200n, 1n, 3n)).toBe(67n);
  });

  it("applies a flat percent", () => {
    expect(applyPercent(1000n, 10n)).toBe(100n);
    expect(applyPercent(1005n, 10n)).toBe(101n);
  });

  it("grows once rather than compounding", () => {
    expect(growByPercent(1000n, 10n)).toBe(1100n);
    expect(growByPercent(0n, 10n)).toBe(0n);
    // Odd cents round half up on the way out.
    expect(growByPercent(1005n, 10n)).toBe(1106n);
  });

  it("compounds yearly when that option is turned on", () => {
    expect(compoundByPercent(1000n, 10n, 0)).toBe(1000n);
    expect(compoundByPercent(1000n, 10n, 1)).toBe(1100n);
    expect(compoundByPercent(1000n, 10n, 2)).toBe(1210n);
    expect(() => compoundByPercent(1000n, 10n, -1)).toThrow(RangeError);
    expect(() => compoundByPercent(1000n, 10n, 1.5)).toThrow(RangeError);
  });

  it("gives each line's share of its own section", () => {
    expect(percentShare(250n, 1000n)).toBe(25);
    expect(percentShare(1n, 3n)).toBe(33);
    expect(percentShare(2n, 3n)).toBe(67);
    expect(percentShare(1000n, 1000n)).toBe(100);
  });

  it("treats a zero total as zero share rather than dividing by zero", () => {
    expect(percentShare(100n, 0n)).toBe(0);
    expect(percentShareOneDecimal(100n, 0n)).toBe(0);
  });

  it("gives one-decimal progress for goals", () => {
    expect(percentShareOneDecimal(500n, 600n)).toBe(83.3);
    expect(percentShareOneDecimal(600n, 600n)).toBe(100);
    expect(percentShareOneDecimal(1n, 3n)).toBe(33.3);
  });
});

describe("formatCents()", () => {
  it("formats en-CA CAD", () => {
    expect(formatCents(123456n)).toBe("$1,234.56");
    expect(formatCents(4500n)).toBe("$45.00");
    expect(formatCents(0n)).toBe("$0.00");
    expect(formatCents(5n)).toBe("$0.05");
    expect(formatCents(50n)).toBe("$0.50");
    expect(formatCents(100n)).toBe("$1.00");
  });

  it("uses U+2212 for negatives, never the ASCII hyphen", () => {
    expect(formatCents(-4500n)).toBe(`${MINUS_SIGN}$45.00`);
    expect(formatCents(-4500n)).not.toContain("-");
  });

  it("groups thousands and millions", () => {
    expect(formatCents(100000000n)).toBe("$1,000,000.00");
    expect(formatCents(123456789n)).toBe("$1,234,567.89");
  });

  it("honours its options", () => {
    expect(formatCents(123456n, { currencySymbol: false })).toBe("1,234.56");
    expect(formatCents(123456n, { grouping: false })).toBe("$1234.56");
    expect(formatCents(123456n, { alwaysSign: true })).toBe("+$1,234.56");
    expect(formatCents(-123456n, { alwaysSign: true })).toBe(`${MINUS_SIGN}$1,234.56`);
  });

  it("formats plainly for assistive tech and exports", () => {
    expect(formatCentsPlain(123456n)).toBe("1234.56");
    expect(formatCentsPlain(-4500n)).toBe("-45.00");
  });

  it("stays exact for amounts no float could hold", () => {
    expect(formatCents(9007199254740993n)).toBe("$90,071,992,547,409.93");
  });
});

describe("transport", () => {
  it("carries cents as strings, because JSON has no bigint", () => {
    expect(centsToJson(123456n)).toBe("123456");
    expect(centsToJson(-4500n)).toBe("-4500");
    expect(centsFromJson("123456")).toBe(123456n);
    expect(centsFromJson("-4500")).toBe(-4500n);
    expect(centsFromJson(123456)).toBe(123456n);
    expect(centsFromJson(123456n)).toBe(123456n);
  });

  it("rejects a decimal string on the wire", () => {
    expect(() => centsFromJson("1234.56")).toThrow(SyntaxError);
    expect(() => centsFromJson("abc")).toThrow(SyntaxError);
  });

  it("round-trips a value beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 9007199254740993n;
    expect(centsFromJson(centsToJson(big))).toBe(big);
  });
});
